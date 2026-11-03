import { writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { SOCKET } from "../daemon/paths";
import { identity } from "./prompt";

function prompt(task) {
	const lines = [`[omp-bot task ${task.id}, attempt ${task.attempt}${task.origin ? `, from ${task.origin}` : ""}]`, "", task.text];
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
	let socket: Socket | undefined;
	let ctx;
	let current: { id: string; attempt: number } | undefined;
	let started = false;
	let readySent = false;
	let refused = false;
	let stopped = false;
	const until = Number(process.env.OMP_BOT_UNTIL) || 0;

	pi.setLabel("Bot core");

	function send(message) {
		if (socket && !socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
	}

	function restart(now) {
		stopped = true;
		if (mode === "tui" && process.env.OMP_BOT_RELAUNCH) writeFileSync(process.env.OMP_BOT_RELAUNCH, "");
		if (now && !ctx.isIdle()) {
			current = undefined;
			ctx.abort();
		}
		ctx.shutdown();
	}

	function tick() {
		if (until && !stopped && Date.now() >= until && !current && ctx?.isIdle() && !ctx.hasPendingMessages()) return restart(false);
		if (!socket || current || readySent || !ctx?.isIdle() || ctx.hasPendingMessages()) return;
		readySent = true;
		send({ op: "ready" });
	}

	function receive(message) {
		switch (message.op) {
			case "welcome":
				readySent = false;
				return;
			case "refused":
				refused = true;
				ctx?.ui?.notify?.(`omp-bot: ${message.reason}`, "warning");
				return;
			case "restart":
				restart(message.now);
				return;
			case "task":
				current = { id: message.id, attempt: message.attempt };
				started = false;
				readySent = false;
				try {
					pi.sendUserMessage(prompt(message));
				} catch (error) {
					send({ op: "fail", id: current.id, error: `could not start: ${error instanceof Error ? error.message : error}` });
					current = undefined;
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
		s.on("connect", () => send({ op: "hello", bot: name, mode, pid: process.pid, task: current?.id ?? null }));
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

	pi.on("session_start", async (_event, c) => {
		if (c.agent?.kind === "sub" || ctx) return;
		ctx = c;
		dial();
		c.setInterval(tick, 1000);
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
		if (c.agent?.kind === "sub" || event.willContinue || !current || !started) return;
		const final = event.messages?.findLast(message => message.role === "assistant");
		const reason = final?.stopReason;
		if (reason === "aborted") send({ op: "fail", id: current.id, error: "stopped by the user", final: true });
		else if (reason === "error") send({ op: "fail", id: current.id, error: final?.errorMessage || "the model request failed" });
		else send({ op: "done", id: current.id, result: textOf(final) });
		current = undefined;
		started = false;
	});
}
