import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { escapeHarnessTags } from "@oh-my-pi/pi-coding-agent/session/harness-tags";
import { dir, type Job, load, request, safeEnv } from "../daemon/ompd";
import { ROOT, STATE } from "../daemon/paths";
import { final, loadTask, type Task } from "../daemon/tasks";

const BOT = process.env.OMP_BOT_NAME ?? "";
const SELF = process.env.OMP_BOT_HELPER ?? "";
const MAIN = "Main";
const HELPERS = join(STATE, "bots", BOT, "helpers");
const MAIL = join(HELPERS, "mail");
const FOREGROUND_S = Number(process.env.OMPD_FOREGROUND_S) || 300;
const REPORT_BYTES = 64 * 1024;
const DEPTH = Number(process.env.OMP_BOT_HELPER_DEPTH) || (SELF ? 1 : 0);
const MAX_DEPTH = 2;
const MAX_HELPERS = Number(process.env.OMP_BOT_MAX_HELPERS) || 8;
const MINUTES = Number(process.env.OMP_BOT_HELPER_MINUTES) || 60;
const INHERITED = /^(?:\*|(?:@|pi\/)?default|(?:@|pi\/)task)$/;
const PATCHED = Symbol.for("omp-bot.helpers.send");
const WAKE = /^\[wake\][^\S\n]*(?:\n\s*)?/;
const DELIVERED = { state: "done" } as Job;
const awaited: Set<string> = ((globalThis as any)[Symbol.for("ompd.awaited")] ??= new Set());

type Helper = { id: string; parent: string; agent: string; description: string; job: string; task: string; tool: string; started: number; cwd: string };
type Item = { task: string; check?: string; for?: string; title?: string; minutes?: number; solutionSpace?: string; name?: string; agent?: string; tools?: string[]; model?: string | string[] };

const owner = () => process.env.OMPD_OWNER || `bot:${BOT}`;
const self = () => SELF || MAIN;
const OMPD = join(ROOT, "bin", "ompd");
const quote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

async function call(message: Record<string, unknown>): Promise<any> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await request(message);
		} catch (error) {
			if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "") || attempt >= 240) throw error;
			await Bun.sleep(250);
		}
	}
}

