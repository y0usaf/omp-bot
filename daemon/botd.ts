import { Database } from "bun:sqlite";
import { createServer, type Socket } from "node:net";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ROSTER, SOCKET, STATE } from "./paths";
import { record } from "./gate";

const MAX_ATTEMPTS = Number(process.env.OMP_BOT_MAX_ATTEMPTS) || 3;
const IDLE_EXIT_MS = Number(process.env.OMP_BOT_IDLE_EXIT_MS) || 300_000;
const RESPAWN_MS = Number(process.env.OMP_BOT_RESPAWN_MS) || 5_000;
const HELD_MAX_MS = Number(process.env.OMP_BOT_HELD_MAX_MS) || 300_000;
const CLAIM_MS = Number(process.env.OMP_BOT_CLAIM_MS) || 60_000;
const HEARTBEAT_MS = Number(process.env.OMP_BOT_HEARTBEAT_MS) || 30_000;
const MEMORY_POLL_MS = Number(process.env.OMP_BOT_MEMORY_POLL_MS) || 5_000;
const MEMORY_RETRY_MS = 60_000;
const DRAIN_MS = Number(process.env.OMP_BOT_DRAIN_MS) || 120_000;
const MAX_STARTS = Number(process.env.OMP_BOT_MAX_STARTS) || 3;
const HEALTH_MS = Number(process.env.OMP_BOT_HEALTH_MS) || 60_000;
const HEALTH_TIMEOUT_MS = 30_000;
const SILENT = "Nothing to report.";
const ACTIONS = { approve: "approved", deny: "denied", handle: "left it to you to decide" } as const;

type Task = { id: string; bot: string; key: string; text: string; origin: string | null; state: string; attempts: number; result: string | null; error: string | null; created: number; updated: number; seen: number; token: string | null; beat: number | null; wait: string | null; question: string | null; answer: string | null };
type Link = { socket: Socket; bot: string; mode: "tui" | "headless"; pid?: number; idle: boolean; task?: string; token?: string; closing?: boolean };
type Child = { proc: ReturnType<typeof Bun.spawn>; idleTimer?: ReturnType<typeof setTimeout>; hello?: boolean; tail: string };
type Down = { reason: string; since: number; cause: "start" | "box" };

mkdirSync(join(STATE, "logs"), { recursive: true });
const db = new Database(join(STATE, "tasks.db"), { create: true, strict: true });
db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
db.exec(`CREATE TABLE IF NOT EXISTS tasks (
	id TEXT PRIMARY KEY, bot TEXT NOT NULL, key TEXT NOT NULL UNIQUE, text TEXT NOT NULL, origin TEXT,
	state TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
	created INTEGER NOT NULL, updated INTEGER NOT NULL, seen INTEGER NOT NULL DEFAULT 0,
	token TEXT, beat INTEGER, wait TEXT, question TEXT, answer TEXT)`);
const columns = new Set(db.query<{ name: string }, []>("SELECT name FROM pragma_table_info('tasks')").all().map(column => column.name));
for (const column of ["token TEXT", "beat INTEGER", "wait TEXT", "question TEXT", "answer TEXT"]) if (!columns.has(column.split(" ")[0])) db.exec(`ALTER TABLE tasks ADD COLUMN ${column}`);
db.exec("UPDATE tasks SET state = 'queued' WHERE state IN ('pending', 'leased')");
db.exec("CREATE INDEX IF NOT EXISTS tasks_queue ON tasks (bot, state, created)");
db.exec(`CREATE TABLE IF NOT EXISTS subagents (
	bot TEXT NOT NULL, id TEXT NOT NULL, task TEXT, agent TEXT, description TEXT, status TEXT NOT NULL,
	started INTEGER NOT NULL, ended INTEGER)`);
db.exec("CREATE INDEX IF NOT EXISTS subagents_running ON subagents (bot, status, id)");

