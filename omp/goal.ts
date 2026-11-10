import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE } from "./paths";

const CHECK_MS = 10 * 60 * 1000;
const TAIL = 3000;

function text(message: string) {
	return { content: [{ type: "text", text: message }], details: {} };
}

async function run(check: string, cwd: string) {
	const proc = Bun.spawn(["bash", "-c", check], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
	const timer = setTimeout(() => proc.kill(), CHECK_MS);
	const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	clearTimeout(timer);
	const both = `${out}${err}`.trim();
	return { code, output: both.length > TAIL ? `…${both.slice(-TAIL)}` : both };
}

export default function goal(pi) {
	const name = process.env.OMP_BOT_NAME;
	if (!name) return;
	const file = join(STATE, "bots", name, "goal.json");
	const z = pi.zod;
	const save = g => writeFileSync(file, `${JSON.stringify(g, null, "\t")}\n`);
	const tell = (content: string, turn: boolean) =>
		pi.sendMessage({ customType: "goal", content, display: true }, turn ? { deliverAs: "followUp", triggerTurn: true } : undefined);
	let checking = false;

	pi.registerTool({
		name: "goal",
		label: "Goal",
		description:
			"Sets the one goal you keep working on until its check passes. action set takes objective (the outcome the user asked for) and check (a bash command that exits 0 only when that outcome is really true, run from cwd); after each of your turns the check runs, and while it fails you are sent its output and continue, up to max_turns (default 8). Run the check once yourself before setting it and confirm it fails now for the right reason. action clear drops the goal when the user drops the work. You cannot mark a goal done: only the check passing does.",
		parameters: z.object({
			action: z.enum(["set", "clear"]),
			objective: z.string().optional(),
			check: z.string().optional(),
			cwd: z.string().optional(),
			max_turns: z.number().int().min(1).max(30).optional(),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			if (params.action === "clear") {
				rmSync(file, { force: true });
				return text("Goal cleared.");
			}
			if (!params.objective?.trim() || !params.check?.trim()) return text("set needs objective and check.");
			const cwd = params.cwd || ctx?.cwd || process.cwd();
			save({ objective: params.objective.trim(), check: params.check.trim(), cwd, max: params.max_turns ?? 8, turns: 0, set: new Date().toISOString() });
			return text(`Goal set. After each turn \`${params.check.trim()}\` runs in ${cwd}; it ends when that exits 0 or after ${params.max_turns ?? 8} turns.`);
		},
	});

	pi.on("agent_end", async () => {
		const g = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
		if (!g || checking) return;
		checking = true;
		try {
			const { code, output } = await run(g.check, g.cwd);
			if (code === 0) {
				rmSync(file, { force: true });
				tell(`Goal met: \`${g.check}\` exited 0.\n\nObjective: ${g.objective}\n\n${output}`, false);
				return;
			}
			g.turns += 1;
			if (g.turns >= g.max) {
				rmSync(file, { force: true });
				tell(`Goal stopped after ${g.turns} turns; \`${g.check}\` still exits ${code}.\n\nObjective: ${g.objective}\n\n${output}`, false);
				return;
			}
			save(g);
			tell(`Goal not met yet (turn ${g.turns} of ${g.max}). \`${g.check}\` exited ${code}:\n\n${output}\n\nObjective: ${g.objective}\nKeep working toward it; if only the user can unblock it, say exactly what you need and call goal with action clear.`, true);
		} finally {
			checking = false;
		}
	});
}