function real(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

function writeAtomic(path: string, text: string) {
	writeFileSync(`${path}.tmp`, text, { mode: 0o600 });
	renameSync(`${path}.tmp`, path);
}

function record(id: string): Helper | undefined {
	try {
		return JSON.parse(readFileSync(join(HELPERS, id, "helper.json"), "utf8"));
	} catch {
		return undefined;
	}
}

function records(): Helper[] {
	try {
		return readdirSync(HELPERS).flatMap(id => record(id) ?? []);
	} catch {
		return [];
	}
}

function running(helper: Helper | undefined): boolean {
	const job = helper && load(helper.job);
	return job?.state === "queued" || job?.state === "running";
}

function ended(job: Job): Job | undefined {
	if (job.state === "done" || job.state === "lost") return job;
	try {
		const text = readFileSync(join(dir(job.id), "exit"), "utf8").trim();
		return text === "" ? undefined : { ...job, state: "done", code: Number(text), ended: Date.now() };
	} catch {
		return undefined;
	}
}

function outcome(job: Job): string {
	if (job.state === "lost") return `outcome unknown: ${job.reason}`;
	return job.reason ?? (job.code === 0 ? "done" : `exit ${job.code}`);
}

function result(job: Job): string {
	try {
		const text = readFileSync(join(dir(job.id), "report"), "utf8");
		return text.length > REPORT_BYTES ? `${text.slice(0, REPORT_BYTES)}\n[cut at ${REPORT_BYTES} bytes; the whole result is in ${join(dir(job.id), "report")}]` : text;
	} catch {}
	try {
		const log = readFileSync(join(dir(job.id), "log"), "utf8").trimEnd().split("\n").slice(-50).join("\n");
		return `(it wrote no result; its log ends:)\n${log || "(empty)"}`;
	} catch {
		return "(it wrote no result and no log)";
	}
}

function rowVerdict(task: Task): string {
	if (task.dropped !== null) return `task dropped: ${task.dropped}`;
	const check = task.checked;
	if (check?.code === 0) return "check passed; the task is done";
	if (check) return `check failed (${check.code === null ? check.reason ?? "no exit code" : `exit ${check.code}`}); the task stays ${task.state}`;
	return `task ${task.state}`;
}

function checkResult(task: Task): string {
	const check = task.checked;
	if (!check) return "";
	const head = check.job ? `[check exited ${check.code ?? "-"}: ompd job ${check.job}, log ${join(dir(check.job), "log")}]` : `[its check did not run: ${check.reason ?? "unknown"}]`;
	let lines = "";
	try {
		if (check.job) lines = readFileSync(join(dir(check.job), "log"), "utf8").trimEnd().split("\n").slice(-20).join("\n");
	} catch {}
	return lines ? `${head}\n${lines}` : head;
}

function baseArgs(): string[] {
	const argv = readFileSync("/proc/self/cmdline", "utf8").split("\0").filter(Boolean);
	const own = new Set(["core.ts", "omp-bot.ts"].map(file => real(join(ROOT, "omp", file))));
	if (process.env.OMP_BOT_OPTCHAT) own.add(real(join(process.env.OMP_BOT_OPTCHAT, "extension.ts")));
	const memory = real(join(ROOT, "omp", "memory.yml"));
	const out = [argv[0]];
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		if (["--restore", "--session-dir", "--session", "--resume", "--mode", "--fork", "--prewalk-into"].includes(arg)) i++;
		else if (["--continue", "-c", "--no-ui", "--print", "-p", "--prewalk", "--no-prewalk"].includes(arg) || arg.startsWith("--prewalk-into=")) continue;
		else if ((arg === "-e" || arg === "--extension") && next !== undefined && own.has(real(next))) i++;
		else if (arg === "--config" && next !== undefined && real(next) === memory) i++;
		else out.push(arg);
	}
	return out;
}

function withFlag(args: string[], flag: string, value: string): string[] {
	const out = [...args];
	const at = out.indexOf(flag);
	if (at > 0) out.splice(at, 2);
	return [...out, flag, value];
}

