import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { dir, type Job, load, MONITOR_MS, request, SOCKET, taskDetails, taskLine, V } from "../daemon/ompd";
import { ROOT, STATE } from "../daemon/paths";
import { final, loadTask, type Task } from "../daemon/tasks";

const UNKNOWN = "Previous OMP process exited before this tool returned";
const FOREGROUND_S = Number(process.env.OMPD_FOREGROUND_S) || 300;
const WAIT_MAX_MS = 30 * 60_000;
const TAIL_BYTES = 32 * 1024;
const NOTICE_BYTES = 6 * 1024;
const NOTICE_LINES = 50;
const REPORT_BYTES = 64 * 1024;
const OMPD = join(ROOT, "bin", "ompd");
const SERVICE = process.env.OMPD_SERVICE === "1";
const BOT = process.env.OMP_BOT_NAME ?? "";
const MAIN_BOT = Boolean(BOT) && !process.env.OMP_BOT_HELPER;

function cutOff(entries): Set<string> {
	const started = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "tool_execution_start" && entry.data?.toolCallId) started.add(entry.data.toolCallId);
		if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
		const text = entry.message.content?.find?.(part => part?.type === "text")?.text ?? "";
		if (!text.startsWith(UNKNOWN)) started.delete(entry.message.toolCallId);
	}
	return started;
}

