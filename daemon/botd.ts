import { Database } from "bun:sqlite";
import { createServer, type Socket } from "node:net";
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ROSTER, SOCKET, STATE } from "./paths";

const MAX_ATTEMPTS = Number(process.env.OMP_BOT_MAX_ATTEMPTS) || 3;
const IDLE_EXIT_MS = Number(process.env.OMP_BOT_IDLE_EXIT_MS) || 300_000;
const RESPAWN_MS = Number(process.env.OMP_BOT_RESPAWN_MS) || 5_000;
const CLAIM_MS = Number(process.env.OMP_BOT_CLAIM_MS) || 60_000;
const SILENT = "Nothing to report.";

type Task = { id: string; bot: string; key: string; text: string; origin: string | null; state: string; attempts: number; result: string | null; error: string | null; created: number; updated: number; seen: number };
type Link = { socket: Socket; bot: string; mode: "tui" | "headless"; idle: boolean; task?: string; closing?: boolean };
type Child = { proc: ReturnType<typeof Bun.spawn>; idleTimer?: ReturnType<typeof setTimeout> };

mkdirSync(join(STATE, "logs"), { recursive: true });
const db = new Database(join(STATE, "tasks.db"), { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
db.exec(`CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY, bot TEXT NOT NULL, key TEXT NOT NULL UNIQUE, text TEXT NOT NULL, origin TEXT,
	state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
	created INTEGER NOT NULL, updated INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0)`);
db.exec("CREATE INDEX IF NOT EXISTS tasks_queue ON tasks (bot, state, created)");

const q = {
	insert: db.query("INSERT INTO tasks (id, bot, key, text, origin, created, updated) VALUES ($id, $bot, $key, $text, $origin, $now, $now) ON CONFLICT (key) DO NOTHING"),
	byKey: db.query<Task, { key: string }>("SELECT * FROM tasks WHERE key = $key"),
	byId: db.query<Task, { id: string }>("SELECT * FROM tasks WHERE id = $id"),
	next: db.query<Task, { bot: string }>("SELECT * FROM tasks WHERE bot = $bot AND state = 'pending' ORDER BY created LIMIT 1"),
	pendingBots: db.query<{ bot: string }, []>("SELECT DISTINCT bot FROM tasks WHERE state = 'pending'"),
	lease: db.query("UPDATE tasks SET state = 'leased', attempts = attempts + 1, updated = $now WHERE id = $id AND state = 'pending'"),
	resume: db.query("UPDATE tasks SET state = 'leased', updated = $now WHERE id = $id AND state IN ('pending', 'leased')"),
	finish: db.query("UPDATE tasks SET state = 'done', result = $result, updated = $now WHERE id = $id AND state = 'leased'"),
	release: db.query("UPDATE tasks SET state = CASE WHEN attempts >= $max THEN 'failed' ELSE 'pending' END, error = $error, updated = $now WHERE id = $id AND state = 'leased'"),
	silent: db.query("UPDATE tasks SET seen = 1 WHERE id = $id AND state = 'done' AND trim(result) = $silent"),
	orphans: db.query("UPDATE tasks SET state = 'pending', updated = $now WHERE state = 'leased'"),
	list: db.query<Task, { state: string | null; bot: string | null; limit: number }>("SELECT * FROM tasks WHERE ($state IS NULL OR state = $state) AND ($bot IS NULL OR bot = $bot) ORDER BY created DESC LIMIT $limit"),
	inbox: db.query<Task, []>("SELECT * FROM tasks WHERE state IN ('done', 'failed') AND seen = 0 ORDER BY updated"),
	ack: db.query("UPDATE tasks SET seen = 1 WHERE id = $id AND state IN ('done', 'failed')"),
	retire: db.query("UPDATE tasks SET state = 'failed', error = 'bot removed', seen = 1, updated = $now WHERE bot = $bot AND state IN ('pending', 'leased')"),
};

const links = new Map<string, Link>();
const children = new Map<string, Child>();
const claims = new Map<string, { until: number; waiters: Array<() => void> }>();
const lastSpawn = new Map<string, number>();

function log(line: string) {
	console.log(`${new Date().toISOString()} ${line}`);
}

function roster(): Set<string> {
	return new Set((JSON.parse(readFileSync(ROSTER, "utf8")) as Array<{ name: string }>).map(bot => bot.name));
}

function send(socket: Socket, message: unknown) {
	if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
}

function claimed(bot: string): boolean {
	const claim = claims.get(bot);
	if (claim && claim.until > Date.now()) return true;
	claims.delete(bot);
	return false;
}

function dispatch(bot: string) {
	const link = links.get(bot);
	if (!link) return ensureRunning(bot);
	if (!link.idle || link.task || link.closing) return;
	const task = q.next.get({ bot });
	if (!task) return scheduleIdleExit(bot);
	q.lease.run({ id: task.id, now: Date.now() });
	link.idle = false;
	link.task = task.id;
	clearTimeout(children.get(bot)?.idleTimer);
	log(`lease ${task.id} -> ${bot} (${link.mode}, attempt ${task.attempts + 1})`);
	send(link.socket, { op: "task", id: task.id, attempt: task.attempts + 1, text: task.text, origin: task.origin });
}

function ensureRunning(bot: string) {
	if (links.has(bot) || children.has(bot) || claimed(bot) || !q.next.get({ bot })) return;
	const wait = (lastSpawn.get(bot) ?? 0) + RESPAWN_MS - Date.now();
	if (wait > 0) {
		setTimeout(() => ensureRunning(bot), wait);
		return;
	}
	lastSpawn.set(bot, Date.now());
	const logFile = join(STATE, "logs", `${bot}.log`);
	appendFileSync(logFile, `\n=== ${new Date().toISOString()} headless start\n`);
	const proc = Bun.spawn([join(ROOT, "bin", "omp-bot"), bot, "--headless"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
	const child: Child = { proc };
	children.set(bot, child);
	log(`spawn ${bot} pid ${proc.pid}`);
	(async () => {
		for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) appendFileSync(logFile, chunk);
	})().catch(() => {});
	proc.exited.then(code => {
		clearTimeout(child.idleTimer);
		if (children.get(bot) === child) children.delete(bot);
		log(`exit ${bot} pid ${proc.pid} code ${code}`);
		const link = links.get(bot);
		if (link?.mode === "headless") dropLink(link, `headless exited with ${code}`);
		settleClaim(bot);
		ensureRunning(bot);
	});
}

function scheduleIdleExit(bot: string) {
	const child = children.get(bot);
	const link = links.get(bot);
	if (!child || link?.mode !== "headless") return;
	clearTimeout(child.idleTimer);
	child.idleTimer = setTimeout(() => stopHeadless(bot), IDLE_EXIT_MS);
}

function stopHeadless(bot: string) {
	const child = children.get(bot);
	const link = links.get(bot);
	if (!child) return;
	if (link && (link.task || !link.idle)) {
		if (link) link.closing = true;
		return;
	}
	if (link) link.closing = true;
	log(`stop ${bot} pid ${child.proc.pid}`);
	try {
		(child.proc.stdin as import("bun").FileSink).end();
	} catch {}
}

function settleClaim(bot: string) {
	const claim = claims.get(bot);
	if (!claim || children.has(bot)) return;
	for (const waiter of claim.waiters.splice(0)) waiter();
}

function dropLink(link: Link, reason: string) {
	if (links.get(link.bot) !== link) return;
	links.delete(link.bot);
	if (link.task) {
		q.release.run({ id: link.task, error: reason, max: MAX_ATTEMPTS, now: Date.now() });
		log(`release ${link.task} from ${link.bot}: ${reason}`);
	}
	if (!link.socket.destroyed) link.socket.destroy();
	setTimeout(() => dispatch(link.bot), 0);
}

function enqueue(message: { bot?: string; text?: string; key?: string; origin?: string }) {
	if (!message.bot || !roster().has(message.bot)) throw new Error(`no bot named ${message.bot}`);
	if (!message.text?.trim()) throw new Error("empty task");
	const id = Bun.randomUUIDv7();
	const key = message.key || id;
	q.insert.run({ id, bot: message.bot, key, text: message.text, origin: message.origin ?? null, now: Date.now() });
	const task = q.byKey.get({ key })!;
	if (task.bot !== message.bot) throw new Error(`key ${key} already belongs to ${task.bot}`);
	const created = task.id === id;
	if (created) log(`enqueue ${task.id} for ${task.bot}${message.key ? ` key ${message.key}` : ""}`);
	dispatch(task.bot);
	return { id: task.id, created, state: task.state };
}

function handle(socket: Socket, message: any, self: { link?: Link }) {
	switch (message.op) {
		case "hello": {
			const existing = links.get(message.bot);
			if (existing && !existing.socket.destroyed) return send(socket, { op: "refused", reason: `${message.bot} is already connected` });
			const link: Link = { socket, bot: message.bot, mode: message.mode === "headless" ? "headless" : "tui", idle: false };
			links.set(link.bot, link);
			self.link = link;
			if (link.mode === "tui") claims.delete(link.bot);
			if (message.task) {
				const task = q.byId.get({ id: message.task });
				if (task && (task.state === "pending" || task.state === "leased")) {
					q.resume.run({ id: task.id, now: Date.now() });
					link.task = task.id;
					log(`resume ${task.id} on ${link.bot}`);
				}
			}
			log(`hello ${link.bot} (${link.mode})`);
			return send(socket, { op: "welcome", task: link.task ?? null });
		}
		case "ready": {
			const link = self.link;
			if (!link) return;
			link.idle = true;
			if (link.closing && link.mode === "headless") return stopHeadless(link.bot);
			return dispatch(link.bot);
		}
		case "busy": {
			if (self.link) self.link.idle = false;
			return;
		}
		case "done": {
			const link = self.link;
			if (!link) return;
			q.finish.run({ id: message.id, result: String(message.result ?? ""), now: Date.now() });
			q.silent.run({ id: message.id, silent: SILENT });
			if (link.task === message.id) link.task = undefined;
			log(`done ${message.id} by ${link.bot}`);
			return send(socket, { op: "ack", id: message.id });
		}
		case "fail": {
			const link = self.link;
			if (!link) return;
			q.release.run({ id: message.id, error: String(message.error ?? "failed"), max: message.final ? 0 : MAX_ATTEMPTS, now: Date.now() });
			if (link.task === message.id) link.task = undefined;
			log(`fail ${message.id} by ${link.bot}: ${message.error}`);
			return send(socket, { op: "ack", id: message.id });
		}
		case "enqueue":
			return send(socket, { ok: true, ...enqueue(message) });
		case "list":
			return send(socket, { ok: true, tasks: q.list.all({ state: message.state ?? null, bot: message.bot ?? null, limit: message.limit ?? 50 }) });
		case "inbox":
			return send(socket, { ok: true, tasks: q.inbox.all() });
		case "ack":
			q.ack.run({ id: message.id });
			return send(socket, { ok: true });
		case "status":
			return send(socket, {
				ok: true,
				bots: [...roster()].map(bot => ({ bot, link: links.get(bot)?.mode ?? null, task: links.get(bot)?.task ?? null, headless: children.get(bot)?.proc.pid ?? null })),
			});
		case "retire": {
			const bot = message.bot;
			q.retire.run({ bot, now: Date.now() });
			claims.set(bot, { until: Number.POSITIVE_INFINITY, waiters: [] });
			const link = links.get(bot);
			if (link) link.task = undefined;
			children.get(bot)?.proc.kill("SIGTERM");
			log(`retire ${bot}`);
			return send(socket, { ok: true });
		}
		case "unretire":
			claims.delete(message.bot);
			return send(socket, { ok: true });
		case "claim": {
			const bot = message.bot;
			const claim = { until: Date.now() + CLAIM_MS, waiters: [] as Array<() => void> };
			claims.set(bot, claim);
			setTimeout(() => ensureRunning(bot), CLAIM_MS + 100);
			if (!children.has(bot)) return send(socket, { ok: true });
			claim.waiters.push(() => send(socket, { ok: true }));
			log(`claim ${bot}: waiting for headless to finish`);
			return stopHeadless(bot);
		}
		default:
			return send(socket, { ok: false, error: `unknown op ${message.op}` });
	}
}

if (existsSync(SOCKET)) unlinkSync(SOCKET);
q.orphans.run({ now: Date.now() });

const server = createServer(socket => {
	const self: { link?: Link } = {};
	let buffer = "";
	socket.setEncoding("utf8");
	socket.on("data", chunk => {
		buffer += chunk;
		let nl: number;
		while ((nl = buffer.indexOf("\n")) >= 0) {
			const line = buffer.slice(0, nl).trim();
			buffer = buffer.slice(nl + 1);
			if (!line) continue;
			try {
				handle(socket, JSON.parse(line), self);
			} catch (error) {
				send(socket, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		}
	});
	const close = () => self.link && dropLink(self.link, "connection lost");
	socket.on("close", close);
	socket.on("error", close);
});

server.listen(SOCKET, () => {
	log(`listening on ${SOCKET}`);
	for (const { bot } of q.pendingBots.all()) ensureRunning(bot);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
	process.on(signal, () => {
		log(`${signal}: stopping`);
		server.close();
		for (const child of children.values()) child.proc.kill("SIGTERM");
		db.close();
		process.exit(0);
	});
}