function freeId(name: string | undefined, taken: Set<string>): string {
	const base = (name ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "Helper";
	const clash = (id: string) => taken.has(id) || id === MAIN || id === BOT || existsSync(join(HELPERS, id));
	if (!clash(base) && name) return base;
	for (let n = 2; ; n++) if (!clash(`${base}-${n}`)) return `${base}-${n}`;
}

function goal(task: string): string {
	const line = task.trim().split("\n").find(text => text.trim()) ?? "";
	return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function systemPrompt(helper: Helper, role: string, context: string): string {
	const parent = helper.parent === MAIN ? BOT : helper.parent;
	const peers = records().filter(other => other.id !== helper.id && running(other)).map(other => `- \`${other.id}\` — ${other.description}`);
	const rulesPath = join(STATE, "bots", BOT, "rules.md");
	const rules = BOT === "Lloyd" && existsSync(rulesPath) ? readFileSync(rulesPath, "utf8").trim() : "";
	return `§ Role
${role.trim()}
${context.trim() ? `\n§ Context\n${context.trim()}\n` : ""}
${BOT === "Lloyd" ? `
§ Inherited rules
The user's standing rules from ${rulesPath} apply to this assignment:
${rules || "No standing rules file is present."}

§ Shipping and decisions
Unless this assignment explicitly limits shipping, finish authorized changes end to end: verify the real behavior, commit the owning repo, pin it in ~/finix and commit that, then run \`finix-switch\`. It builds finix's committed HEAD, switches this machine under the lock other shippers share (building again if HEAD moved meanwhile), skips a switch that is already active, and prints one JSON line with the system now running; a nonzero exit means it did not switch. Restart affected services and bots so the change is active; restart Lloyd last with \`omp-bot-ctl restart Lloyd\` when required. Do not push without the user's authorization.
Decide routine, reversible details within the assignment yourself. Fix bugs in the owning component, with no compatibility shims. Themes override Tern's stock selectors and variables rather than adding machinery, except where stock Tern has no surface. A user decision is required for visible-to-others, irreversible, costly, or push actions not already authorized.
Default helper models to the configured Codex task role. Request Opus only for Lean proofs or compiler work; do not use Opus as a general helper default.
` : ""}
§ Coop
You are helper \`${helper.id}\` of the bot ${BOT}, started by \`${parent}\` with the task tool to do one piece of its work. You run as an omp session of your own, an ompd job outside \`${parent}\`'s session: it restarting doesn't stop you, and your result reaches it even then.
# Peers
Message peers via \`write\` with \`path: "agent://<id>"\` and \`content\`. Your id is \`${helper.id}\`; \`${parent}\` is \`agent://${parent}\`${peers.length ? `, and the other helpers now running are:\n${peers.join("\n")}` : "."}
Use peer messages only for quick coordination, never long-form content. Before editing a file a sibling may own, message that peer. \`write agent://<id>\` never blocks.
Your final result reaches \`${parent}\` automatically. Message \`${parent}\` ${BOT === "Lloyd" ? "only when blocked, reporting failure, needing a user decision (visible-to-others, irreversible, costly, or push), or delivering a requested final result — never progress, routine questions, or acknowledgements." : "only for questions, blockers, or decisions — never progress or completion reports."}${helper.parent === MAIN ? `
Messages you send to \`agent://${parent}\` are held quietly for its next turn by default. To wake it now, put \`[wake]\` on the first line of the message's \`content\`: use this only when blocked, needing the user, reporting a failure, or delivering the final result it is waiting on. Routine acknowledgements and coordination stay held.
Your final result also waits quietly for \`${parent}\`'s next turn. Put \`[wake]\` on its first line only for the same urgent cases; a failed run or the final job of a parked task wakes it automatically.` : ""}

§ Completion
No progress updates. Execute; your final message is your result.

While work remains, you MUST continue with another tool call — investigate, edit. A reply without a tool call ends the run; its text reaches \`${parent}\` verbatim as your complete result. NEVER end on a plan, a promise of further work, or a question.

Giving up is a last resort. If truly blocked, your final message MUST describe what you tried and the exact blocker.
You NEVER give up due to uncertainty, missing information obtainable via tools or repo context, or needing a design decision you can derive yourself.
`;
}