function tail(id: string, bytes = TAIL_BYTES, lines = Infinity): string {
	const path = join(dir(id), "log");
	let fd: number | undefined;
	try {
		const size = statSync(path).size;
		const from = Math.max(0, size - bytes);
		const buffer = Buffer.alloc(size - from);
		fd = openSync(path, "r");
		readSync(fd, buffer, 0, buffer.length, from);
		let text = buffer.toString("utf8");
		if (from > 0) text = text.slice(text.indexOf("\n") + 1);
		const kept = text.trimEnd().split("\n");
		if (kept.length > lines) text = kept.slice(-lines).join("\n");
		const cut = size - Buffer.byteLength(text);
		return cut > 0 && (from > 0 || kept.length > lines) ? `[${cut} earlier bytes in ${path}]\n${text}` : text;
	} catch {
		return "";
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function seconds(job: Job): string {
	const s = Math.round(((job.ended ?? Date.now()) - (job.started ?? job.created)) / 1000);
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${s % 60}s`;
}

function outcome(job: Job): string {
	if (job.state === "lost") return `outcome unknown: ${job.reason}`;
	if (job.reason) return job.reason;
	return `exit ${job.code}`;
}

function failed(job: Job): boolean {
	return job.state === "lost" || job.code !== 0;
}

function verdict(task: Task): string {
	const check = task.checked;
	if (task.dropped !== null) return `dropped: ${task.dropped}`;
	if (check?.code === 0) return "check passed; the task is done";
	if (check) return `check failed (${check.code === null ? check.reason ?? "no exit code" : `exit ${check.code}`}); the task stays ${task.state}`;
	return `task ${task.state}`;
}

function notice(task: Task, log: string | null): string {
	const check = task.checked;
	let what: string;
	if (task.dropped !== null) what = `dropped: ${task.dropped}`;
	else if (check?.code === 0) what = "check passed; the task is done";
	else if (check) what = `check failed (${check.code === null ? check.reason ?? "no exit code" : `exit ${check.code}`}); the task stays ${task.state}${log ? `, log ${log}` : ""}`;
	else if (task.question !== null) what = `asks: ${task.question}`;
	else if (task.answer !== null) what = `answered: ${task.answer}`;
	else what = task.note ?? `is ${task.state}`;
	return `[ompd task ${task.id.slice(0, 8)} ${task.title}] ${what}`;
}

function botTask(): { jobs?: string[] } | undefined {
	try {
		return JSON.parse(readFileSync(join(STATE, "bots", BOT, "task.json"), "utf8"));
	} catch {
		return undefined;
	}
}


function waking(job: Job): boolean {
	if (job.reason === "killed on request" || job.reason === "killed before it started") return false;
	const task = job.task ? loadTask(job.task) : undefined;
	if (task?.checked && task.checked.code !== 0) return true;
	if (!MAIN_BOT || failed(job) || existsSync(join(dir(job.id), "wake"))) return true;
	const jobs = botTask()?.jobs ?? [];
	return jobs.includes(job.id) && jobs.every(id => {
		const other = id === job.id ? undefined : load(id);
		return !other || exited(other) !== undefined;
	});
}

function ownReport(job: Job): string | undefined {
	try {
		const text = readFileSync(join(dir(job.id), "report"), "utf8").trimEnd();
		return text.length > REPORT_BYTES ? `${text.slice(0, REPORT_BYTES)}\n[cut at ${REPORT_BYTES} bytes; the whole report is in ${join(dir(job.id), "report")}]` : text;
	} catch {
		return undefined;
	}
}

function report(job: Job): string {
	const task = job.task ? loadTask(job.task) : undefined;
	const line = task ? `\n[task ${task.id.slice(0, 8)}: ${verdict(task)}]` : "";
	const own = ownReport(job);
	if (own !== undefined) return `[ompd job ${job.id} ended: ${outcome(job)} after ${seconds(job)}]${line}\n${own}\n(log: ${join(dir(job.id), "log")})`;
	const text = job.command.trim().replace(/\s*\n\s*/g, " ↵ ");
	const command = text.length > 200 ? `${text.slice(0, 200)}…` : text;
	const out = tail(job.id, NOTICE_BYTES, NOTICE_LINES).trimEnd();
	return `[ompd job ${job.id} ended: ${outcome(job)} after ${seconds(job)}${job.runs > 1 ? `, run ${job.runs}` : ""}]${line}\n$ ${command}\n${out || "(no output)"}\n(log: ${join(dir(job.id), "log")})`;
}

function output(job: Job, lines: string[], omitted: number, skipped: number): string {
	const head = `[ompd job ${job.id} output${skipped ? `, ${skipped} bytes skipped as the writer outpaced the monitor` : ""}]`;
	const cut = omitted ? [`… ${omitted} earlier matching lines coalesced`] : [];
	return `${head}\n${[...cut, ...lines].join("\n")}\n(log: ${join(dir(job.id), "log")})`;
}

let starting = 0;

function startDaemon() {
	if (SERVICE || Date.now() - starting < 5_000) return;
	starting = Date.now();
	mkdirSync(join(STATE, "logs"), { recursive: true });
	const log = openSync(join(STATE, "logs", "ompd.log"), "a");
	try {
		Bun.spawn(["setsid", "-f", OMPD, "serve"], { stdin: "ignore", stdout: log, stderr: log }).unref();
	} finally {
		closeSync(log);
	}
}

async function call(message: Record<string, unknown>): Promise<any> {
	for (let attempt = 0; ; attempt++) {
		try {
			return await request(message);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (!["ENOENT", "ECONNREFUSED"].includes(code) || attempt >= (SERVICE ? 240 : 40)) throw error;
			startDaemon();
			await Bun.sleep(250);
		}
	}
}

let owner: string | undefined;
const cut = new Set<string>();
const awaited: Set<string> = ((globalThis as any)[Symbol.for("ompd.awaited")] ??= new Set());
const sent = new Set<string>();

function exited(job: Job): Job | undefined {
	let done: Job | undefined;
	if (job.state === "done" || job.state === "lost") done = job;
	else {
		try {
			const text = readFileSync(join(dir(job.id), "exit"), "utf8").trim();
			done = text === "" ? undefined : { ...job, state: "done", code: Number(text), ended: Date.now() };
		} catch {
			return undefined;
		}
	}
	if (!done) return undefined;
	const task = done.task ? loadTask(done.task) : undefined;
	return task && (task.state === "running" || task.state === "checking") ? undefined : done;
}

function ownerOf(ctx): string {
	if (ctx.agent?.kind === "sub") return `sub:${ctx.sessionManager.getSessionId()}`;
	if (owner) return owner;
	if (process.env.OMPD_OWNER) return process.env.OMPD_OWNER;
	return process.env.OMP_BOT_NAME ? `bot:${process.env.OMP_BOT_NAME}` : `session:${ctx.sessionManager.getSessionId()}`;
}

export default function ompd(pi) {
	const z = pi.zod;
	let main;
	let socket: Socket | undefined;
	let closing = false;

	pi.setLabel("ompd");

	function delivered(id: string): boolean {
		return main.sessionManager.getEntries().some(entry => entry.customType === "ompd-job" && entry.details?.id === id);
	}

	async function ended(job: Job) {
		if (awaited.has(job.id) || load(job.id)?.delivered) return;
		const toolCall = job.tool?.replace(/#\d+$/, "");
		if (toolCall && cut.has(toolCall)) {
			main.setTimeout(() => {
				cut.delete(toolCall);
				const now = load(job.id);
				if (now && !now.delivered) void ended(now);
			}, 30_000);
			return;
		}
		const wake = waking(job);
		pi.events.emit("ompd:ended", { id: job.id, failed: failed(job) });
		if (!sent.has(job.id) && !delivered(job.id)) {
			sent.add(job.id);
			pi.sendMessage({ customType: "ompd-job", content: report(job), display: !BOT, details: { id: job.id } }, wake ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn" });
		}
		await call({ op: "ack", id: job.id });
	}

	const seen = new Map<string, number>();

	async function heard(next: Task, log: string | null) {
		pi.events.emit("ompd:task", { task: next });
		if (MAIN_BOT) {
			const wake = next.answer !== null || (next.checked !== null && next.checked.code !== 0);
			pi.sendMessage({ customType: "ompd-task", content: notice(next, log), display: !BOT, details: { id: next.id, task: next } }, wake ? { deliverAs: "followUp", triggerTurn: true } : { deliverAs: "nextTurn" });
		}
		await call({ op: "task-ack", id: next.id, seq: next.seq });
	}

	function watch() {
		if (closing || !main) return;
		const s = connect(SOCKET);
		socket = s;
		s.unref();
		s.setEncoding("utf8");
		let buffer = "";
		s.on("connect", () => s.write(`${JSON.stringify({ v: V, op: "watch", owner })}\n`));
		s.on("data", chunk => {
			buffer += chunk;
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				try {
					const message = JSON.parse(line);
					if (message.event === "task" && message.task) {
						const next = message.task as Task;
						if ((seen.get(next.id) ?? -1) >= next.seq) continue;
						seen.set(next.id, next.seq);
						void heard(next, message.log ?? null).catch(() => {});
						continue;
					}
					if (message.event === "output") {
						const job = message.job as Job;
						if (!delivered(job.id)) pi.sendMessage({ customType: "ompd-output", content: output(job, message.lines, message.omitted, message.skipped), display: !BOT, details: { id: job.id } }, { deliverAs: "followUp", triggerTurn: true });
					}
					if (message.event === "ended") void ended(message.job).catch(() => {});
				} catch {}
			}
		});
		s.on("error", error => {
			if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) startDaemon();
		});
		s.on("close", () => {
			if (socket !== s || closing) return;
			socket = undefined;
			main.setTimeout(watch, 2000);
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		for (const id of cutOff(ctx.sessionManager.getEntries())) cut.add(id);
		if (ctx.agent?.kind === "sub" || main) return;
		main = ctx;
		owner = ownerOf(ctx);
		watch();
	});

	let listed = "";

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!MAIN_BOT || ctx.agent?.kind === "sub" || !main) return undefined;
		let open: Task[];
		try {
			open = ((await call({ op: "task-list", owner: ownerOf(ctx) })).tasks as Task[]).filter(task => !final(task));
		} catch {
			return undefined;
		}
		const text = open.length ? open.map(task => [taskLine(task), ...taskDetails(task, 0)].join("\n")).join("\n") : "No open tasks.";
		if (text === listed || (!open.length && !listed)) return undefined;
		listed = text;
		return { message: { customType: "ompd-tasks", content: text, display: false, details: { tasks: open } } };
	});

	pi.on("session_shutdown", async () => {
		closing = true;
		socket?.end();
	});

	pi.on("tool_call", async event => {
		if (!cut.delete(event.toolCallId)) return undefined;
		if (event.toolName === "bash" && !event.input?.pty) return undefined;
		if (event.toolName === "task" && (globalThis as any)[Symbol.for("omp-bot.helpers")]) return undefined;
		return {
			block: true,
			reason: `This ${event.toolName} call was cut off when the last run ended, before it returned. Its outcome is unknown and it was not run again: check what it did before deciding to run it again.`,
		};
	});

	if (BOT === "Lloyd") pi.on("session_start", () => {
		if (!pi.getActiveTools().includes("read")) return;
		const read = pi.getAllTools().find(tool => tool.name === "read");
		if (!read) return;
		pi.registerTool({
			...read,
			label: "Read",
			description: `${read.description}\n\nproc:// also lists this session's ompd jobs; proc://<job-id> returns their status and bounded output without acknowledging delivery. Completions arrive automatically; do not poll.`,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				if (!ctx.invokeTool) throw new Error("read needs omp's native read tool");
				const native = () => ctx.invokeTool(params, { signal, onUpdate });
				const match = /^proc:\/\/([^/?#:]*)$/.exec(params.path);
				if (!match) return native();
				const response: { jobs: Job[] } = await call({ op: "list", owner: ownerOf(ctx) });
				const jobs = response.jobs.map(job => exited(job) ?? job);
				const id = match[1];
				if (id) {
					const job = jobs.find(job => job.id === id);
					if (!job) return native();
					const state = `${job.id} [ompd] ${job.state}${job.state === "done" || job.state === "lost" ? ` — ${outcome(job)}` : ""} — ${seconds(job)} — ${job.command}`;
					return { content: [{ type: "text", text: `${state}\n${tail(job.id).trimEnd() || "(no output)"}` }], details: { proc: { job, log: join(dir(job.id), "log") } } };
				}
				const result = await native();
				if (!jobs.length) return result;
				const text = jobs.map(job => `${job.id} [ompd] ${job.state}${job.state === "done" || job.state === "lost" ? ` — ${outcome(job)}` : ""} — ${seconds(job)} — ${job.command.replace(/\s+/g, " ")}`).join("\n");
				return { content: [...result.content, { type: "text", text: `\nompd jobs:\n${text}` }], details: { proc: { ...result.details?.proc, ompd: jobs } } };
			},
		});
	});

	pi.on("session_start", () => {
		if (!pi.getActiveTools().includes("wait")) return;
		const wait = pi.getAllTools().find(tool => tool.name === "wait");
		if (!wait) return;
		pi.registerTool({
			...wait,
			label: "Wait",
			description: `${wait.description}\n\nIt also waits for this session's ompd jobs, and returns the first one to end with its output.`,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const response: { jobs: Job[] } = await call({ op: "list", owner: ownerOf(ctx) });
				const mine = response.jobs.filter(job => !job.delivered && !awaited.has(job.id) && !sent.has(job.id));
				if (!mine.length) {
					if (!ctx.invokeTool) throw new Error("wait needs omp's native wait tool");
					return ctx.invokeTool(params, { signal, onUpdate });
				}
				for (const job of mine) awaited.add(job.id);
				const until = Date.now() + WAIT_MAX_MS;
				try {
					for (;;) {
						const done = mine.map(job => exited(load(job.id) ?? job)).find(job => job !== undefined);
						if (done) {
							sent.add(done.id);
							await call({ op: "ack", id: done.id });
							return { content: [{ type: "text", text: report(done) }], details: { job: done.id } };
						}
						if (signal?.aborted) throw new Error("Wait aborted");
						if (ctx.hasPendingMessages()) return { content: [{ type: "text", text: "Wait interrupted by message." }], details: {} };
						if (Date.now() >= until) return { content: [{ type: "text", text: `Wait limit reached; still running: ${mine.map(job => job.id).join(", ")}. Read proc:// for status.` }], details: {} };
						await Bun.sleep(250);
					}
				} finally {
					for (const job of mine) {
						awaited.delete(job.id);
						const gone = exited(load(job.id) ?? job);
						if (gone && !sent.has(job.id)) void ended(gone).catch(() => {});
					}
				}
			},
		});
	});

	const bash = {
		name: "bash",
		label: "Bash",
		description: `Runs a shell command with bash as an ompd job: a process outside this session that outlives restarts, its output kept in a log on disk. It waits like a normal shell for up to ${FOREGROUND_S}s; a command still running then, or started with async, keeps running and its result arrives in this conversation as a message when it ends, so never poll or sleep for it; when nothing else is left to do until it ends, call wait${MAIN_BOT ? "; a failure wakes you at once, while a success waits quietly in this conversation for your next turn unless it is the last job a background task waits on" : ""}. monitor wakes you with each new batch of the job's output that matches filter, a regex, or everything without one, at most once every ${Math.round(MONITOR_MS / 1000)}s, dropping repeated lines; it returns as soon as the job starts and keeps waking you until the job ends, across your restarts. A job you stop with kill reports quietly at your next turn. Pipelines run with pipefail, so cmd | tail fails when cmd fails, and a writer cut off by an early reader such as head fails with 141; start with set +o pipefail when the command cuts output short on purpose. timeout (seconds) kills the command after that long; without one it has no limit. rerunnable marks a command safe to start again from scratch if the machine restarts while it runs (builds, tests); it defaults to not, and a job that isn't is reported outcome unknown instead. pty runs the command in a terminal inside this session instead, for interactive programs; that run does not outlive a restart. ${OMPD} jobs lists jobs and ${OMPD} kill ID stops one.${BOT ? " Inside a background task, git push, rebase, commit --amend, filter-repo and filter-branch are blocked until the user approves them through ask_decision; in live chat they run." : ""}`,
		parameters: z.object({
			command: z.string(),
			timeout: z.number().optional(),
			cwd: z.string().optional(),
			async: z.boolean().optional(),
			monitor: z.boolean().optional(),
			filter: z.string().optional(),
			rerunnable: z.boolean().optional(),
			pty: z.boolean().optional(),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (params.pty) {
				if (!ctx.invokeTool) throw new Error("pty needs omp's own bash, which this session doesn't offer");
				return ctx.invokeTool(params);
			}
			const { job } = await call({
				op: "run",
				owner: ownerOf(ctx),
				tool: toolCallId,
				command: params.command,
				cwd: resolve(ctx.cwd, params.cwd ?? "."),
				env: process.env,
				timeout: params.timeout ?? 0,
				rerunnable: params.rerunnable ?? false,
				monitor: params.monitor || params.filter !== undefined ? (params.filter ?? "") : undefined,
			});
			awaited.add(job.id);
			try {
				const sub = ctx.agent?.kind === "sub";
				const deadline = params.monitor || params.filter !== undefined || params.async ? 0 : sub ? Infinity : Date.now() + FOREGROUND_S * 1000;
				let shown = "";
				for (;;) {
					const now = exited(load(job.id) ?? job);
					if (now) {
						await call({ op: "ack", id: job.id });
						const out = tail(job.id).trimEnd() || "(no output)";
						if (failed(now)) throw new Error(`${out}\n\n[${outcome(now)}]`);
						return { content: [{ type: "text", text: out }], details: { job: job.id } };
					}
					const stopped = signal?.aborted || (!sub && ctx.hasPendingMessages());
					if (stopped || Date.now() >= deadline) {
						const last = exited(load(job.id) ?? job);
						if (last) continue;
						if (sub) {
							await call({ op: "kill", id: job.id });
							await call({ op: "ack", id: job.id });
							throw new Error(`${tail(job.id, 4096).trimEnd()}\n\n[Stopped: ompd job ${job.id} killed]`);
						}
						pi.events.emit("ompd:background", { id: job.id });
						const why = stopped ? "Stopped waiting" : params.monitor || params.filter !== undefined ? `Monitoring${params.filter ? ` for /${params.filter}/` : ""}` : params.async ? "Started" : `Still running after ${FOREGROUND_S}s`;
						const out = tail(job.id, 4096).trimEnd();
						return {
							content: [{ type: "text", text: `${out ? `${out}\n\n` : ""}[${why}: ompd job ${job.id} keeps running, log ${join(dir(job.id), "log")}. ${params.monitor || params.filter !== undefined ? "Matching output arrives in this conversation as it appears. " : ""}Its result arrives in this conversation as a message when it ends; don't poll or sleep for it, and call wait only when nothing else is left to do. ${OMPD} kill ${job.id} stops it.]` }],
							details: { job: job.id, running: true },
						};
					}
					const out = tail(job.id, 4096);
					if (out !== shown) {
						shown = out;
						onUpdate?.({ content: [{ type: "text", text: out }], details: { job: job.id } });
					}
					await Bun.sleep(100);
				}
			} finally {
				awaited.delete(job.id);
			}
		},
	};
	if (BOT === "Lloyd") pi.on("session_start", () => {
		if (pi.getActiveTools().includes("bash")) pi.registerTool(bash);
	});
	else pi.registerTool(bash);
}
