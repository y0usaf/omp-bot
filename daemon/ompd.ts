import { accessSync, appendFileSync, closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { ROOT, SOCKET as BOTD, STATE } from "./paths";
import { TASKS, type Task, final, loadTask, taskState } from "./tasks";

export const V = 1;
export const JOBS = join(STATE, "jobs");
export const SOCKET = process.env.OMPD_SOCKET || join(STATE, "ompd.sock");
const POLL_MS = Number(process.env.OMPD_POLL_MS) || 1000;
export const MONITOR_MS = Number(process.env.OMPD_MONITOR_MS) || 60_000;
const MONITOR_BYTES = 256 * 1024;
const MONITOR_LINES = 50;
const MAX_RUNS = 3;
export const LEAN = /(?:^|[\s;&|(`'"])(?<!\b(?:pgrep|pkill|grep)\b[^;&\n]*)(?:lake\s+(?:build|env\s+lean)|lean\s+(?:-\S+\s+)*[^\s-]\S*\.lean)(?=$|[\s;&|)`'"])/;
const ENV_KEEP = /^(?:PATH|HOME|USER|LOGNAME|SHELL|LANG|TERM|COLORTERM|TZ|TZDIR|TMPDIR|EDITOR|DISPLAY|WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|SSH_AUTH_SOCK|SSL_CERT_FILE|CARGO_HOME|RUSTUP_HOME|ELAN_HOME|(?:LC|XDG|NIX|PI|OMP|OMPD)_\w+)$/;
const SECRET = /TOKEN|SECRET|PASSW|KEY|CREDENTIAL|COOKIE|AUTH(?!_SOCK$)|^NIX_CONFIG$/i;
const KEEP_MS = 7 * 86_400_000;
const PRUNE_MS = 3_600_000;

export type Job = {
	v: number;
	id: string;
	owner: string;
	tool: string | null;
	task?: string | null;
	check?: boolean;
	command: string;
	cwd: string;
	timeout: number;
	rerunnable: boolean;
	lean: boolean;
	state: "queued" | "running" | "done" | "lost";
	runs: number;
	pid: number | null;
	cgroup?: string | null;
	killing: string | null;
	created: number;
	started: number | null;
	ended: number | null;
	code: number | null;
	reason: string | null;
	delivered: boolean;
	monitor?: { filter: string; seen: number; last: string; sent: number } | null;
};

function size(text: string): number {
	const match = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(text.trim());
	if (!match) throw new Error(`OMPD_JOB_MEMORY: '${text}' is not a size like 12G`);
	return Number(match[1]) * 1024 ** " KMGT".indexOf(match[2].toUpperCase() || " ");
}

export function dir(id: string): string {
	return join(JOBS, id);
}

export function safeEnv(env: Record<string, unknown>): Record<string, string> {
	return Object.fromEntries(Object.entries(env).filter(([key, value]) => typeof value === "string" && ENV_KEEP.test(key) && !SECRET.test(key))) as Record<string, string>;
}

export function load(id: string): Job | undefined {
	try {
		return JSON.parse(readFileSync(join(dir(id), "job.json"), "utf8"));
	} catch {
		return undefined;
	}
}

export function isHelper(job: Job): boolean {
	return job.command.includes("/helpers/") && job.command.includes("rpc") && job.command.includes("--append-system-prompt");
}

export function trimHelperLog(job: Job): number {
	if ((job.state !== "done" && job.state !== "lost") || !isHelper(job)) return 0;
	const path = join(dir(job.id), "log");
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		if (size <= 64 * 1024) return 0;
		const tail = Buffer.alloc(64 * 1024);
		const length = readSync(fd, tail, 0, tail.length, size - tail.length);
		writeFileSync(path, tail.subarray(0, length));
		return size - length;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return 0;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

export function request(message: Record<string, unknown>): Promise<any> {
	return new Promise((resolve, reject) => {
		const socket = connect(SOCKET);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify({ v: V, ...message })}\n`));
		socket.on("data", chunk => {
			buffer += chunk;
			const nl = buffer.indexOf("\n");
			if (nl < 0) return;
			socket.end();
			const reply = JSON.parse(buffer.slice(0, nl));
			reply.ok === false ? reject(new Error(reply.error)) : resolve(reply);
		});
		socket.on("error", reject);
	});
}

function cgroupBase(): string | undefined {
	let base = process.env.OMPD_CGROUP;
	if (!base) {
		const own = /^0::(\/.*)$/m.exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1];
		if (!own || own === "/") return undefined;
		base = join("/sys/fs/cgroup", own, "..");
	}
	try {
		accessSync(base, constants.W_OK);
		accessSync(join(base, "cgroup.procs"), constants.W_OK);
		const control = join(base, "cgroup.subtree_control");
		if (!readFileSync(control, "utf8").split(/\s+/).includes("memory")) writeFileSync(control, "+memory");
		return base;
	} catch {
		return undefined;
	}
}

function serve() {
	const memory = size(process.env.OMPD_JOB_MEMORY || "12G");
	const total = Number(/MemTotal:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0) * 1024;
	const slots = Number(process.env.OMPD_LEAN_SLOTS) || Math.max(1, Math.floor(total / 2 / memory));
	const base = cgroupBase();
	const over = `killed for going over the ${Math.round(memory / 2 ** 20)} MiB a job may use`;
	const jobs = new Map<string, Job>();
	const watchers = new Map<string, Set<Socket>>();
	const envs = new Map<string, Record<string, string>>();
	const tasks = new Map<string, Task>();
	const taskEnvs = new Map<string, Record<string, string>>();

	function log(line: string) {
		console.log(`${new Date().toISOString()} ${line}`);
	}

	function save(job: Job) {
		const file = join(dir(job.id), "job.json");
		writeFileSync(`${file}.tmp`, JSON.stringify(job, null, "\t"), { mode: 0o600 });
		renameSync(`${file}.tmp`, file);
	}

	function taskDir(id: string): string {
		return join(TASKS, id);
	}

	function saveTask(task: Task) {
		const file = join(taskDir(task.id), "task.json");
		writeFileSync(`${file}.tmp`, JSON.stringify(task, null, "\t"), { mode: 0o600 });
		renameSync(`${file}.tmp`, file);
	}

	function liveJob(id: string): boolean {
		const job = jobs.get(id);
		return !!job && (job.state === "queued" || job.state === "running");
	}

	function recompute(task: Task, touch = true) {
		task.state = taskState(task, liveJob);
		if (touch) task.updated = Date.now();
		saveTask(task);
	}

	function taskLog(task: Task): string | null {
		return task.checked?.job ? join(dir(task.checked.job), "log") : null;
	}

	function notifyTask(task: Task) {
		if (task.seq <= task.acked) return;
		const event = JSON.stringify({ event: "task", task, log: taskLog(task) });
		for (const socket of watchers.get(task.owner) ?? []) if (!socket.destroyed) socket.write(`${event}\n`);
	}

	function changed(task: Task) {
		task.seq += 1;
		recompute(task);
		notifyTask(task);
	}

	function findTask(id: string): Task {
		const matches = [...tasks.values()].filter(task => task.id.startsWith(String(id ?? "")));
		if (matches.length !== 1) throw new Error(matches.length ? `task ${id} is ambiguous` : `no task ${id}`);
		return matches[0];
	}

	function storedTaskEnv(id: string): Record<string, string> {
		try {
			return JSON.parse(readFileSync(join(taskDir(id), "env.json"), "utf8"));
		} catch {
			throw new Error("its task's environment was not kept");
		}
	}

	function startCheck(task: Task) {
		run({ owner: `task:${task.id}`, command: task.check, cwd: task.cwd, timeout: task.checkTimeout, env: taskEnvs.get(task.id) ?? storedTaskEnv(task.id), task: task.id, check: true });
	}

	function unhold(task: Task) {
		for (const id of task.jobs) {
			const job = jobs.get(id);
			if (job && !job.delivered && (job.state === "done" || job.state === "lost")) deliver(job);
		}
	}

	function settleCheck(task: Task, job: { id: string; code: number | null; reason: string | null }) {
		task.checkJob = null;
		if (task.dropped !== null) return recompute(task);
		task.checked = { job: job.id, code: job.code, reason: job.reason, at: Date.now() };
		changed(task);
		unhold(task);
	}

	function jobEnded(job: Job) {
		const task = job.task ? tasks.get(job.task) : undefined;
		if (!task) return;
		if (!final(task) && task.check !== null && task.checkJob === null && !task.jobs.some(liveJob)) {
			try {
				return startCheck(task);
			} catch (error) {
				task.checked = { job: "", code: null, reason: error instanceof Error ? error.message : String(error), at: Date.now() };
				return changed(task);
			}
		}
		recompute(task);
	}

	function stop(id: string, reason: string) {
		const job = jobs.get(id);
		if (!job || (job.state !== "queued" && job.state !== "running")) return;
		if (job.state === "queued") finish(job, { state: "done", code: null, reason });
		else kill(job, reason);
	}

	function pid(job: Job): number | undefined {
		try {
			return Number(readFileSync(join(dir(job.id), "pid"), "utf8")) || job.pid || undefined;
		} catch {
			return job.pid || undefined;
		}
	}

	function alive(job: Job): boolean {
		const p = pid(job);
		if (!p) return false;
		try {
			return readFileSync(`/proc/${p}/cmdline`, "utf8").includes(dir(job.id));
		} catch {
			return false;
		}
	}

	function exitCode(job: Job): number | undefined {
		try {
			const code = readFileSync(join(dir(job.id), "exit"), "utf8").trim();
			return code === "" ? undefined : Number(code);
		} catch {
			return undefined;
		}
	}

	function sessions(): Map<number, number[]> {
		const out = new Map<number, number[]>();
		for (const name of readdirSync("/proc")) {
			if (!/^\d+$/.test(name)) continue;
			let stat: string;
			try {
				stat = readFileSync(`/proc/${name}/stat`, "utf8");
			} catch {
				continue;
			}
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			const sid = Number(fields[3]);
			out.set(sid, [...(out.get(sid) ?? []), Number(name)]);
		}
		return out;
	}

	function kill(job: Job, reason: string) {
		const p = pid(job);
		if (!p || !alive(job)) return;
		job.killing = reason;
		save(job);
		log(`kill ${job.id}: ${reason}`);
		if (job.cgroup) {
			try {
				return writeFileSync(join(job.cgroup, "cgroup.kill"), "1");
			} catch {}
		}
		for (const each of sessions().get(p) ?? []) {
			try {
				process.kill(each, "SIGKILL");
			} catch {}
		}
	}

	function cgroup(job: Job): string | null {
		if (!base) return null;
		const path = join(base, `job-${job.id}`);
		try {
			if (existsSync(path)) rmdirSync(path);
			mkdirSync(path);
			writeFileSync(join(path, "memory.max"), String(memory));
			if (existsSync(join(path, "memory.swap.max"))) writeFileSync(join(path, "memory.swap.max"), "0");
			writeFileSync(join(path, "memory.oom.group"), "1");
			return path;
		} catch (error) {
			log(`no cgroup for ${job.id}: ${error instanceof Error ? error.message : error}`);
			return null;
		}
	}

	function oomKilled(job: Job): boolean {
		if (!job.cgroup) return false;
		try {
			return Number(/^oom_kill (\d+)$/m.exec(readFileSync(join(job.cgroup, "memory.events"), "utf8"))?.[1] ?? 0) > 0;
		} catch {
			return false;
		}
	}

	function release(job: Job) {
		if (!job.cgroup) return;
		try {
			rmdirSync(job.cgroup);
		} catch {}
	}

	function deliver(job: Job) {
		if (job.delivered) return;
		const task = job.task ? tasks.get(job.task) : undefined;
		if (task && (task.state === "running" || task.state === "checking")) return;
		const { env: _env, ...shown } = job as Job & { env?: unknown };
		const message = task ? { event: "ended", job: shown, task } : { event: "ended", job: shown };
		for (const socket of watchers.get(job.owner) ?? []) if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
	}

	function monitor(job: Job) {
		const m = job.monitor;
		const live = [...(watchers.get(job.owner) ?? [])].filter(socket => !socket.destroyed);
		if (!m || !live.length || Date.now() - m.sent < MONITOR_MS) return;
		let fd: number | undefined;
		let buffer: Buffer;
		let from: number;
		try {
			fd = openSync(join(dir(job.id), "log"), "r");
			const end = fstatSync(fd).size;
			from = Math.max(m.seen, end - MONITOR_BYTES);
			buffer = Buffer.alloc(end - from);
			readSync(fd, buffer, 0, buffer.length, from);
		} catch {
			return;
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
		const cut = buffer.lastIndexOf(10) + 1;
		if (!cut) return;
		const skipped = from - m.seen;
		m.seen = from + cut;
		const filter = new RegExp(m.filter);
		const lines: string[] = [];
		for (const raw of buffer.subarray(0, cut).toString("utf8").split("\n").slice(skipped ? 1 : 0, -1)) {
			const line = raw.replace(/\r$/, "");
			if (!line.trim() || line === m.last || !filter.test(line)) continue;
			m.last = line;
			lines.push(line);
		}
		if (lines.length) m.sent = Date.now();
		save(job);
		if (!lines.length) return;
		const event = JSON.stringify({ event: "output", job, lines: lines.slice(-MONITOR_LINES), omitted: Math.max(0, lines.length - MONITOR_LINES), skipped });
		for (const socket of live) socket.write(`${event}\n`);
	}

	function finish(job: Job, patch: Partial<Job>) {
		Object.assign(job, { ended: Date.now(), ...patch });
		save(job);
		release(job);
		envs.delete(job.id);
		rmQuiet(join(dir(job.id), "env.json"));
		log(`${job.state} ${job.id} code ${job.code}${job.reason ? `: ${job.reason}` : ""}`);
		if (job.check) {
			const task = job.task ? tasks.get(job.task) : undefined;
			if (task) settleCheck(task, job);
		} else if (job.task) jobEnded(job);
		deliver(job);
		dispatch();
	}

	function storedEnv(path: string): Record<string, string> {
		try {
			return JSON.parse(readFileSync(join(path, "env.json"), "utf8"));
		} catch {
			throw new Error("its environment was not kept across the ompd restart");
		}
	}

	function scrubEnv(job: Job) {
		const file = join(dir(job.id), "env.json");
		if (job.state !== "queued" && !(job.state === "running" && job.rerunnable)) return rmQuiet(file);
		try {
			writeFileSync(file, JSON.stringify(safeEnv(JSON.parse(readFileSync(file, "utf8")))), { mode: 0o600 });
		} catch {}
	}

	function prune() {
		const before = Date.now() - KEEP_MS;
		let pruned = 0;
		let swept = 0;
		let cleaned = 0;
		for (const job of jobs.values()) {
			if (job.state === "running") continue;
			trimHelperLog(job);
			if (job.cgroup && existsSync(job.cgroup)) {
				try {
					rmdirSync(job.cgroup);
					swept++;
				} catch {}
			}
			if (job.state === "queued" || !job.delivered || (job.ended ?? job.created) > before) continue;
			rmSync(dir(job.id), { recursive: true, force: true });
			jobs.delete(job.id);
			pruned++;
		}
		for (const task of tasks.values()) {
			if (!final(task) || task.updated > before || task.seq > task.acked) continue;
			rmSync(taskDir(task.id), { recursive: true, force: true });
			tasks.delete(task.id);
			taskEnvs.delete(task.id);
			cleaned++;
		}
		if (pruned || swept) log(`pruned ${pruned} delivered jobs that ended over ${KEEP_MS / 86_400_000} days ago, removed ${swept} empty job cgroups`);
		if (cleaned) log(`pruned ${cleaned} finished tasks untouched for ${KEEP_MS / 86_400_000} days`);
	}

	function start(job: Job) {
		const path = dir(job.id);
		for (const name of ["pid", "exit"]) rmQuiet(join(path, name));
		job.state = "running";
		job.runs += 1;
		job.started = Date.now();
		job.pid = null;
		job.killing = null;
		job.cgroup = cgroup(job);
		save(job);
		const out = openSync(join(path, "log"), "a");
		if (job.runs > 1) appendFileSync(join(path, "log"), `\n[ompd: run ${job.runs}, started again after the last run was lost]\n`);
		try {
			if (!existsSync(job.cwd)) throw new Error(`no directory ${job.cwd}`);
			const env = envs.get(job.id) ?? storedEnv(path);
			if (!job.rerunnable) rmQuiet(join(path, "env.json"));
			const proc = Bun.spawn(["setsid", join(ROOT, "bin", "ompd-job"), path, ...(job.cgroup ? [job.cgroup] : [])], { cwd: job.cwd, env, stdin: "ignore", stdout: out, stderr: out });
			proc.unref();
			job.pid = proc.pid;
			save(job);
			log(`start ${job.id} run ${job.runs}${job.lean ? " (lean)" : ""}: ${job.command.slice(0, 120)}`);
		} catch (error) {
			finish(job, { state: "done", code: null, reason: `could not start: ${error instanceof Error ? error.message : error}` });
		} finally {
			closeSync(out);
		}
	}

	function dispatch() {
		let lean = [...jobs.values()].filter(job => job.state === "running" && job.lean).length;
		const queued = [...jobs.values()].filter(job => job.state === "queued").sort((a, b) => a.created - b.created);
		for (const job of queued) {
			if (job.lean && lean >= slots) continue;
			if (job.lean) lean++;
			start(job);
		}
	}

	function lost(job: Job, why: string) {
		if (job.rerunnable && job.runs < MAX_RUNS) {
			log(`rerun ${job.id}: ${why}`);
			job.state = "queued";
			save(job);
			return;
		}
		finish(job, { state: "lost", code: null, reason: `${why}; its outcome is unknown and it was not run again` });
	}

	function tend() {
		const running = [...jobs.values()].filter(job => job.state === "running");
		if (running.length === 0) return dispatch();
		for (const job of running) {
			const up = alive(job);
			const code = exitCode(job);
			if (!job.killing && oomKilled(job)) {
				job.killing = over;
				save(job);
				log(`kill ${job.id}: ${over}`);
			}
			if (code !== undefined) {
				finish(job, { state: "done", code, reason: job.killing ?? null });
				continue;
			}
			if (!up) {
				if (job.killing) finish(job, { state: "done", code: null, reason: job.killing });
				else lost(job, "its processes ended without recording an exit status (killed, or the machine restarted)");
				continue;
			}
			if (job.timeout > 0 && Date.now() - (job.started ?? 0) > job.timeout * 1000) kill(job, `killed after its ${job.timeout}s timeout`);
			monitor(job);
		}
		dispatch();
	}

	function rmQuiet(path: string) {
		try {
			unlinkSync(path);
		} catch {}
	}

	function run(message: any): Job {
		const owner = String(message.owner ?? "");
		const command = String(message.command ?? "");
		if (!owner) throw new Error("run needs an owner");
		if (!command.trim()) throw new Error("run needs a command");
		const task = message.task ? findTask(String(message.task)) : undefined;
		if (task && final(task)) throw new Error(`task ${task.id} is already ${task.state}`);
		const checking = message.check === true;
		const tool = message.tool ? String(message.tool) : null;
		if (tool) {
			const existing = [...jobs.values()].find(job => job.owner === owner && job.tool === tool);
			if (existing) return existing;
		}
		const lean = LEAN.test(command);
		const filter = message.monitor === undefined || message.monitor === null ? null : String(message.monitor);
		if (filter !== null) new RegExp(filter);
		const env = { ...message.env };
		if (env.OMP_BOT_NAME) {
			env.OMP_BOT_REAL_GIT ||= Bun.which("git", { PATH: env.PATH });
			env.PATH = `${join(ROOT, "git")}:${env.PATH ?? process.env.PATH ?? ""}`;
		}
		const job: Job = {
			v: V,
			id: Bun.randomUUIDv7(),
			owner,
			tool,
			command,
			cwd: String(message.cwd ?? process.cwd()),
			timeout: Math.max(0, Number(message.timeout) || 0),
			rerunnable: Boolean(message.rerunnable),
			lean,
			state: "queued",
			runs: 0,
			pid: null,
			cgroup: null,
			killing: null,
			created: Date.now(),
			started: null,
			ended: null,
			code: null,
			reason: null,
			delivered: checking,
			task: task ? task.id : null,
			...(checking ? { check: true } : {}),
			monitor: filter === null ? null : { filter, seen: 0, last: "", sent: 0 },
		};
		mkdirSync(dir(job.id), { recursive: true, mode: 0o700 });
		writeFileSync(join(dir(job.id), "command"), command, { mode: 0o600 });
		save(job);
		jobs.set(job.id, job);
		envs.set(job.id, env);
		if (task) {
			if (checking) task.checkJob = job.id;
			else task.jobs.push(job.id);
			recompute(task);
		}
		log(`queue ${job.id} for ${owner}${tool ? ` call ${tool}` : ""}`);
		dispatch();
		if (job.state === "queued" || (job.state === "running" && job.rerunnable)) writeFileSync(join(dir(job.id), "env.json"), JSON.stringify(safeEnv(env)), { mode: 0o600 });
		return job;
	}

	function find(id: string): Job {
		const matches = [...jobs.values()].filter(job => job.id.startsWith(String(id ?? "")));
		if (matches.length !== 1) throw new Error(matches.length ? `job ${id} is ambiguous` : `no job ${id}`);
		return matches[0];
	}

	function handle(socket: Socket, message: any) {
		if (message.v !== V) throw new Error(`ompd speaks version ${V}, this client ${message.v ?? "none"}; update the client`);
		const reply = (body: Record<string, unknown>) => socket.write(`${JSON.stringify({ ok: true, ...body })}\n`);
		switch (message.op) {
			case "run":
				return reply({ job: run(message) });
			case "get":
				return reply({ job: find(message.id) });
			case "list":
				return reply({ jobs: [...jobs.values()].filter(job => !message.owner || job.owner === message.owner).sort((a, b) => a.created - b.created) });
			case "kill": {
				const job = find(message.id);
				if (job.state === "queued") finish(job, { state: "done", code: null, reason: "killed before it started" });
				else kill(job, "killed on request");
				return reply({ job });
			}
			case "ack": {
				const job = find(message.id);
				if (!job.delivered) {
					job.delivered = true;
					save(job);
				}
				return reply({ job });
			}
			case "task-add": {
				const owner = String(message.owner ?? "");
				if (!owner) throw new Error("task-add needs an owner");
				const title = String(message.title ?? "").trim();
				if (!title) throw new Error("task-add needs a title");
				const key = String(message.key ?? "").trim() || null;
				if (key) {
					const existing = [...tasks.values()].find(task => task.owner === owner && task.key === key);
					if (existing) return reply({ task: existing });
				}
				const check = String(message.check ?? "").trim() || null;
				const question = String(message.question ?? "").trim() || null;
				if (!check && !question) throw new Error("a task needs a check command, or a question for the user");
				const id = Bun.randomUUIDv7();
				const now = Date.now();
				const env = safeEnv({ ...message.env });
				const task: Task = {
					v: V,
					id,
					owner,
					key,
					title,
					check,
					cwd: String(message.cwd ?? process.cwd()),
					checkTimeout: Math.max(0, Number(message.checkTimeout) || 1800),
					note: String(message.note ?? "").trim() || null,
					jobs: [],
					checkJob: null,
					checked: null,
					question,
					answer: null,
					dropped: null,
					state: "open",
					seq: 0,
					acked: 0,
					created: now,
					updated: now,
				};
				mkdirSync(taskDir(id), { recursive: true, mode: 0o700 });
				writeFileSync(join(taskDir(id), "env.json"), JSON.stringify(env), { mode: 0o600 });
				tasks.set(id, task);
				taskEnvs.set(id, env);
				recompute(task);
				log(`task ${id} for ${owner}: ${title}`);
				return reply({ task });
			}
			case "task-list":
				return reply({ tasks: [...tasks.values()].filter(task => !message.owner || task.owner === message.owner).sort((a, b) => a.created - b.created) });
			case "task-get":
				return reply({ task: findTask(message.id) });
			case "task-ask": {
				const task = findTask(message.id);
				if (final(task)) throw new Error(`task ${task.id} is already ${task.state}`);
				const question = String(message.question ?? "").trim();
				if (!question) throw new Error("task-ask needs a question");
				task.question = question;
				changed(task);
				return reply({ task });
			}
			case "task-answer": {
				const task = findTask(message.id);
				if (task.question === null) throw new Error(`task ${task.id} has no pending question`);
				if (task.check === null && task.answer !== null) throw new Error(`task ${task.id} was already answered`);
				task.answer = String(message.answer ?? "");
				task.question = null;
				changed(task);
				return reply({ task });
			}
			case "task-note": {
				const task = findTask(message.id);
				task.note = String(message.note ?? "").trim() || null;
				recompute(task);
				return reply({ task });
			}
			case "task-check": {
				const task = findTask(message.id);
				if (final(task)) throw new Error(`task ${task.id} is already ${task.state}`);
				if (!task.check) throw new Error(`task ${task.id} has no check command`);
				if (task.checkJob === null) startCheck(task);
				return reply({ task });
			}
			case "task-drop": {
				const task = findTask(message.id);
				const reason = String(message.reason ?? "").trim();
				if (!reason) throw new Error("task-drop needs a reason");
				if (final(task)) throw new Error(`task ${task.id} is already ${task.state}`);
				const held = task.jobs.flatMap(id => {
					const job = jobs.get(id);
					return job && !job.delivered && (job.state === "done" || job.state === "lost") ? [job] : [];
				});
				task.dropped = reason;
				changed(task);
				for (const id of task.jobs) stop(id, "its task was dropped");
				if (task.checkJob) stop(task.checkJob, "its task was dropped");
				for (const job of held) deliver(job);
				return reply({ task });
			}
			case "task-ack": {
				const task = findTask(message.id);
				task.acked = Math.max(task.acked, Number(message.seq) || 0);
				saveTask(task);
				return reply({ task });
			}
			case "watch": {
				const owner = String(message.owner ?? "");
				if (!watchers.has(owner)) watchers.set(owner, new Set());
				watchers.get(owner)!.add(socket);
				socket.on("close", () => watchers.get(owner)?.delete(socket));
				reply({ watching: owner });
				for (const job of jobs.values()) if (job.owner === owner && !job.delivered && (job.state === "done" || job.state === "lost")) deliver(job);
				for (const task of tasks.values()) if (task.owner === owner) notifyTask(task);
				return;
			}
			default:
				throw new Error(`unknown op ${message.op}`);
		}
	}

	mkdirSync(JOBS, { recursive: true, mode: 0o700 });
	for (const id of readdirSync(JOBS)) {
		const job = load(id);
		if (!job) continue;
		if (job.v !== V) {
			log(`skip ${id}: written by ompd version ${job.v}, not replayed`);
			continue;
		}
		jobs.set(id, job);
		scrubEnv(job);
		if (job.state === "running") log(alive(job) ? `reattach ${id}` : `found ${id} not running`);
	}
	mkdirSync(TASKS, { recursive: true, mode: 0o700 });
	for (const id of readdirSync(TASKS)) {
		const task = loadTask(id);
		if (!task) continue;
		if (task.v !== V) {
			log(`skip task ${id}: written by ompd version ${task.v}, not replayed`);
			continue;
		}
		tasks.set(id, task);
		recompute(task, false);
		if (task.checkJob === null) continue;
		const job = jobs.get(task.checkJob);
		if (!job) settleCheck(task, { id: task.checkJob, code: null, reason: "its check job is gone" });
		else if (job.state === "done" || job.state === "lost") settleCheck(task, job);
	}
	prune();
	if (existsSync(SOCKET)) unlinkSync(SOCKET);
	const server = createServer(socket => {
		let buffer = "";
		socket.setEncoding("utf8");
		socket.on("error", () => {});
		socket.on("data", chunk => {
			buffer += chunk;
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				try {
					handle(socket, JSON.parse(line));
				} catch (error) {
					socket.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
				}
			}
		});
	});
	server.listen(SOCKET, () => {
		log(`listening on ${SOCKET}, ${slots} Lean slots, ${base ? `${Math.round(memory / 2 ** 20)} MiB per job, each in its own cgroup under ${base}` : "no cgroup to write, so jobs run without a memory limit"}`);
		tend();
		setInterval(tend, POLL_MS);
		setInterval(prune, PRUNE_MS);
	});
	for (const signal of ["SIGTERM", "SIGINT"] as const)
		process.on(signal, () => {
			server.close();
			process.exit(0);
		});
}

const USAGE = `usage: ompd COMMAND
  serve                                  run the daemon (bin/ompd serve takes its lock)
  run [--owner O] [--task ID] [--timeout S] [--rerunnable] [--monitor REGEX] -- CMD
                                         start CMD as a job and print its id
  jobs [--owner O]                       list jobs
  show ID                                a job's record and log path
  kill ID                                kill a job's processes
  task add --title T [--key K] [--check CMD] [--cwd DIR] [--check-timeout S] [--note N] [--ask Q] [--owner O]
                                         add a task and print its id; the same owner and key return the first one
  tasks [--owner O] [--all] [--json]     list tasks
  task show ID                           a task's record as JSON
  task ask ID QUESTION                   ask the user a question about it
  task answer ID TEXT                    record the user's answer
  task note ID TEXT                      say why an open task is idle
  task check ID                          run its check now
  task drop ID REASON                    drop it and kill its jobs`;

function line(job: Job): string {
	const took = job.started ? `${Math.round(((job.ended ?? Date.now()) - job.started) / 1000)}s` : "-";
	return `${job.id}  ${job.state}${job.code !== null ? ` ${job.code}` : ""}  ${took}  ${job.owner}  ${job.command.replace(/\s+/g, " ").slice(0, 80)}${job.reason ? `\n  ${job.reason}` : ""}`;
}

function age(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86_400)}d`;
}

export function taskLine(task: Task): string {
	return `${task.id.slice(0, 8)}  ${task.state}  ${age(Date.now() - task.created)}  ${task.owner}  ${task.title}`;
}

export function taskDetails(task: Task, running: number): string[] {
	const lines: string[] = [];
	if (task.check) lines.push(`  check: ${task.check}`);
	if (task.checked) lines.push(`  last check: exit ${task.checked.code ?? "-"} ${age(Date.now() - task.checked.at)} ago${task.checked.job ? ` (log ${join(dir(task.checked.job), "log")})` : ` (${task.checked.reason ?? "it did not run"})`}`);
	if (task.question) lines.push(`  question: ${task.question}`);
	if (task.answer) lines.push(`  answer: ${task.answer}`);
	if (task.note) lines.push(`  note: ${task.note}`);
	if (task.dropped) lines.push(`  dropped: ${task.dropped}`);
	if (running) lines.push(`  jobs: ${running} running`);
	return lines;
}

async function userOnly(): Promise<void> {
	const refuse = () => new Error("only the user can answer or drop a task: do it in a turn the user started by typing to you, relaying their words");
	if (process.env.OMP_BOT_HELPER) throw new Error("only the user can answer or drop a task; ask your parent");
	const bot = process.env.OMP_BOT_NAME;
	if (!bot) return;
	const live = await new Promise<boolean>((resolve, reject) => {
		const socket = connect(BOTD);
		let buffer = "";
		socket.setEncoding("utf8");
		socket.setTimeout(5000, () => socket.destroy(new Error("botd did not answer")));
		socket.on("connect", () => socket.write(`${JSON.stringify({ op: "live-check", bot })}\n`));
		socket.on("data", chunk => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			socket.end();
			try {
				const reply = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
				resolve(reply.ok === true && reply.live === true);
			} catch (error) {
				reject(error);
			}
		});
		socket.on("error", reject);
	}).catch(() => false);
	if (!live) throw refuse();
}

if (import.meta.main) {
	const [command, ...args] = process.argv.slice(2);
	const opt = (name: string) => {
		const at = args.indexOf(`--${name}`);
		return at >= 0 ? args[at + 1] : undefined;
	};
	const owner = (name: string) => opt(name) || process.env.OMPD_OWNER || (process.env.OMP_BOT_NAME ? `bot:${process.env.OMP_BOT_NAME}` : `cli:${process.env.USER ?? "user"}`);
	try {
		switch (command) {
			case "serve":
				serve();
				break;
			case "run": {
				const at = args.indexOf("--");
				if (at < 0 || at === args.length - 1) throw new Error(USAGE);
				const monitor = args.indexOf("--monitor");
				const reply = await request({ op: "run", owner: owner("owner"), task: opt("task"), command: args.slice(at + 1).join(" "), cwd: process.cwd(), env: process.env, timeout: Number(opt("timeout")) || 0, rerunnable: args.slice(0, at).includes("--rerunnable"), monitor: monitor < 0 ? undefined : args[monitor + 1] && args[monitor + 1] !== "--" ? args[monitor + 1] : "" });
				console.log(reply.job.id);
				break;
			}
			case "jobs":
				for (const job of (await request({ op: "list", owner: opt("owner") })).jobs) console.log(line(job));
				break;
			case "show": {
				if (!args[0]) throw new Error(USAGE);
				const { job } = await request({ op: "get", id: args[0] });
				console.log(JSON.stringify({ ...job, log: join(dir(job.id), "log") }, null, 2));
				break;
			}
			case "kill":
				if (!args[0]) throw new Error(USAGE);
				console.log(line((await request({ op: "kill", id: args[0] })).job));
				break;
			case "task": {
				const [sub, ...rest] = args;
				const id = rest[0];
				const text = rest.slice(1).join(" ").trim();
				if (sub === "add") {
					const reply = await request({ op: "task-add", owner: owner("owner"), title: opt("title"), key: opt("key"), check: opt("check"), cwd: opt("cwd"), checkTimeout: opt("check-timeout"), note: opt("note"), question: opt("ask"), env: process.env });
					console.log(reply.task.id);
					break;
				}
				if (!id) throw new Error(USAGE);
				switch (sub) {
					case "show": {
						const { task } = await request({ op: "task-get", id });
						console.log(JSON.stringify(task, null, 2));
						break;
					}
					case "ask":
						if (!text) throw new Error(USAGE);
						console.log(taskLine((await request({ op: "task-ask", id, question: text })).task));
						break;
					case "answer":
						await userOnly();
						console.log(taskLine((await request({ op: "task-answer", id, answer: text })).task));
						break;
					case "note":
						console.log(taskLine((await request({ op: "task-note", id, note: text })).task));
						break;
					case "check":
						console.log(taskLine((await request({ op: "task-check", id })).task));
						break;
					case "drop":
						if (!text) throw new Error(USAGE);
						await userOnly();
						console.log(taskLine((await request({ op: "task-drop", id, reason: text })).task));
						break;
					default:
						throw new Error(USAGE);
				}
				break;
			}
			case "tasks": {
				const { tasks } = await request({ op: "task-list", owner: owner("owner") });
				const rows = args.includes("--all") ? tasks : tasks.filter((task: Task) => !final(task));
				if (args.includes("--json")) {
					console.log(JSON.stringify(rows, null, 2));
					break;
				}
				const { jobs } = await request({ op: "list" });
				const running = new Map<string, number>();
				for (const job of jobs) if (job.task && (job.state === "queued" || job.state === "running")) running.set(job.task, (running.get(job.task) ?? 0) + 1);
				for (const task of rows) console.log([taskLine(task), ...taskDetails(task, running.get(task.id) ?? 0)].join("\n"));
				break;
			}
			default:
				throw new Error(USAGE);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
