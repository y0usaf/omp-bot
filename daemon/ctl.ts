import { connect } from "node:net";
import { SOCKET } from "./paths";

const USAGE = `usage: omp-bot-ctl COMMAND
  task BOT TEXT [--key KEY] [--origin ORIGIN]   queue a task; the same KEY never queues twice
  tasks [--bot BOT] [--state STATE]             recent tasks
  inbox                                         finished and failed tasks not yet acknowledged
  ack ID                                        acknowledge an inbox task
  status                                        which bots are connected, and how
  claim BOT                                     wait until BOT's headless run has stopped`;

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
		if (args[i].startsWith("--")) opts[args[i].slice(2)] = args[++i];
		else rest.push(args[i]);
	}
	return { rest, opts };
}

function line(task: any): string {
	const when = new Date(task.updated).toISOString().replace("T", " ").slice(0, 19);
	const body = (task.state === "failed" ? task.error : task.result ?? task.text) ?? "";
	return `${task.id}  ${task.bot}  ${task.state}  attempt ${task.attempts}  ${when}\n  ${String(body).trim().replace(/\n/g, "\n  ")}`;
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
		case "status":
			for (const bot of (await request({ op: "status" })).bots) console.log(`${bot.bot}  ${bot.link ?? "asleep"}${bot.task ? `  working on ${bot.task}` : ""}`);
			break;
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