export default function helpers(pi) {
	if (!BOT) return;
	(globalThis as any)[Symbol.for("omp-bot.helpers")] = true;
	const z = pi.zod;
	let main;
	let agents: Promise<any[]> | undefined;
	pi.setLabel("Bot helpers");

	async function definitions(cwd: string): Promise<any[]> {
		agents ??= import("@oh-my-pi/pi-coding-agent/task/discovery").then(({ discoverAgents }) => discoverAgents(cwd)).then(found => found.agents);
		return agents;
	}

	async function start(item: Item, context: string, cwd: string, tool: string, task: string, taken: Set<string>): Promise<Helper> {
		const again = records().find(helper => helper.tool === tool);
		if (again) return again;
		const agent = (await definitions(cwd)).find(found => found.name === (item.agent || "task"));
		const id = freeId(item.name, taken);
		taken.add(id);
		const home = join(HELPERS, id);
		mkdirSync(join(home, "sessions"), { recursive: true });
		const helper: Helper = { id, parent: self(), agent: agent.name, description: goal(item.task), job: "", task, tool, started: Date.now(), cwd };
		writeAtomic(join(home, "system.md"), systemPrompt(helper, agent.systemPrompt ?? "", context));
		writeAtomic(join(home, "assignment.md"), `Complete assignment thoroughly:\n\n${item.task.trim()}\n`);
		let args = [...baseArgs(), "--session-dir", join(home, "sessions"), "--append-system-prompt", join(home, "system.md")];
		const [{ formatModelString, resolveAgentModelPatterns }, { AgentRegistry }, { getEnvApiKeyName }] = await Promise.all([
			import("@oh-my-pi/pi-coding-agent/config/model-resolver"),
			import("@oh-my-pi/pi-coding-agent/registry/agent-registry"),
			import("@oh-my-pi/pi-ai"),
		]);
		const session = AgentRegistry.global().get(MAIN)?.session;
		const inherits = [agent.model ?? []].flat().every(pattern => INHERITED.test(String(pattern).trim()));
		const requestModel = item.model ?? (BOT === "Lloyd" ? "@task" : (inherits ? (session?.settings?.getModelRole("task") ? "@task" : "@smol") : undefined));
		const [model] = resolveAgentModelPatterns({
			requestModel,
			agentModel: agent.model,
			settings: session?.settings,
			activeModelPattern: session?.model ? formatModelString(session.model) : undefined,
		});
		const config = join(home, "prewalk.json");
		writeAtomic(config, JSON.stringify({ prewalk: { enabled: false, auto: "off" } }));
		args.push("--config", config);
		if (model) args = withFlag(args, "--model", model);
		args.push("--no-prewalk");
		const tools = item.tools ?? agent.tools;
		if (Array.isArray(tools)) args = withFlag(args, "--tools", tools.join(","));
		const env = safeEnv(process.env);
		for (const key of ["OMP_BOT_RELAUNCH", "OMP_BOT_HEADLESS", "OMP_BOT_PID"]) delete env[key];
		for (const selected of [model]) {
			const provider = selected?.split("/")[0];
			const keys = provider === "anthropic" ? ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_FOUNDRY_API_KEY"] : [provider ? getEnvApiKeyName(provider) : undefined];
			for (const key of keys) if (key && process.env[key]) env[key] = process.env[key];
		}
		Object.assign(env, { OMP_BOT_HELPER: id, OMP_BOT_HELPER_PARENT: helper.parent, OMP_BOT_HELPER_DEPTH: String(DEPTH + 1), OMPD_OWNER: `helper:${BOT}/${id}` });
		try {
			const { job } = await call({
				op: "run",
				owner: owner(),
				tool,
				task,
				command: `rm -f ${quote(join(home, "stdin"))} && mkfifo ${quote(join(home, "stdin"))} && printf '%s\n' ${quote(`Helper transcripts: ${join(home, "sessions")}; final result: report beside this log`)} && exec ${[...args, "--mode", "rpc", "--no-ui"].map(quote).join(" ")} <>${quote(join(home, "stdin"))} 2> >(head -c ${REPORT_BYTES}; cat >/dev/null) >/dev/null`,
				cwd,
				env,
				timeout: (item.minutes ?? MINUTES) * 60,
				rerunnable: false,
			});
			helper.job = job.id;
		} catch (error) {
			rmSync(home, { recursive: true, force: true });
			throw error;
		}
		writeAtomic(join(home, "helper.json"), JSON.stringify(helper));
		return helper;
	}

	function route(to: string): string | undefined {
		if (SELF && to === BOT) return MAIN;
		if (to === self() || to === MAIN) return undefined;
		return record(to) ? to : undefined;
	}

	async function patchBus() {
		const [{ createAgentHubRuntime }, { AgentRegistry }] = await Promise.all([
			import("@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime"),
			import("@oh-my-pi/pi-coding-agent/registry/agent-registry"),
		]);
		const bus = createAgentHubRuntime({ activity: {} }).irc;
		if (bus[PATCHED]) return bus[PATCHED];
		const send = bus.send.bind(bus);
		bus[PATCHED] = send;
		bus.send = async (message, options) => {
			const to = AgentRegistry.global().get(message.to) ? undefined : route(message.to);
			if (!to) return send(message, options);
			if (to !== MAIN && !running(record(to))) return { to: message.to, outcome: "failed", error: `helper ${to} has ended; its result came back to ${record(to)?.parent ?? "its parent"}` };
			const box = join(MAIL, to);
			mkdirSync(box, { recursive: true });
			writeAtomic(join(box, `${Date.now()}-${crypto.randomUUID()}.json`), JSON.stringify({ from: SELF && message.from === MAIN ? SELF : message.from, body: message.body }));
			return { to: message.to, outcome: "injected" };
		};
		return send;
	}

	function receive(send) {
		const box = join(MAIL, self());
		let busy = false;
		main.setInterval(async () => {
			if (busy) return;
			busy = true;
			try {
				let files: string[] = [];
				try {
					files = readdirSync(box).filter(file => file.endsWith(".json")).sort();
				} catch {}
				for (const file of files) {
					const path = join(box, file);
					let message;
					try {
						message = JSON.parse(readFileSync(path, "utf8"));
					} catch {
						continue;
					}
					const from = SELF && message.from === MAIN ? BOT : String(message.from);
					const body = String(message.body ?? "");
					if (!SELF && record(message.from)?.parent === MAIN) {
						const text = body.replace(WAKE, "");
						pi.sendMessage({ customType: "irc:incoming", content: `<irc>\nIncoming IRC message from agent \`${from}\`:\n\n${escapeHarnessTags(text)}\n</irc>`, display: true, details: { id: file, from, message: text } }, text !== body ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn" });
					} else {
						const receipt = await send({ from, to: MAIN, body });
						if (receipt?.outcome === "failed") break;
					}
					rmSync(path, { force: true });
				}
			} finally {
				busy = false;
			}
		}, 1000);
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub" || main) return;
		main = ctx;
		try {
			receive(await patchBus());
		} catch (error) {
			console.error(`omp-bot: helper messages are off: ${error instanceof Error ? error.message : error}`);
		}
		if (SELF) await finishWhenDone(ctx);
	});

	let reported = "";
	let reportedFrom: unknown;
	pi.on("agent_end", async (event, ctx) => {
		if (!SELF || ctx.agent?.kind === "sub" || !process.env.OMPD_JOB_DIR) return;
		const messages = event.messages ?? [];
		const end = messages.findLastIndex(message => message?.role === "assistant");
		const last = messages[end];
		if (!last || last.timestamp === reportedFrom) return;
		const raw = (Array.isArray(last.content) ? last.content : []).filter(part => part?.type === "text").map(part => part.text).join("\n").trim();
		const said = raw.replace(WAKE, "");
		const failed = last.stopReason === "error" || last.stopReason === "aborted" ? `[its last turn ${last.stopReason === "error" ? "failed" : "was aborted"}${last.errorMessage ? `: ${last.errorMessage}` : ""}]` : "";
		const text = [said, failed].filter(Boolean).join("\n\n");
		if (!text) return;
		const kinds: string[] = [];
		for (let index = end - 1; index >= 0; index--) {
			const message = messages[index];
			if (message?.role === "assistant" && (message.content ?? []).some(part => part?.type === "text" && part.text?.trim())) break;
			if (message?.role === "user") kinds.push("user");
			if (message?.role === "custom") kinds.push(String(message.customType ?? ""));
		}
		const noticeOnly = reported !== "" && kinds.length > 0 && kinds.every(kind => kind === "ompd-job");
		reported = noticeOnly ? `${reported}\n\nAfter a job it had started ended:\n${text}` : text;
		reportedFrom = last.timestamp;
		const transcript = ctx.sessionManager.getSessionFile?.();
		const wake = join(process.env.OMPD_JOB_DIR, "wake");
		if (said !== raw || failed) writeAtomic(wake, "");
		else if (!noticeOnly) rmSync(wake, { force: true });
		writeAtomic(join(process.env.OMPD_JOB_DIR, "report"), `Result of helper ${SELF}:\n\n${reported}\n${transcript ? `\n(transcript: ${transcript})\n` : ""}`);
	});

	let turned = false;
	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.agent?.kind !== "sub") turned = true;
	});

	async function finishWhenDone(ctx) {
		let checking = false;
		ctx.setTimeout(() => pi.sendUserMessage(readFileSync(join(HELPERS, SELF, "assignment.md"), "utf8")), 500);
		ctx.setInterval(async () => {
			if (!turned || checking || !ctx.isIdle() || ctx.hasPendingMessages()) return;
			checking = true;
			try {
				const { jobs } = await call({ op: "list", owner: owner() });
				let mail: string[] = [];
				try {
					mail = readdirSync(join(MAIL, SELF));
				} catch {}
				if (jobs.some(job => !job.delivered) || mail.some(file => file.endsWith(".json")) || !ctx.isIdle() || ctx.hasPendingMessages()) return;
				ctx.shutdown();
				writeFileSync(join(HELPERS, SELF, "stdin"), `${JSON.stringify({ type: "get_state" })}\n`);
			} catch {
			} finally {
				checking = false;
			}
		}, 2000);
	}

	pi.registerTool({
		name: "task",
		label: "Task",
		description: `Starts helpers: each task is a subagent that runs as an omp session of its own, an ompd job outside this session with its own process and log, so this session restarting, its tab reopening or its omp crashing doesn't stop it. Every item attaches to a task in ompd's table: give \`check\`, a shell command that exits 0 only when the work is really finished, to open one, or \`for\`, the id of an existing task it works on, for a second helper on the same item or research with no check. Each item needs exactly one of them. A helper's section states the verdict from that task once its check has settled, never the helper's own claim; \`minutes\` caps how long it may run before ompd kills it (default ${MINUTES}). Every task gets \`context\` (shared background) and its own \`task\` (the complete assignment: helpers don't see this conversation); \`name\` (CamelCase) is its id, \`agent\` one of omp's agent definitions (task by default), \`tools\` and \`model\` override the agent's. The tool waits up to ${FOREGROUND_S}s and returns the results of the helpers done by then; one still running keeps running and its verdict arrives in this conversation as a message once its check settles, even after a restart, so never poll for it, and call wait only when nothing else is left to do${SELF ? "" : "; it waits quietly for your next turn unless the helper failed, asked to wake you (it was told to only when you must act now) or is the last job a background task waits on"}. Message a running helper with \`write\` to \`agent://<id>\`; it messages you the same way. \`${OMPD} kill JOB\` stops one. Without a \`model\` from the task or its agent, a helper runs on the task model role (the smol role when no task role is set), not this session's model; give \`model\` for work that needs a strong one, such as Lean proofs or compilers. At most ${MAX_HELPERS} of this bot's helpers run at once, and helpers start helpers at most ${MAX_DEPTH} deep: a call that would pass either is refused whole. A helper's environment keeps only non-secret variables and its model's API key; it asks for any other secret with the secret tool.`,
		parameters: z.object({
			context: z.string().optional(),
			tasks: z.array(
				z.object({
					task: z.string(),
					check: z.string().optional().describe("A shell command that exits 0 only when this item is really finished. It opens an ompd task the helper joins."),
					for: z.string().optional().describe("The id (or unique prefix) of an existing ompd task this helper works on, instead of check."),
					title: z.string().optional().describe("The task's title; defaults to the assignment's first line."),
					minutes: z.number().optional().describe(`Kills the helper after this many minutes; default ${MINUTES}.`),
					solutionSpace: z.string().optional(),
					name: z.string().optional(),
					agent: z.string().optional(),
					tools: z.array(z.string()).optional(),
					model: z.union([z.string(), z.array(z.string())]).optional().describe(BOT === "Lloyd" ? "Defaults to the Codex task role. Request Opus only for Lean proofs or compiler work." : "Overrides the agent model."),
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (!params.tasks.length) throw new Error("tasks is empty: give at least one task");
			for (const item of params.tasks) {
				if (Boolean(item.check?.trim()) === Boolean(item.for?.trim()))
					throw new Error("Each item needs exactly one of `check` (a shell command that exits 0 only when the work is really finished) and `for` (the id of an ompd task it works on). Nothing was started.");
			}
			if (DEPTH >= MAX_DEPTH) throw new Error(`Helpers nest at most ${MAX_DEPTH} deep and this one is at depth ${DEPTH}, so it can't start helpers. Nothing was started: do the work yourself, or report back to ${SELF ? "your parent" : BOT} what still needs doing.`);
			const fresh = params.tasks.filter((_, index) => !records().some(helper => helper.tool === `${toolCallId}#${index}`)).length;
			const live = records().filter(running).length;
			if (live + fresh > MAX_HELPERS) throw new Error(`${BOT} has ${live} helpers running and runs at most ${MAX_HELPERS} at once, so ${fresh} more would pass the cap. Nothing was started: wait for running helpers to finish (their results arrive here), or start fewer.`);
			const known = await definitions(resolve(ctx.cwd));
			const unknown = params.tasks.map(item => item.agent || "task").filter(name => !known.some(found => found.name === name));
			if (unknown.length) throw new Error(`No agent named ${[...new Set(unknown)].join(", ")}; the agents are ${known.map(found => found.name).join(", ")}. Nothing was started.`);
			const listed: Task[] = params.tasks.some(item => item.for) ? (await call({ op: "task-list", owner: owner() })).tasks : [];
			const linked = params.tasks.map(item => {
				if (!item.for) return undefined;
				const matches = listed.filter(task => task.id.startsWith(item.for!.trim()));
				if (matches.length !== 1) throw new Error(`${matches.length ? `task ${item.for} is ambiguous` : `no task ${item.for}`}: give the id of the ompd task this helper works on, or drop \`for\` and give \`check\` instead. Nothing was started.`);
				if (final(matches[0])) throw new Error(`task ${matches[0].id} is already ${matches[0].state}: give a task that is still open, or drop \`for\` and give \`check\` instead. Nothing was started.`);
				return matches[0].id;
			});
			const taken = new Set<string>();
			const started: Helper[] = [];
			for (const [index, item] of params.tasks.entries()) {
				const created: Task | undefined = item.check?.trim() ? (await call({ op: "task-add", owner: owner(), title: item.title?.trim() || goal(item.task), check: item.check, cwd: resolve(ctx.cwd), key: `${toolCallId}#${index}`, env: process.env })).task : undefined;
				if (created) pi.events.emit("ompd:task", { task: created });
				started.push(await start(item, params.context ?? "", resolve(ctx.cwd), `${toolCallId}#${index}`, created?.id ?? linked[index]!, taken));
			}
			for (const helper of started) awaited.add(helper.job);
			const done = new Map<string, Job>();
			try {
				const deadline = Date.now() + FOREGROUND_S * 1000;
				onUpdate?.({ content: [{ type: "text", text: `Started ${started.map(helper => helper.id).join(", ")}` }] });
				while (done.size < started.length && !signal?.aborted && !ctx.hasPendingMessages() && Date.now() < deadline) {
					for (const helper of started) {
						if (done.has(helper.id)) continue;
						const now = load(helper.job);
						if (now?.delivered) {
							done.set(helper.id, DELIVERED);
							continue;
						}
						const job = ended(now ?? ({ id: helper.job, state: "running" } as Job));
						if (!job) continue;
						const task = loadTask(helper.task);
						if (task && (task.state === "running" || task.state === "checking")) continue;
						done.set(helper.id, job);
						await call({ op: "ack", id: helper.job });
					}
					if (done.size < started.length) await Bun.sleep(250);
				}
			} finally {
				for (const helper of started) awaited.delete(helper.job);
			}
			const sections = started.map(helper => {
				const job = done.get(helper.id);
				if (!job) {
					pi.events.emit("ompd:background", { id: helper.job });
					return `## ${helper.id} (running, ompd job ${helper.job}, task ${helper.task})\n[Keeps running outside this session; its verdict arrives in this conversation once its check settles. Message it with write agent://${helper.id}; \`${OMPD} kill ${helper.job}\` stops it.]`;
				}
				const task = loadTask(helper.task);
				const header = task ? rowVerdict(task) : job === DELIVERED ? "ended" : outcome(job);
				const parts = [task ? checkResult(task) : "", job === DELIVERED ? "[Ended; its result was already delivered to this conversation as a message.]" : result(job).trimEnd()];
				return `## ${helper.id} (${header})\n${parts.filter(Boolean).join("\n\n")}`;
			});
			return { content: [{ type: "text", text: sections.join("\n\n") }], details: { helpers: started.map(helper => ({ id: helper.id, job: helper.job, task: helper.task })) } };
		},
	});
}
