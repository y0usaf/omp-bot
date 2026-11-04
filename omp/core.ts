import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { SOCKET, STATE } from "../daemon/paths";
import { identity } from "./prompt";

const RESUME_GRACE_MS = 30_000;
const HEARTBEAT_MS = Number(process.env.OMP_BOT_HEARTBEAT_MS) || 30_000;
const ANSWERS = { approve: "approved it", deny: "denied it", handle: "left the call to you: decide it yourself and go on" };

type Task = { id: string; attempt: number; token: string; jobs: string[]; question?: string };

function prompt(task) {
	const lines = [`[omp-bot task ${task.id}, attempt ${task.attempt}${task.origin ? `, from ${task.origin}` : ""}${task.answer ? ", your question answered" : ""}]`, "", task.text];
	if (task.answer) lines.push("", `You asked the user: ${task.answer.question}`, `The user ${ANSWERS[task.answer.action] ?? task.answer.action}.${task.answer.note ? ` Their note: ${task.answer.note}` : ""}`);
	if (task.attempt > 1) lines.push("", "An earlier attempt at this task was interrupted. Before acting, check what it already did, and don't repeat any change or message outside this conversation.");
	return lines.join("\n");
}

function textOf(message) {
	const content = message?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.filter(part => part?.type === "text").map(part => part.text).join("\n").trim();
}

