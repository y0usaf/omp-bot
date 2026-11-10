import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { approvesGit } from "../daemon/guard";
import { SOCKET, STATE } from "../daemon/paths";
import { identity } from "./prompt";

const RESUME_GRACE_MS = 30_000;
const HEARTBEAT_MS = Number(process.env.OMP_BOT_HEARTBEAT_MS) || 30_000;
const ANSWERS = { approve: "approved it", deny: "denied it", handle: "left the call to you: decide it yourself and go on" };

type Task = { id: string; attempt: number; token: string; mode?: string; jobs: string[]; question?: string; result?: string };
type Decision = { id: string; question: string | null; text: string };

const CHOICES = [
	{ label: "Approve", action: "approve", description: "Go ahead with what the bot proposes" },
	{ label: "Deny", action: "deny", description: "Don't; the bot is told no" },
	{ label: "Handle", action: "handle", description: "Leave the call to the bot" },
];

function brief(text: string, max = 240): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max)}…` : line;
}

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
	const persona = process.env.OMP_BOT_PERSONA || "";
	const mode = process.env.OMP_BOT_HEADLESS === "1" ? "headless" : "tui";
	const z = pi.zod;
	let socket: Socket | undefined;
	let ctx;
	const taskFile = join(STATE, "bots", name, "task.json");
	let current: Task | undefined;
	let since = Date.now();
	let started = false;
	let readySent = false;
	let refused = false;
	let stopped = false;
	let decisions: Decision[] = [];
	const dismissed = new Set<string>();
	let asking: { id: string; controller: AbortController } | undefined;
	let injected: string | undefined;
	keep(saved());

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
		if (task) process.env.OMP_BOT_TASK = task.id;
		else delete process.env.OMP_BOT_TASK;
		if (!task) return rmSync(taskFile, { force: true });
		writeFileSync(`${taskFile}.tmp`, JSON.stringify({ ...task, mode }));
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
		if (!asking && !current && ctx?.isIdle() && !ctx.hasPendingMessages()) {
			const next = decisions.find(decision => !dismissed.has(decision.id));
			if (next) void decide(next);
		}
		if (!socket || current || readySent || !ctx?.isIdle() || ctx.hasPendingMessages()) return;
		readySent = true;
		send({ op: "ready" });
	}

	async function decide(decision: Decision) {
		const askDialog = ctx?.hasUI ? ctx.ui?.askDialog : undefined;
		if (!askDialog) return;
		const controller = new AbortController();
		asking = { id: decision.id, controller };
		try {
			const result = await askDialog([{ id: decision.id, header: `${name} asks`, question: decision.question || `(no question given) ${brief(decision.text)}`, options: CHOICES.map(({ label, description }) => ({ label, description })) }], { signal: controller.signal });
			const answer = result?.kind === "chat" ? undefined : result?.results?.[0];
			const choice = CHOICES.find(each => each.label === answer?.selectedOptions?.[0]) ?? (answer?.customInput?.trim() ? CHOICES[2] : undefined);
			if (!choice || answer?.timedOut) {
				if (!controller.signal.aborted) dismissed.add(decision.id);
				return;
			}
			send({ op: "answer", source: "user", id: decision.id, action: choice.action, note: answer?.customInput ?? answer?.note ?? "" });
			decisions = decisions.filter(each => each.id !== decision.id);
		} catch (error) {
			if (!controller.signal.aborted) {
				dismissed.add(decision.id);
				ctx.ui?.notify?.(`omp-bot: could not show ${decision.id}: ${error instanceof Error ? error.message : error}`, "warning");
			}
		} finally {
			if (asking?.controller === controller) asking = undefined;
		}
	}

	function receive(message) {
		switch (message.op) {
			case "decisions":
				decisions = Array.isArray(message.tasks) ? message.tasks : [];
				if (asking && !decisions.some(decision => decision.id === asking!.id)) asking.controller.abort();
				return;
			case "welcome":
				readySent = false;
				refused = false;
				if (current && message.task !== current.id) keep(undefined);
				return;
			case "expired":
				if (current?.id === message.id) keep(undefined);
				return;
			case "refused":
				if (!refused) ctx?.ui?.notify?.(`omp-bot: ${message.reason}; trying again every few seconds`, "warning");
				refused = true;
				socket?.end();
				return;
			case "restart":
				restart(message.now);
				return;
			case "task":
				keep({ id: message.id, attempt: message.attempt, token: message.token, jobs: [] });
				started = false;
				readySent = false;
				try {
					const text = prompt(message);
					injected = text;
					pi.sendUserMessage(text);
				} catch (error) {
					report({ op: "fail", error: `could not start: ${error instanceof Error ? error.message : error}` });
					keep(undefined);
				}
				return;
		}
	}

	function dial() {
		if (stopped || !ctx) return;
		const s = connect(SOCKET);
		socket = s;
		s.unref();
		s.setEncoding("utf8");
		let buffer = "";
		s.on("connect", () => {
			send({ op: "hello", bot: name, mode, pid: Number(process.env.OMP_BOT_PID) || process.pid, task: current?.id ?? null, token: current?.token ?? null });
		});
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
			if (!stopped) ctx?.setTimeout(dial, refused ? 5000 : 2000);
		});
	}

	pi.events.on("ompd:background", ({ id }) => {
		if (current && !current.jobs.includes(id)) keep({ ...current, jobs: [...current.jobs, id] });
	});

	pi.events.on("ompd:ended", ({ id, failed }) => {
		if (current?.jobs.includes(id)) keep({ ...current, result: failed ? undefined : current.result, jobs: current.jobs.filter(job => job !== id) });
	});

	pi.registerCommand("decisions", {
		description: "Show the decisions this bot's tasks are waiting on again",
		handler: async () => {
			dismissed.clear();
			if (!decisions.length) ctx?.ui?.notify?.("No decisions are waiting on you.", "info");
		},
	});

	pi.registerTool({
		name: "ask_decision",
		label: "Ask decision",
		description:
			"During an omp-bot task, puts a decision only the user can make to them (taste, priorities, money, other people, anything irreversible; never one you could make yourself) and parks the task: when your turn ends it waits until they approve, deny, or leave the call to you, and then comes back to you with their answer. Give one plain question naming what you'd do. Do no work that depends on the answer, and end your turn after asking with where things stand. In live chat, just ask in your reply instead.",
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
		if (mode === "headless") c.setTimeout(() => void restore().catch(error => console.error(`omp-bot: could not restore the interrupted turn: ${error instanceof Error ? error.message : error}`)), 1000);
		c.setInterval(tick, 1000);
		c.setInterval(() => report({ op: "beat" }), HEARTBEAT_MS);
	});

	async function restore() {
		const { AgentRegistry, MAIN_AGENT_ID } = await import("@oh-my-pi/pi-coding-agent/registry/agent-registry");
		const { restoreSession } = await import("@oh-my-pi/pi-coding-agent/task/restore");
		const session = AgentRegistry.global().get(MAIN_AGENT_ID)?.session;
		if (!session) return;
		const { turn, subagents } = await restoreSession(session);
		if (turn || subagents.length) console.error(`omp-bot: restored the interrupted turn${subagents.length ? ` and ${subagents.length} subagents` : ""}`);
	}

	pi.on("session_shutdown", async (_event, c) => {
		if (c?.agent?.kind === "sub") return;
		stopped = true;
		socket?.end();
	});

	pi.on("before_agent_start", async (event, c) => {
		if (c.agent?.kind === "sub" || !Array.isArray(event.systemPrompt) || event.systemPrompt.length === 0) return undefined;
		const text = identity({ name, persona, mode, memory: process.env.OMP_BOT_MEMORY === "optchat" });
		const systemPrompt = [...event.systemPrompt];
		systemPrompt[systemPrompt.length - 1] = `${systemPrompt[systemPrompt.length - 1]}${text}`;
		return { systemPrompt };
	});

	pi.on("input", async (event, c) => {
		if (c.agent?.kind === "sub") return;
		const live = event.text !== injected;
		injected = undefined;
		send({ op: "live", git: approvesGit(event.text), live });
	});

	pi.on("agent_start", async (_event, c) => {
		if (c.agent?.kind === "sub") return;
		readySent = false;
		if (current) started = true;
		else send({ op: "busy" });
	});

	pi.on("agent_end", async (event, c) => {
		if (c.agent?.kind === "sub") return;
		if (!event.willContinue) send({ op: "live", git: false, live: false });
		if (event.willContinue || !current || !started || stopped) return;
		const final = event.messages?.findLast(message => message.role === "assistant");
		const reason = final?.stopReason;
		const result = current.result || textOf(final);
		if (reason === "aborted" && c.hasPendingMessages()) return;
		started = false;
		if (reason === "aborted") report({ op: "fail", error: "stopped by the user", final: true });
		else if (reason === "error") report({ op: "fail", error: final?.errorMessage || "the model request failed" });
		else if (current.question) report({ op: "wait", wait: "decision", question: current.question, result });
		else if (current.jobs.length > 0) {
			keep({ ...current, result });
			return report({ op: "wait", wait: "jobs", result });
		}
		else report({ op: "done", result });
		keep(undefined);
	});
}
