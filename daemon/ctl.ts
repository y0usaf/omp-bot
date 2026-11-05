import { connect } from "node:net";
import { SOCKET } from "./paths";

const USAGE = `usage: omp-bot-ctl COMMAND
  task BOT TEXT [--key KEY] [--origin ORIGIN]   queue a task; the same KEY never queues twice
  tasks [--bot BOT] [--state STATE]             recent tasks
  inbox                                         decisions waiting on you, and finished and failed tasks not yet acknowledged
  ack ID                                        acknowledge an inbox task
  approve|deny|handle ID [NOTE]                 answer a task waiting on your decision: approve, deny, or let its bot decide
  board                                         the task board's JSON: every decision waiting on you, the work in progress and the bots' subagents, the newest finished tasks
  status [--json]                               which bots are connected, and how, and which are down and why
  restart BOT [--now]                           restart BOT once it is idle (--now: at once, retrying its task); a down BOT tries to start again
  claim BOT                                     wait until BOT's headless run has stopped
  holder BOT                                    what holds BOT's lock: tui PID, dying PID, headless PID or none
  event JSON                                    record a lifecycle event; the gate logs its decision, nothing runs
  retire BOT                                    fail BOT's queued tasks and stop its background run`;

function request(message: unknown, timeoutMs = 0): Promise<any> {
	return new Promise((resolve, reject) => {
		const socket = connect(SOCKET);
		let buffer = "";
		const timer = timeoutMs ? setTimeout(() => (socket.destroy(), reject(new Error("timed out"))), timeoutMs) : undefined;
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
		socket.on("data", chunk => {
			buffer += chunk;
			const nl = buffer.indexOf("\n");
			if (nl < 0) return;
			clearTimeout(timer);
			socket.end();
			const reply = JSON.parse(buffer.slice(0, nl));
			reply.ok === false ? reject(new Error(reply.error)) : resolve(reply);
		});
		socket.on("error", error => (clearTimeout(timer), reject(error)));
	});
}

function flags(args: string[]): { rest: string[]; opts: Record<string, string> } {
	const rest: string[] = [];
	const opts: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--now" || args[i] === "--json") opts[args[i].slice(2)] = "1";
		else if (args[i].startsWith("--")) opts[args[i].slice(2)] = args[++i];
		else rest.push(args[i]);
	}
	return { rest, opts };
}

function card(task: any) {
	const { id, bot, state, wait, question, result, error, text, attempts, updated } = task;
	return { id, bot, state, wait, question, result, error, text, attempts, updated, answer: task.answer ? JSON.parse(task.answer) : null };
}

function line(task: any): string {
	const when = new Date(task.updated).toISOString().replace("T", " ").slice(0, 19);
	const waiting = task.state === "waiting" ? (task.wait === "decision" ? " on your decision" : " on its jobs") : "";
	const body = (task.state === "failed" ? task.error : task.wait === "decision" ? `${task.question}\n\n${task.result ?? ""}` : task.result ?? task.text) ?? "";
	return `${task.id}  ${task.bot}  ${task.state}${waiting}  attempt ${task.attempts}  ${when}\n  ${String(body).trim().replace(/\n/g, "\n  ")}`;
}

const [command, ...args] = process.argv.slice(2);
const { rest, opts } = flags(args);
try {
	switch (command) {
		case "task": {
			if (rest.length < 2) throw new Error(USAGE);
			const reply = await request({ op: "enqueue", bot: rest[0], text: rest.slice(1).join(" "), key: opts.key, origin: opts.origin });
			console.log(`${reply.id} ${reply.created ? "queued" : `already ${reply.state}`}`);
			break;
		}
		case "event": {
			const event = JSON.parse(rest.join(" "));
			const reply = await request({ op: "event", ...event });
			console.log(reply.rule ?? "no rule");
			break;
		}
		case "tasks":
			for (const task of (await request({ op: "list", bot: opts.bot, state: opts.state })).tasks) console.log(line(task));
			break;
		case "inbox":
			for (const task of (await request({ op: "inbox" })).tasks) console.log(line(task));
			break;
		case "ack":
			if (!rest[0]) throw new Error(USAGE);
			await request({ op: "ack", id: rest[0] });
			break;
		case "approve":
		case "deny":
		case "handle":
			if (!rest[0]) throw new Error(USAGE);
			await request({ op: "answer", id: rest[0], action: command, note: rest.slice(1).join(" ") });
			console.log(`${rest[0]} queued`);
			break;
		case "board": {
			const list = async (state: string, limit: number): Promise<any[]> => (await request({ op: "list", state, limit })).tasks;
			const [waiting, running, queued, done, failed, subagents] = await Promise.all([list("waiting", 1000), list("running", 1000), list("queued", 1000), list("done", 40), list("failed", 40), request({ op: "subagents", limit: 40 })]);
			const finished = [...done.filter(task => String(task.result ?? "").trim() !== "Nothing to report."), ...failed].sort((a, b) => b.updated - a.updated).slice(0, 40);
			console.log(JSON.stringify({
				decisions: waiting.filter(task => task.wait === "decision").map(card),
				working: [...running, ...waiting.filter(task => task.wait !== "decision"), ...queued].map(card),
				finished: finished.map(card),
				subagents: { running: subagents.running, finished: subagents.finished },
			}));
			break;
		}
		case "status": {
			const { bots } = await request({ op: "status" });
			if (opts.json) {
				console.log(JSON.stringify(bots));
				break;
			}
			for (const bot of bots) console.log(`${bot.bot}  ${bot.down ? `down since ${new Date(bot.down.since).toISOString().replace("T", " ").slice(0, 19)}: ${bot.down.reason}` : bot.link ?? "asleep"}${bot.task ? `  working on ${bot.task}` : ""}`);
			break;
		}
		case "unretire":
		case "retire":
			if (!rest[0]) throw new Error(USAGE);
			try {
				await request({ op: command, bot: rest[0] });
			} catch (error) {
				if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			}
			break;
		case "restart": {
			if (!rest[0]) throw new Error(USAGE);
			const reply = await request({ op: "restart", bot: rest[0], now: Boolean(opts.now) });
			console.log(reply.state === "asleep" ? `${rest[0]} is asleep; it starts fresh next time` : reply.state === "retrying" ? `${rest[0]} was down; trying to start it again` : reply.state === "restarting" ? `restarting ${rest[0]}` : `${rest[0]} restarts once its turn ends`);
			break;
		}
		case "holder": {
			if (!rest[0]) throw new Error(USAGE);
			let reply = { holder: null, pid: null };
			try {
				reply = await request({ op: "holder", bot: rest[0] }, 5000);
			} catch (error) {
				if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			}
			console.log(reply.holder ? `${reply.holder} ${reply.pid ?? ""}`.trim() : "none");
			break;
		}
		case "claim": {
			if (!rest[0]) throw new Error(USAGE);
			const notice = setTimeout(() => console.error(`Waiting for ${rest[0]} to finish its background task…`), 500);
			try {
				await request({ op: "claim", bot: rest[0] }, Number(opts.timeout ?? 600) * 1000);
			} catch (error) {
				if (!["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
			} finally {
				clearTimeout(notice);
			}
			break;
		}
		default:
			throw new Error(USAGE);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
