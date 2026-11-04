import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { dir, type Job, load, request, SOCKET, V } from "../daemon/ompd";
import { ROOT, STATE } from "../daemon/paths";

const UNKNOWN = "Previous OMP process exited before this tool returned";
const FOREGROUND_S = Number(process.env.OMPD_FOREGROUND_S) || 300;
const TAIL_BYTES = 32 * 1024;
const OMPD = join(ROOT, "bin", "ompd");

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

function tail(id: string, bytes = TAIL_BYTES): string {
	const path = join(dir(id), "log");
	let fd: number | undefined;
	try {
		const size = statSync(path).size;
		const from = Math.max(0, size - bytes);
		const buffer = Buffer.alloc(size - from);
		fd = openSync(path, "r");
		readSync(fd, buffer, 0, buffer.length, from);
		const text = buffer.toString("utf8");
		return from > 0 ? `[${from} earlier bytes in ${path}]\n${text.slice(text.indexOf("\n") + 1)}` : text;
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

function report(job: Job): string {
	const command = job.command.length > 200 ? `${job.command.slice(0, 200)}…` : job.command;
	const out = tail(job.id).trimEnd();
	return `[ompd job ${job.id} ended: ${outcome(job)} after ${seconds(job)}${job.runs > 1 ? `, run ${job.runs}` : ""}]\n$ ${command}\n${out || "(no output)"}\n(log: ${join(dir(job.id), "log")})`;
}

let starting = 0;

function startDaemon() {
	if (Date.now() - starting < 5_000) return;
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
			if (!["ENOENT", "ECONNREFUSED"].includes(code) || attempt >= 40) throw error;
			startDaemon();
			await Bun.sleep(250);
		}
	}
}

let owner: string | undefined;
const cut = new Set<string>();
const awaited = new Set<string>();
const sent = new Set<string>();

function exited(job: Job): Job | undefined {
	if (job.state === "done" || job.state === "lost") return job;
	try {
		const text = readFileSync(join(dir(job.id), "exit"), "utf8").trim();
		return text === "" ? undefined : { ...job, state: "done", code: Number(text), ended: Date.now() };
	} catch {
		return undefined;
	}
}

function ownerOf(ctx): string {
	if (owner) return owner;
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
		if (job.tool && cut.has(job.tool)) {
			main.setTimeout(() => {
				cut.delete(job.tool!);
				const now = load(job.id);
				if (now && !now.delivered) void ended(now);
			}, 30_000);
			return;
		}
		if (!sent.has(job.id) && !delivered(job.id)) {
			sent.add(job.id);
			pi.sendMessage({ customType: "ompd-job", content: report(job), display: true, details: { id: job.id } }, { deliverAs: "followUp", triggerTurn: true });
		}
		await call({ op: "ack", id: job.id });
		pi.events.emit("ompd:ended", { id: job.id });
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

	pi.on("session_shutdown", async () => {
		closing = true;
		socket?.end();
	});

	pi.on("tool_call", async event => {
		if (!cut.delete(event.toolCallId)) return undefined;
		if (event.toolName === "bash" && !event.input?.pty) return undefined;
		return {
			block: true,
			reason: `This ${event.toolName} call was cut off when the last run ended, before it returned. Its outcome is unknown and it was not run again: check what it did before deciding to run it again.`,
		};
	});

	pi.registerTool({
		name: "bash",
		label: "Bash",
		description: `Runs a shell command with bash as an ompd job: a process outside this session that outlives restarts, its output kept in a log on disk. It waits like a normal shell for up to ${FOREGROUND_S}s; a command still running then, or started with async, keeps running and its result arrives in this conversation as a message when it ends, so never poll, sleep or wait for it. timeout (seconds) kills the command after that long; without one it has no limit. rerunnable marks a command safe to start again from scratch if the machine restarts while it runs (builds, tests); Lean builds always are, anything else defaults to not, and a job that isn't is reported outcome unknown instead. pty runs the command in a terminal inside this session instead, for interactive programs; that run does not outlive a restart. ${OMPD} jobs lists jobs and ${OMPD} kill ID stops one.`,
		parameters: z.object({
			command: z.string(),
			timeout: z.number().optional(),
			cwd: z.string().optional(),
			async: z.boolean().optional(),
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
			});
			awaited.add(job.id);
			try {
				const deadline = params.async ? 0 : Date.now() + FOREGROUND_S * 1000;
				let shown = "";
				for (;;) {
					const now = exited(load(job.id) ?? job);
					if (now) {
						await call({ op: "ack", id: job.id });
						const out = tail(job.id).trimEnd() || "(no output)";
						if (failed(now)) throw new Error(`${out}\n\n[${outcome(now)}]`);
						return { content: [{ type: "text", text: out }], details: { job: job.id } };
					}
					if (signal?.aborted || Date.now() >= deadline) {
						const last = exited(load(job.id) ?? job);
						if (last) continue;
						pi.events.emit("ompd:background", { id: job.id });
						const why = signal?.aborted ? "Stopped waiting" : params.async ? "Started" : `Still running after ${FOREGROUND_S}s`;
						const out = tail(job.id, 4096).trimEnd();
						return {
							content: [{ type: "text", text: `${out ? `${out}\n\n` : ""}[${why}: ompd job ${job.id} keeps running, log ${join(dir(job.id), "log")}. Its result arrives in this conversation as a message when it ends; don't poll or wait for it. ${OMPD} kill ${job.id} stops it.]` }],
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
	});
}
