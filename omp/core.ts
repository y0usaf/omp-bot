import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE } from "./paths";
import { identity } from "./prompt";

export default function core(pi) {
	const name = process.env.OMP_BOT_NAME;
	if (!name) return;
	const persona = process.env.OMP_BOT_PERSONA || "";
	const restart = join(STATE, "bots", name, "restart");
	let ctx;

	pi.setLabel("Bot core");

	const runs = join(STATE, "runs");
	const read = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").trim() : "");
	function reportRuns() {
		if (!existsSync(runs)) return;
		for (const run of readdirSync(runs)) {
			const dir = join(runs, run);
			if (read(join(dir, "owner")) !== name || existsSync(join(dir, "reported"))) continue;
			const code = read(join(dir, "exit"));
			let alive = false;
			if (!code) {
				try {
					process.kill(Number(read(join(dir, "pid"))), 0);
					alive = true;
				} catch {}
			}
			if (alive) continue;
			const output = read(join(dir, "output")).slice(-1500);
			writeFileSync(join(dir, "reported"), "");
			pi.sendMessage({ customType: "omp-job", display: true, content: `Job ${run} ${code ? `exited ${code}` : "died without an exit code"}. Its files: ${dir}\n\n${output}` });
		}
	}

	pi.on("session_start", async (_event, c) => {
		if (c.agent?.kind === "sub") return;
		ctx = c;
		reportRuns();
		let tick = 0;
		c.setInterval(() => {
			if (++tick % 10 === 0) reportRuns();
			if (!existsSync(restart) || !ctx?.isIdle()) return;
			rmSync(restart, { force: true });
			if (process.env.OMP_BOT_RELAUNCH) writeFileSync(process.env.OMP_BOT_RELAUNCH, "");
			ctx.shutdown();
		}, 1000);
	});

	pi.on("before_agent_start", async (event, c) => {
		if (c.agent?.kind === "sub" || !Array.isArray(event.systemPrompt) || event.systemPrompt.length === 0) return undefined;
		const text = identity({ name, persona, memory: process.env.OMP_BOT_MEMORY === "optchat" });
		const systemPrompt = [...event.systemPrompt];
		systemPrompt[systemPrompt.length - 1] = `${systemPrompt[systemPrompt.length - 1]}${text}`;
		return { systemPrompt };
	});
}