const HELD = "(state = 'running' OR (state = 'waiting' AND wait = 'jobs'))";
const q = {
	insert: db.query("INSERT INTO tasks (id, bot, key, text, origin, state, created, updated) VALUES ($id, $bot, $key, $text, $origin, 'queued', $now, $now) ON CONFLICT (key) DO NOTHING"),
	byKey: db.query<Task, { key: string }>("SELECT * FROM tasks WHERE key = $key"),
	byId: db.query<Task, { id: string }>("SELECT * FROM tasks WHERE id = $id"),
	next: db.query<Task, { bot: string }>("SELECT * FROM tasks WHERE bot = $bot AND state = 'queued' ORDER BY created LIMIT 1"),
	queuedBots: db.query<{ bot: string }, []>("SELECT DISTINCT bot FROM tasks WHERE state = 'queued'"),
	lease: db.query("UPDATE tasks SET state = 'running', attempts = attempts + 1, token = $token, beat = $now, wait = NULL, updated = $now WHERE id = $id AND state = 'queued'"),
	resume: db.query(`UPDATE tasks SET state = CASE WHEN state = 'queued' THEN 'running' ELSE state END, beat = $now, updated = $now WHERE id = $id AND token = $token AND (state = 'queued' OR ${HELD})`),
	beat: db.query(`UPDATE tasks SET beat = $now WHERE id = $id AND token = $token AND ${HELD}`),
	finish: db.query(`UPDATE tasks SET state = 'done', result = $result, wait = NULL, updated = $now WHERE id = $id AND token = $token AND ${HELD}`),
	release: db.query(`UPDATE tasks SET state = CASE WHEN attempts >= $max THEN 'failed' ELSE 'queued' END, wait = NULL, error = $error, updated = $now WHERE id = $id AND token IS $token AND ${HELD}`),
	wait: db.query(`UPDATE tasks SET state = 'waiting', wait = $wait, question = $question, result = $result, seen = CASE WHEN $wait = 'decision' THEN 0 ELSE seen END, updated = $now WHERE id = $id AND token = $token AND ${HELD}`),
	answer: db.query("UPDATE tasks SET state = 'queued', attempts = 0, answer = $answer, wait = NULL, seen = 1, updated = $now WHERE id = $id AND state = 'waiting' AND wait = 'decision'"),
	silent: db.query("UPDATE tasks SET seen = 1 WHERE id = $id AND state = 'done' AND trim(result) = $silent"),
	silentHeld: db.query<Task, { before: number }>(`SELECT * FROM tasks WHERE ${HELD} AND beat < $before`),
	held: db.query<Task, []>(`SELECT * FROM tasks WHERE ${HELD}`),
	decisions: db.query<Task, { bot: string }>("SELECT * FROM tasks WHERE bot = $bot AND state = 'waiting' AND wait = 'decision' ORDER BY updated"),
	grace: db.query(`UPDATE tasks SET beat = $now WHERE ${HELD}`),
	list: db.query<Task, { state: string | null; bot: string | null; limit: number }>("SELECT * FROM tasks WHERE ($state IS NULL OR state = $state) AND ($bot IS NULL OR bot = $bot) ORDER BY created DESC LIMIT $limit"),
	inbox: db.query<Task, []>("SELECT * FROM tasks WHERE (state IN ('done', 'failed') OR (state = 'waiting' AND wait = 'decision')) AND seen = 0 ORDER BY updated"),
	ack: db.query("UPDATE tasks SET seen = 1 WHERE id = $id AND state IN ('done', 'failed')"),
	retire: db.query("UPDATE tasks SET state = 'failed', error = 'bot removed', seen = 1, updated = $now WHERE bot = $bot AND state IN ('queued', 'running', 'waiting')"),
	queued: db.query<Task, { bot: string }>("SELECT * FROM tasks WHERE bot = $bot AND state = 'queued'"),
	drop: db.query("UPDATE tasks SET state = 'failed', error = $error, updated = $now WHERE id = $id AND state = 'queued'"),
	notice: db.query("INSERT INTO tasks (id, bot, key, text, origin, state, result, error, created, updated) VALUES ($id, $bot, $key, $text, 'botd', $state, $result, $error, $now, $now)"),
	subStart: db.query("INSERT INTO subagents (bot, id, task, agent, description, status, started) VALUES ($bot, $id, $task, $agent, $description, 'running', $started)"),
	subNote: db.query("UPDATE subagents SET description = coalesce(nullif($description, ''), description), task = coalesce(task, $task) WHERE bot = $bot AND id = $id AND status = 'running'"),
	subRevive: db.query("UPDATE subagents SET status = 'running', ended = NULL, description = coalesce(nullif($description, ''), description) WHERE rowid = (SELECT rowid FROM subagents WHERE bot = $bot AND id = $id AND status = 'stopped' ORDER BY started DESC LIMIT 1)"),
	subEnd: db.query("UPDATE subagents SET status = $status, description = coalesce(nullif($description, ''), description), ended = $now WHERE bot = $bot AND id = $id AND status = 'running'"),
	subGone: db.query("UPDATE subagents SET status = 'stopped', ended = $now WHERE bot = $bot AND status = 'running' AND id NOT IN (SELECT value FROM json_each($keep))"),
	subRunning: db.query("SELECT * FROM subagents WHERE status = 'running' ORDER BY bot, id"),
	subFinished: db.query("SELECT * FROM subagents WHERE status != 'running' ORDER BY ended DESC LIMIT $limit"),
	subPrune: db.query("DELETE FROM subagents WHERE status != 'running' AND ended < $before"),
};