export default function core(pi) {
	const name = process.env.OMP_BOT_NAME;
	if (!name) return;
	const role = process.env.OMP_BOT_ROLE || "Assistant";
	const persona = process.env.OMP_BOT_PERSONA || "";
	const mode = process.env.OMP_BOT_HEADLESS === "1" ? "headless" : "tui";
	const z = pi.zod;
	let socket: Socket | undefined;
	let ctx;
	const taskFile = join(STATE, "bots", name, "task.json");
	let current: Task | undefined = mode === "tui" ? saved() : undefined;
	let since = Date.now();
	let started = false;
	let readySent = false;
	let refused = false;
	let stopped = false;
	const until = Number(process.env.OMP_UNTIL) || 0;

	pi.setLabel("Bot core");

	function saved(): Task | undefined {
		try {
			const task = JSON.parse(readFileSync(taskFile, "utf8"));
			return typeof task?.id === "string" && typeof task?.token === "string" ? { jobs: [], ...task } : undefined;
		} catch {
			return undefined;
		}
	}

	function keep(task: Task | undefined) {
		if (task !== current) since = Date.now();
		current = task;
		if (!task) return rmSync(taskFile, { force: true });
		writeFileSync(`${taskFile}.tmp`, JSON.stringify(task));
		renameSync(`${taskFile}.tmp`, taskFile);
	}

	function send(message) {
		if (socket && !socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
	}

	function report(message) {
		if (current) send({ ...message, id: current.id, token: current.token });
	}

	function restart(now) {
		stopped = true;
		if (mode === "tui" && process.env.OMP_BOT_RELAUNCH) writeFileSync(process.env.OMP_BOT_RELAUNCH, "");
		if (now && !ctx.isIdle()) {
			keep(undefined);
			ctx.abort();
		}
		ctx.shutdown();
	}

	function tick() {
		if (socket && current && !started && current.jobs.length === 0 && ctx?.isIdle() && !ctx.hasPendingMessages() && Date.now() - since > RESUME_GRACE_MS) {
			report({ op: "fail", error: "the bot restarted before its turn ran" });
			keep(undefined);
		}
		if (until && !stopped && Date.now() >= until && !current && ctx?.isIdle() && !ctx.hasPendingMessages()) return restart(false);
		if (!socket || current || readySent || !ctx?.isIdle() || ctx.hasPendingMessages()) return;
		readySent = true;
		send({ op: "ready" });
	}

	function receive(message) {
		switch (message.op) {
			case "welcome":
				readySent = false;
				if (current && message.task !== current.id) keep(undefined);
				return;
			case "expired":
				if (current?.id === message.id) keep(undefined);
				return;
			case "refused":
				refused = true;
				ctx?.ui?.notify?.(`omp-bot: ${message.reason}`, "warning");
				return;
			case "restart":
				restart(message.now);
				return;
			case "task":
				keep({ id: message.id, attempt: message.attempt, token: message.token, jobs: [] });
				started = false;
				readySent = false;
				try {
					pi.sendUserMessage(prompt(message));
				} catch (error) {
					report({ op: "fail", error: `could not start: ${error instanceof Error ? error.message : error}` });
					keep(undefined);
				}
				return;
		}
	}

	function dial() {
		if (stopped || refused || !ctx) return;
		const s = connect(SOCKET);
		socket = s;
		s.unref();
		s.setEncoding("utf8");
		let buffer = "";
		s.on("connect", () => send({ op: "hello", bot: name, mode, pid: Number(process.env.OMP_BOT_PID) || process.pid, task: current?.id ?? null, token: current?.token ?? null }));
		s.on("data", chunk => {
			buffer += chunk;
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				try {
					receive(JSON.parse(line));
				} catch {}
			}
		});
		s.on("error", () => {});
		s.on("close", () => {
			if (socket !== s) return;
			socket = undefined;
			readySent = false;
			if (!stopped && !refused) ctx?.setTimeout(dial, 2000);
		});
	}

	pi.events.on("ompd:background", ({ id }) => {
		if (current && !current.jobs.includes(id)) keep({ ...current, jobs: [...current.jobs, id] });
	});

	pi.events.on("ompd:ended", ({ id }) => {
		if (current?.jobs.includes(id)) keep({ ...current, jobs: current.jobs.filter(job => job !== id) });
	});

	pi.registerTool({
		name: "ask_decision",
		label: "Ask decision",
		description:
			"During an omp-bot task, puts a decision only the user can make to them and parks the task: when your turn ends it waits until they approve, deny, or leave the call to you, and then comes back to you with their answer. Give one plain question naming what you'd do. Do no work that depends on the answer, and end your turn after asking with where things stand. In live chat, just ask in your reply instead.",
		parameters: z.object({ question: z.string() }),
		async execute(_toolCallId, params) {
			const text = (message: string) => ({ content: [{ type: "text", text: message }], details: {} });
			if (!current) return text("No task is open: you're in live chat, so ask in your reply.");
			keep({ ...current, question: params.question.trim() });
			return text("Asked. The task waits for the user once this turn ends: end it now with a short note of where things stand.");
		},
	});

	pi.on("session_start", async (_event, c) => {
		if (c.agent?.kind === "sub" || ctx) return;
		ctx = c;
		dial();
		c.setInterval(tick, 1000);
		c.setInterval(() => report({ op: "beat" }), HEARTBEAT_MS);
	});

	pi.on("session_shutdown", async () => {
		stopped = true;
		socket?.end();
	});

	pi.on("before_agent_start", async (event, c) => {
		if (c.agent?.kind === "sub" || !Array.isArray(event.systemPrompt) || event.systemPrompt.length === 0) return undefined;
		const text = identity({ name, role, persona, mode, memory: process.env.OPTCHAT_BOT === name });
		const systemPrompt = [...event.systemPrompt];
		systemPrompt[systemPrompt.length - 1] = `${systemPrompt[systemPrompt.length - 1]}${text}`;
		return { systemPrompt };
	});

	pi.on("agent_start", async (_event, c) => {
		if (c.agent?.kind === "sub") return;
		readySent = false;
		if (current) started = true;
		else send({ op: "busy" });
	});

	pi.on("agent_end", async (event, c) => {
		if (c.agent?.kind === "sub" || event.willContinue || !current || !started || stopped) return;
		const final = event.messages?.findLast(message => message.role === "assistant");
		const reason = final?.stopReason;
		const result = textOf(final);
		started = false;
		if (reason === "aborted") report({ op: "fail", error: "stopped by the user", final: true });
		else if (reason === "error") report({ op: "fail", error: final?.errorMessage || "the model request failed" });
		else if (current.question) report({ op: "wait", wait: "decision", question: current.question, result });
		else if (current.jobs.length > 0) return report({ op: "wait", wait: "jobs", result });
		else report({ op: "done", result });
		keep(undefined);
	});
}
