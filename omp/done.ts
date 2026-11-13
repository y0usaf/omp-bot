import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE } from "./paths.ts";

const DIR = join(STATE, "bots", process.env.OMP_BOT_NAME ?? "-", "checks");
const ROUNDS = Number(process.env.OMP_BOT_CHECK_ROUNDS) || 3;
const TIMEOUT = 600000;
const POLL_MS = 2000;
const TAIL = 1200;
const EXPIRES = 12 * 60 * 60 * 1000;

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

export default function (pi) {
	const name = process.env.OMP_BOT_NAME;
	if (!name) return;
	pi.setLabel("Bot done-checks");
	let mine;
	const watched = new Map();
	let timer;
	let where;

	const take = id => {
		const file = join(DIR, `${id}.json`);
		const spec = readJson(file);
		if (spec) rmSync(file, { force: true });
		return spec;
	};

	const lastWords = id => {
		try {
			const file = where?.sessionManager?.getSessionFile?.();
			if (!file) return "";
			let text = "";
			for (const line of readFileSync(file.replace(/\.jsonl$/, `/${id}.jsonl`), "utf8").split("\n")) {
				if (!line.includes('"assistant"')) continue;
				const message = JSON.parse(line)?.message;
				if (message?.role !== "assistant") continue;
				const said = (message.content ?? [])
					.filter(part => part?.type === "text")
					.map(part => part.text)
					.join("")
					.trim();
				if (said) text = said;
			}
			return text.length > TAIL ? `${text.slice(0, TAIL)}…` : text;
		} catch {
			return "";
		}
	};

	const settle = (id, text) => {
		const report = lastWords(id);
		pi.sendMessage(
			{ customType: "done-check", content: report ? `${text}\n\nHelper's last word: ${report}` : text, display: true, attribution: "agent" },
			{ deliverAs: "followUp" },
		);
		watched.delete(id);
		rmSync(join(DIR, `${id}.json`), { force: true });
		rmSync(join(DIR, `${id}.status`), { force: true });
	};

	const sweep = () => {
		for (const [id, entry] of watched) {
			const seen = readJson(join(DIR, `${id}.status`));
			if (seen?.state === "passed") {
				settle(id, `Done-check on ${id} passed${seen.rounds ? ` after ${seen.rounds} failed ${seen.rounds === 1 ? "try" : "tries"}` : ""}: \`${entry.command}\``);
				continue;
			}
			if (seen?.state === "failed") {
				settle(
					id,
					`Done-check on ${id} failed every try (${seen.rounds}) and the helper stopped: \`${entry.command}\` exited ${seen.code}. ${seen.output || "(no output)"}`,
				);
				continue;
			}
			if (Date.now() - entry.since > EXPIRES) watched.delete(id);
		}
		if (watched.size === 0 && timer !== undefined) {
			where?.clearTimer?.(timer);
			timer = undefined;
		}
	};

	const watch = (ctx, id, command) => {
		if (!id) return;
		watched.set(id, { command, since: Date.now() });
		where = ctx;
		if (timer === undefined) {
			timer = ctx.setInterval(sweep, POLL_MS);
			timer?.unref?.();
		}
	};

	pi.on("agent_end", async (event, ctx) => {
		if (ctx.agent?.kind !== "sub" || event.willContinue || ctx.hasPendingMessages()) return;
		if (!mine) mine = take(ctx.agent.id);
		if (!mine) return;
		const reason = event.messages?.findLast(message => message.role === "assistant")?.stopReason;
		if (reason === "aborted" || reason === "error" || reason === "length") return;
		const id = ctx.agent.id;
		const file = join(DIR, `${id}.status`);
		const before = readJson(file) ?? { rounds: 0 };
		if (before.state === "passed" || (before.rounds ?? 0) > mine.rounds) return;
		const result = await pi.exec("sh", ["-c", mine.command], { cwd: mine.cwd, timeout: TIMEOUT });
		const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
		const tail = output.length > TAIL ? `…${output.slice(-TAIL)}` : output;
		if (result.code === 0) {
			writeFileSync(file, JSON.stringify({ state: "passed", rounds: before.rounds ?? 0 }));
			return;
		}
		const rounds = (before.rounds ?? 0) + 1;
		writeFileSync(file, JSON.stringify({ state: rounds > mine.rounds ? "failed" : "running", rounds, code: result.code, output: tail }));
		if (rounds > mine.rounds) return;
		pi.sendMessage(
			{
				customType: "done-check",
				content: `Not done: the done-check exited ${result.code} (round ${rounds} of ${mine.rounds}).\n${tail || "(no output)"}\n\nKeep working until it passes.`,
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") {
			mine = take(ctx.agent.id);
			return;
		}
		let native;
		try {
			native = pi.getAllTools().find(tool => tool.name === "task" && tool.sourceInfo?.source === "builtin");
		} catch {}
		const schema = native?.parameters?.toJsonSchema?.({ target: "draft-2020-12" });
		const item = schema?.properties?.tasks?.items?.properties;
		if (!item) return;
		item.check = {
			type: "string",
			description:
				"A shell command the helper never sees. When the helper stops it runs in this folder; while it exits non-zero the helper is told the output and carries on, up to the round limit. Leave it out when the work has no check.",
		};
		pi.registerTool({
			name: "task",
			label: "Task",
			description: `${native.description ?? "Spawn subagents."}\n\n## Done-checks\nAn item may carry \`check\`: a shell command the helper never sees. When the helper stops the command runs where you started it; while it fails the helper is told the output and keeps working, for up to ${ROUNDS} rounds. You get the result either way, with the check's outcome.`,
			parameters: schema,
			loadMode: "essential",
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const tasks = Array.isArray(params?.tasks) ? params.tasks : undefined;
				if (!tasks) return await ctx.invokeTool(params, { signal, onUpdate });
				const checks = [];
				const clean = tasks.map((task, index) => {
					const { check: command, ...rest } = task ?? {};
					if (typeof command !== "string" || command.trim().length === 0) return rest;
					const id = String(rest.name ?? "").trim() || `Checked${randomBytes(4).toString("hex")}${index}`;
					checks[index] = { id, command: command.trim() };
					mkdirSync(DIR, { recursive: true });
					writeFileSync(
						join(DIR, `${id}.json`),
						JSON.stringify({ command: command.trim(), cwd: ctx.cwd, rounds: ROUNDS }),
					);
					return { ...rest, name: id };
				});
				const result = await ctx.invokeTool({ ...params, tasks: clean }, { signal, onUpdate });
				const spawns = result?.details?.progress ?? result?.details?.results ?? [];
				for (const spawn of spawns) {
					const want = checks[spawn?.index];
					if (!want) continue;
					const kept = join(DIR, `${want.id}.json`);
					if (spawn.id && spawn.id !== want.id && existsSync(kept)) {
						writeFileSync(join(DIR, `${spawn.id}.json`), JSON.stringify(readJson(kept)));
						rmSync(kept, { force: true });
						want.id = spawn.id;
					}
					watch(ctx, want.id, want.command);
				}
				sweep();
				return result;
			},
		});
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent?.kind === "sub" || !Array.isArray(event.systemPrompt) || event.systemPrompt.length === 0) return;
		const rule = `\n\n# Done-checks\nA helper you start with the task tool may carry a \`check\` in its item: a shell command the helper never sees. When the helper stops the command runs in your folder, and while it exits non-zero the helper is told the output and carries on, up to ${ROUNDS} rounds. Put one on any helper whose work can be tested (\`"check": "nix flake check"\`), and report the outcome with the helper's result.`;
		const systemPrompt = [...event.systemPrompt];
		systemPrompt[systemPrompt.length - 1] = `${systemPrompt[systemPrompt.length - 1]}${rule}`;
		return { systemPrompt };
	});
}