const links = new Map<string, Link>();
const children = new Map<string, Child>();
const claims = new Map<string, { until: number; waiters: Array<() => void> }>();
const nextSpawn = new Map<string, number>();
const held = new Map<string, number>();
const summarisers = new Map<string, ReturnType<typeof Bun.spawn>>();
const memoryRetry = new Map<string, number>();
const restarts = new Map<string, { now: boolean }>();
const respawn = new Set<string>();
const dying = new Map<string, number>();
const resumes = new Map<string, number>();
const down = new Map<string, Down>();
const startFails = new Map<string, number>();
let boxHealthy: boolean | undefined;
let boxedBots = new Set<string>();
let draining = false;

function log(line: string) {
	console.log(`${new Date().toISOString()} ${line}`);
}

function savedTask(bot: string): { id?: string; mode?: string } | undefined {
	try {
		return JSON.parse(readFileSync(join(STATE, "bots", bot, "task.json"), "utf8"));
	} catch {
		return undefined;
	}
}

function boxed(): string[] {
	try {
		return (JSON.parse(readFileSync(ROSTER, "utf8")) as Array<{ name: string; box?: boolean }>).filter(bot => bot.box === true).map(bot => bot.name);
	} catch {
		return [];
	}
}

function lastLine(text: string): string {
	return text.split("\n").map(line => line.trim()).filter(Boolean).at(-1) ?? "";
}

function markDown(bot: string, reason: string, cause: Down["cause"]) {
	const was = down.get(bot);
	if (was && (was.cause === cause || was.cause === "box")) return;
	const now = Date.now();
	down.set(bot, { reason, since: now, cause });
	log(`down ${bot}: ${reason}`);
	q.notice.run({ id: Bun.randomUUIDv7(), bot, key: `down-${bot}-${now}`, text: `${bot} is down`, state: "failed", result: null, error: reason, now });
	for (const task of q.queued.all({ bot })) {
		q.drop.run({ id: task.id, error: `${bot} is down: ${reason}`, now });
		log(`drop ${task.id} for ${bot}: down`);
		replyToOrigin(task.id);
	}
}

function clearDown(bot: string, why: string, announce = true) {
	startFails.delete(bot);
	const was = down.get(bot);
	if (!was) return;
	down.delete(bot);
	const now = Date.now();
	log(`up ${bot}: ${why}`);
	if (announce) q.notice.run({ id: Bun.randomUUIDv7(), bot, key: `up-${bot}-${now}`, text: `${bot} is back`, state: "done", result: `${bot} is back (${why}); it was down since ${new Date(was.since).toISOString()}: ${was.reason}`, error: null, now });
}

let probing = false;
async function checkHealth() {
	const bots = boxed();
	boxedBots = new Set(bots);
	if (probing || draining || bots.length === 0) return;
	probing = true;
	try {
		const proc = Bun.spawn([join(ROOT, "bin", "omp-bot-health")], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		const timer = setTimeout(() => proc.kill("SIGKILL"), HEALTH_TIMEOUT_MS);
		const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		clearTimeout(timer);
		if (code === 2) {
			if (boxHealthy !== undefined) log(`box ${lastLine(out) || "is starting"}`);
			boxHealthy = undefined;
			return;
		}
		const healthy = code === 0;
		const reason = lastLine(out) || lastLine(err) || (proc.signalCode ? `health check timed out after ${HEALTH_TIMEOUT_MS / 1000}s` : `health check exited ${code}`);
		if (healthy !== boxHealthy) log(`box ${healthy ? "healthy" : `unhealthy: ${reason}`}`);
		for (const bot of bots) {
			if (!healthy) {
				if (!links.has(bot)) markDown(bot, `its box is down: ${reason}`, "box");
			}
			else if (down.get(bot)?.cause === "box" || (boxHealthy === false && down.has(bot))) clearDown(bot, "its box answers again");
		}
		const was = boxHealthy;
		boxHealthy = healthy;
		if (healthy && was !== true) for (const bot of bots) dispatch(bot);
	} finally {
		probing = false;
	}
}

function roster(): Set<string> {
	return new Set((JSON.parse(readFileSync(ROSTER, "utf8")) as Array<{ name: string }>).map(bot => bot.name));
}

function memoryBots(): string[] {
	try {
		return (JSON.parse(readFileSync(ROSTER, "utf8")) as Array<{ name: string; memory?: string }>)
			.filter(bot => (bot.memory ?? "optchat") === "optchat" && claims.get(bot.name)?.until !== Number.POSITIVE_INFINITY)
			.map(bot => bot.name);
	} catch {
		return [];
	}
}

function behind(bot: string): boolean {
	const dir = join(STATE, "bots", bot, "optchat");
	let logs: string[];
	try {
		logs = readdirSync(join(dir, "log"));
	} catch {
		return false;
	}
	let since: number;
	try {
		if (!JSON.parse(readFileSync(join(dir, "view.json"), "utf8")).built) return true;
		since = statSync(join(dir, "view.json")).mtimeMs;
	} catch {
		return logs.length > 0;
	}
	return logs.some(name => statSync(join(dir, "log", name)).mtimeMs > since);
}

function startSummariser(bot: string) {
	const logFile = join(STATE, "logs", `${bot}.optchat.log`);
	appendFileSync(logFile, `\n=== ${new Date().toISOString()} summariser start\n`);
	const proc = Bun.spawn(["setsid", join(ROOT, "bin", "omp-bot-memory"), bot], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
	summarisers.set(bot, proc);
	log(`memory ${bot} pid ${proc.pid}`);
	(async () => {
		for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) appendFileSync(logFile, chunk);
	})().catch(() => {});
	proc.exited.then(code => {
		log(`memory exit ${bot} pid ${proc.pid} code ${code}`);
		if (summarisers.get(bot) !== proc) return;
		summarisers.delete(bot);
		if (code !== 0) memoryRetry.set(bot, Date.now() + MEMORY_RETRY_MS);
	});
}

function stopSummariser(bot: string) {
	const proc = summarisers.get(bot);
	if (!proc) return;
	summarisers.delete(bot);
	log(`memory stop ${bot} pid ${proc.pid}`);
	killGroup(proc.pid);
}

function tendMemory() {
	const want = new Set(memoryBots().filter(bot => links.has(bot) || children.has(bot) || behind(bot)));
	for (const bot of summarisers.keys()) if (!want.has(bot)) stopSummariser(bot);
	for (const bot of want) if (!summarisers.has(bot) && (memoryRetry.get(bot) ?? 0) <= Date.now()) startSummariser(bot);
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
	if (restarts.has(bot)) return tendRestart(bot);
	if (!link.idle || link.task || link.closing || draining) return;
	const task = q.next.get({ bot });
	if (!task) return scheduleIdleExit(bot);
	const token = crypto.randomUUID();
	q.lease.run({ id: task.id, token, now: Date.now() });
	link.idle = false;
	link.task = task.id;
	link.token = token;
	clearTimeout(children.get(bot)?.idleTimer);
	log(`lease ${task.id} -> ${bot} (${link.mode}, attempt ${task.attempts + 1})`);
	send(link.socket, { op: "task", id: task.id, attempt: task.attempts + 1, token, text: task.text, origin: task.origin, answer: task.answer ? JSON.parse(task.answer) : null });
}

function ensureRunning(bot: string, force = false) {
	if (draining || down.has(bot) || (boxedBots.has(bot) && boxHealthy !== true) || links.has(bot) || children.has(bot) || claimed(bot) || (!force && !q.next.get({ bot }))) return;
	const wait = (nextSpawn.get(bot) ?? 0) - Date.now();
	if (wait > 0) {
		setTimeout(() => ensureRunning(bot, force), wait);
		return;
	}
	nextSpawn.set(bot, Date.now() + RESPAWN_MS);
	const logFile = join(STATE, "logs", `${bot}.log`);
	appendFileSync(logFile, `\n=== ${new Date().toISOString()} headless start\n`);
	const proc = Bun.spawn(["setsid", join(ROOT, "bin", "omp-bot"), bot, "--headless"], { stdin: "pipe", stdout: "ignore", stderr: "pipe" });
	const child: Child = { proc, tail: "" };
	children.set(bot, child);
	log(`spawn ${bot} pid ${proc.pid}`);
	const decoder = new TextDecoder();
	const output = (async () => {
		for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
			appendFileSync(logFile, chunk);
			child.tail = (child.tail + decoder.decode(chunk, { stream: true })).slice(-4000);
		}
	})().catch(() => {});
	proc.exited.then(async code => {
		await output;
		clearTimeout(child.idleTimer);
		if (children.get(bot) === child) children.delete(bot);
		log(`exit ${bot} pid ${proc.pid} code ${code}`);
		const link = links.get(bot);
		if (link?.mode === "headless") dropLink(link, `headless exited with ${code}`);
		settleClaim(bot);
		if (code === 75) {
			const tries = (held.get(bot) ?? 0) + 1;
			const wait = Math.min(RESPAWN_MS * 2 ** tries, HELD_MAX_MS);
			held.set(bot, tries);
			nextSpawn.set(bot, Date.now() + wait);
			log(`start ${bot} skipped: its lock is held, so it is open elsewhere; trying again in ${wait / 1000}s unless it connects first`);
		}
		else if (!child.hello && code !== 0 && !draining) {
			const fails = (startFails.get(bot) ?? 0) + 1;
			startFails.set(bot, fails);
			const why = lastLine(child.tail) || `exit code ${code}`;
			log(`start ${bot} failed (${fails} of ${MAX_STARTS}): ${why}`);
			if (fails >= MAX_STARTS) markDown(bot, `it failed to start ${fails} times in a row: ${why}`, "start");
		}
		ensureRunning(bot, respawn.delete(bot));
	});
}

function killGroup(pid: number) {
	try {
		process.kill(-pid, "SIGTERM");
	} catch {}
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

function hold(bot: string) {
	claims.set(bot, { until: Date.now() + CLAIM_MS, waiters: claims.get(bot)?.waiters ?? [] });
	setTimeout(() => ensureRunning(bot), CLAIM_MS + 100);
}

function tendRestart(bot: string): "waiting" | "restarting" {
	const want = restarts.get(bot);
	const link = links.get(bot);
	if (!want || !link || (!want.now && (link.task || !link.idle))) return "waiting";
	restarts.delete(bot);
	link.closing = true;
	if (link.mode === "headless") respawn.add(bot);
	else hold(bot);
	log(`restart ${bot} (${link.mode})${want.now && link.task ? `, dropping ${link.task}` : ""}`);
	send(link.socket, { op: "restart", now: want.now });
	if (link.mode === "headless") {
		try {
			(children.get(bot)?.proc.stdin as import("bun").FileSink | undefined)?.end();
		} catch {}
	}
	return "restarting";
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function settleClaim(bot: string) {
	const claim = claims.get(bot);
	if (!claim || children.has(bot)) return;
	for (const waiter of claim.waiters.splice(0)) waiter();
}

function dropLink(link: Link, reason: string) {
	if (links.get(link.bot) !== link) return;
	links.delete(link.bot);
	if (link.mode === "tui" && link.pid) dying.set(link.bot, link.pid);
	if (link.task && !link.closing && (link.mode === "tui" || (resumes.get(link.task) ?? 0) < MAX_ATTEMPTS)) {
		const { task: id, token } = link;
		if (link.mode === "tui") hold(link.bot);
		else {
			resumes.set(id, (resumes.get(id) ?? 0) + 1);
			respawn.add(link.bot);
			setTimeout(() => children.has(link.bot) || ensureRunning(link.bot, respawn.delete(link.bot)), 0);
		}
		log(`keep ${id} for ${link.bot} to resume: ${reason}`);
		setTimeout(() => {
			if (links.get(link.bot)?.task === id) return;
			resumes.delete(id);
			if (!q.release.run({ id, token: token ?? null, error: `${reason}, and ${link.bot} did not come back to resume it`, max: MAX_ATTEMPTS, now: Date.now() }).changes) return;
			log(`release ${id} from ${link.bot}: not resumed`);
			dispatch(link.bot);
		}, CLAIM_MS);
	} else if (link.task) {
		q.release.run({ id: link.task, token: link.token ?? null, error: reason, max: MAX_ATTEMPTS, now: Date.now() });
		log(`release ${link.task} from ${link.bot}: ${reason}`);
	}
	q.subGone.run({ bot: link.bot, keep: "[]", now: Date.now() });
	if (!link.socket.destroyed) link.socket.destroy();
	setTimeout(() => dispatch(link.bot), 0);
}

function subagent(bot: string, task: unknown, sub: any) {
	const id = String(sub?.id ?? "");
	if (!id) return;
	const now = Date.now();
	const fields = { bot, id, description: String(sub.description ?? ""), task: typeof task === "string" ? task : null };
	if (sub.status === "running") {
		if (!q.subNote.run(fields).changes && !q.subRevive.run({ bot, id, description: fields.description }).changes) q.subStart.run({ ...fields, agent: String(sub.agent ?? ""), started: Number(sub.started) || now });
	} else if (["done", "failed", "stopped"].includes(sub.status)) {
		q.subEnd.run({ bot, id, description: fields.description, status: sub.status, now });
		q.subPrune.run({ before: now - 7 * 86_400_000 });
	}
}

function pushDecisions(bot: string) {
	const link = links.get(bot);
	if (link?.mode !== "tui") return;
	send(link.socket, { op: "decisions", tasks: q.decisions.all({ bot }).map(task => ({ id: task.id, question: task.question, text: task.text })) });
}

function stale(socket: Socket, link: Link, message: any) {
	log(`ignore ${message.op} for ${message.id} from ${link.bot}: not the current attempt`);
	if (link.task === message.id) link.task = link.token = undefined;
	send(socket, { op: "expired", id: message.id });
}

function expire() {
	const now = Date.now();
	for (const task of q.silentHeld.all({ before: now - 3 * HEARTBEAT_MS })) {
		q.release.run({ id: task.id, token: task.token, error: "its attempt missed three check-ins", max: MAX_ATTEMPTS, now });
		log(`expire ${task.id} attempt ${task.attempts}: no check-in`);
		const link = links.get(task.bot);
		if (link?.task === task.id) {
			link.task = link.token = undefined;
			send(link.socket, { op: "expired", id: task.id });
		}
		dispatch(task.bot);
	}
}

function enqueue(message: { bot?: string; text?: string; key?: string; origin?: string }) {
	if (!message.bot || !roster().has(message.bot)) throw new Error(`no bot named ${message.bot}`);
	if (!message.text?.trim()) throw new Error("empty task");
	const isDown = down.get(message.bot);
	if (isDown) throw new Error(`${message.bot} is down: ${isDown.reason} (omp-bot-ctl restart ${message.bot} to try again)`);
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

function replyToOrigin(id: string) {
	const task = q.byId.get({ id });
	if (!task?.origin?.startsWith("bot:") || (task.state !== "done" && task.state !== "failed")) return;
	const to = task.origin.slice(4);
	if (!roster().has(to)) return log(`reply ${id}: no bot named ${to}`);
	const body = task.state === "done" ? String(task.result ?? "").trim() : `It failed: ${task.error}`;
	q.ack.run({ id });
	enqueue({ bot: to, text: `Reply from ${task.bot} to your task ${id}:\n\n${body}`, key: `reply-${id}`, origin: `reply:${task.bot}` });
}

function handle(socket: Socket, message: any, self: { link?: Link }) {
	switch (message.op) {
		case "hello": {
			const existing = links.get(message.bot);
			if (existing && !existing.socket.destroyed) return send(socket, { op: "refused", reason: `${message.bot} is already connected` });
			const link: Link = { socket, bot: message.bot, mode: message.mode === "headless" ? "headless" : "tui", pid: Number(message.pid) || undefined, idle: false };
			links.set(link.bot, link);
			self.link = link;
			if (link.mode === "tui") claims.delete(link.bot);
			dying.delete(link.bot);
			if (held.delete(link.bot)) nextSpawn.delete(link.bot);
			const child = children.get(link.bot);
			if (child && link.mode === "headless") child.hello = true;
			clearDown(link.bot, `it connected (${link.mode})`);
			if (draining && link.mode === "headless") link.closing = true;
			if (message.task && q.resume.run({ id: String(message.task), token: String(message.token ?? ""), now: Date.now() }).changes) {
				link.task = message.task;
				link.token = message.token;
				log(`resume ${link.task} on ${link.bot}`);
			}
			log(`hello ${link.bot} (${link.mode})`);
			tendMemory();
			send(socket, { op: "welcome", task: link.task ?? null });
			return pushDecisions(link.bot);
		}
		case "ready": {
			const link = self.link;
			if (!link) return;
			link.idle = true;
			if (restarts.has(link.bot)) return void tendRestart(link.bot);
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
			if (!q.finish.run({ id: message.id, token: String(message.token ?? ""), result: String(message.result ?? ""), now: Date.now() }).changes) return stale(socket, link, message);
			q.silent.run({ id: message.id, silent: SILENT });
			resumes.delete(message.id);
			if (link.task === message.id) link.task = link.token = undefined;
			log(`done ${message.id} by ${link.bot}`);
			replyToOrigin(message.id);
			return send(socket, { op: "ack", id: message.id });
		}
		case "fail": {
			const link = self.link;
			if (!link) return;
			if (!q.release.run({ id: message.id, token: String(message.token ?? ""), error: String(message.error ?? "failed"), max: message.final ? 0 : MAX_ATTEMPTS, now: Date.now() }).changes) return stale(socket, link, message);
			resumes.delete(message.id);
			if (link.task === message.id) link.task = link.token = undefined;
			log(`fail ${message.id} by ${link.bot}: ${message.error}`);
			replyToOrigin(message.id);
			return send(socket, { op: "ack", id: message.id });
		}
		case "beat": {
			const link = self.link;
			if (!link) return;
			if (!q.beat.run({ id: message.id, token: String(message.token ?? ""), now: Date.now() }).changes) return stale(socket, link, message);
			return;
		}
		case "wait": {
			const link = self.link;
			if (!link) return;
			const wait = message.wait === "decision" ? "decision" : "jobs";
			const question = wait === "decision" ? String(message.question ?? "").trim() || "(no question given)" : null;
			if (!q.wait.run({ id: message.id, token: String(message.token ?? ""), wait, question, result: String(message.result ?? ""), now: Date.now() }).changes) return stale(socket, link, message);
			if (wait === "decision" && link.task === message.id) link.task = link.token = undefined;
			log(`wait ${message.id} on ${wait} by ${link.bot}`);
			send(socket, { op: "ack", id: message.id });
			return wait === "decision" ? pushDecisions(link.bot) : undefined;
		}
		case "answer": {
			const action = String(message.action) as keyof typeof ACTIONS;
			if (!(action in ACTIONS)) throw new Error(`answer is approve, deny or handle, not ${message.action}`);
			const task = q.byId.get({ id: String(message.id) });
			if (!task || task.state !== "waiting" || task.wait !== "decision") throw new Error(`task ${message.id} isn't waiting on a decision`);
			q.answer.run({ id: task.id, answer: JSON.stringify({ action, question: task.question, note: String(message.note ?? "").trim() || null }), now: Date.now() });
			log(`answer ${task.id}: ${action}`);
			pushDecisions(task.bot);
			dispatch(task.bot);
			return send(socket, { ok: true, state: "queued" });
		}
		case "subagent":
			if (self.link) subagent(self.link.bot, message.task, message);
			return;
		case "subagents_now": {
			const link = self.link;
			if (!link) return;
			const running = Array.isArray(message.running) ? message.running : [];
			q.subGone.run({ bot: link.bot, keep: JSON.stringify(running.map(sub => String(sub?.id ?? ""))), now: Date.now() });
			for (const sub of running) subagent(link.bot, message.task, { ...sub, status: "running" });
			return;
		}
		case "subagents":
			return send(socket, { ok: true, running: q.subRunning.all(), finished: q.subFinished.all({ limit: message.limit ?? 40 }) });
		case "enqueue":
			return send(socket, { ok: true, ...enqueue(message) });
		case "list":
			return send(socket, { ok: true, tasks: q.list.all({ state: message.state ?? null, bot: message.bot ?? null, limit: message.limit ?? 50 }) });
		case "inbox":
			return send(socket, { ok: true, tasks: q.inbox.all() });
		case "event": {
			const decision = record({ source: String(message.source ?? "unknown"), kind: String(message.kind ?? ""), payload: message.payload ?? {} });
			log(`event ${message.kind} from ${message.source}: ${decision.rule ?? "no rule"}`);
			return send(socket, { ok: true, ...decision });
		}
		case "ack":
			q.ack.run({ id: message.id });
			return send(socket, { ok: true });
		case "status":
			return send(socket, {
				ok: true,
				bots: [...roster()].map(bot => ({ bot, link: links.get(bot)?.mode ?? null, task: links.get(bot)?.task ?? null, headless: children.get(bot)?.proc.pid ?? null, down: down.get(bot) ?? null })),
			});
		case "retire": {
			const bot = message.bot;
			q.retire.run({ bot, now: Date.now() });
			claims.set(bot, { until: Number.POSITIVE_INFINITY, waiters: [] });
			const link = links.get(bot);
			if (link) link.task = link.token = undefined;
			const child = children.get(bot);
			if (child) killGroup(child.proc.pid);
			stopSummariser(bot);
			log(`retire ${bot}`);
			return send(socket, { ok: true });
		}
		case "unretire":
			claims.delete(message.bot);
			return send(socket, { ok: true });
		case "restart": {
			const bot = message.bot;
			if (!roster().has(bot)) throw new Error(`no bot named ${bot}`);
			if (down.has(bot)) {
				clearDown(bot, "restart requested", false);
				ensureRunning(bot, true);
				return send(socket, { ok: true, state: "retrying" });
			}
			if (!links.has(bot) && !children.has(bot)) return send(socket, { ok: true, state: "asleep" });
			const now = Boolean(message.now) || restarts.get(bot)?.now === true;
			restarts.set(bot, { now });
			log(`restart ${bot} requested${now ? " now" : ""}`);
			return send(socket, { ok: true, state: tendRestart(bot) });
		}
		case "holder": {
			const bot = message.bot;
			const link = links.get(bot);
			if (link?.mode === "tui") return send(socket, { ok: true, holder: link.closing ? "dying" : "tui", pid: link.pid ?? null });
			if (link || children.has(bot)) return send(socket, { ok: true, holder: "headless", pid: children.get(bot)?.proc.pid ?? link?.pid ?? null });
			const pid = dying.get(bot);
			if (pid && alive(pid)) return send(socket, { ok: true, holder: "dying", pid });
			dying.delete(bot);
			return send(socket, { ok: true, holder: null, pid: null });
		}
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
q.grace.run({ now: Date.now() });

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
	for (const { bot } of q.queuedBots.all()) ensureRunning(bot);
	for (const task of q.held.all()) {
		const saved = savedTask(task.bot);
		if (saved?.id === task.id && saved.mode === "headless") ensureRunning(task.bot, true);
	}
	tendMemory();
	setInterval(tendMemory, MEMORY_POLL_MS);
	setInterval(expire, HEARTBEAT_MS / 2);
	void checkHealth();
	setInterval(() => void checkHealth(), HEALTH_MS);
});

function stop() {
	server.close();
	for (const child of children.values()) killGroup(child.proc.pid);
	for (const proc of summarisers.values()) killGroup(proc.pid);
	db.close();
	process.exit(0);
}

function drain(signal: string) {
	if (draining) {
		log(`${signal} again: stopping now`);
		return stop();
	}
	draining = true;
	const busy = [...links.values()].filter(link => link.mode === "headless" && link.task).map(link => link.bot);
	log(`${signal}: draining${busy.length ? `, waiting up to ${DRAIN_MS / 1000}s for ${busy.join(", ")}` : ""}`);
	for (const bot of children.keys()) stopHeadless(bot);
	setTimeout(() => {
		log("drain timed out: stopping");
		stop();
	}, DRAIN_MS).unref();
	const check = () => {
		if (children.size === 0) {
			log("drained: stopping");
			return stop();
		}
		setTimeout(check, 250);
	};
	check();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => drain(signal));
