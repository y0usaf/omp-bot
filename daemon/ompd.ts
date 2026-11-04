import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { ROOT, STATE } from "./paths";

export const V = 1;
export const JOBS = join(STATE, "jobs");
export const SOCKET = process.env.OMPD_SOCKET || join(STATE, "ompd.sock");
const POLL_MS = Number(process.env.OMPD_POLL_MS) || 1000;
const MAX_RUNS = 3;
const LEAN = /(^|[\s;&|(`])(lake|lean)(\s|$)/;

export type Job = {
	v: number;
	id: string;
	owner: string;
	tool: string | null;
	command: string;
	cwd: string;
	timeout: number;
	rerunnable: boolean;
	lean: boolean;
	state: "queued" | "running" | "done" | "lost";
	runs: number;
	created: number;
	started: number | null;
	ended: number | null;
	code: number | null;
	reason: string | null;
	delivered: boolean;
};

function size(text: string): number {
	const match = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(text.trim());
	if (!match) throw new Error(`OMPD_JOB_MEMORY: '${text}' is not a size like 12G`);
	return Number(match[1]) * 1024 ** " KMGT".indexOf(match[2].toUpperCase() || " ");
}

export function dir(id: string): string {
	return join(JOBS, id);
}

export function load(id: string): Job | undefined {
	try {
		return JSON.parse(readFileSync(join(dir(id), "job.json"), "utf8"));
	} catch {
		return undefined;
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

function serve() {
	const memory = size(process.env.OMPD_JOB_MEMORY || "12G");
	const total = Number(/MemTotal:\s+(\d+)/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1] ?? 0) * 1024;
	const slots = Number(process.env.OMPD_LEAN_SLOTS) || Math.max(1, Math.floor(total / 2 / memory));
	const page = Number(Bun.spawnSync(["getconf", "PAGESIZE"]).stdout.toString().trim()) || 4096;
	const jobs = new Map<string, Job>();
	const watchers = new Map<string, Set<Socket>>();
	const killed = new Map<string, string>();

	function log(line: string) {
		console.log(`${new Date().toISOString()} ${line}`);
	}

	function save(job: Job) {
		const file = join(dir(job.id), "job.json");
		writeFileSync(`${file}.tmp`, JSON.stringify(job, null, "\t"), { mode: 0o600 });
		renameSync(`${file}.tmp`, file);
	}

	function pid(job: Job): number | undefined {
		try {
			return Number(readFileSync(join(dir(job.id), "pid"), "utf8")) || undefined;
		} catch {
			return undefined;
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

	function sessions(): Map<number, { pids: number[]; rss: number }> {
		const out = new Map<number, { pids: number[]; rss: number }>();
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
			const entry = out.get(sid) ?? { pids: [], rss: 0 };
			entry.pids.push(Number(name));
			entry.rss += Number(fields[21]) * page;
			out.set(sid, entry);
		}
		return out;
	}

	function kill(job: Job, reason: string) {
		const p = pid(job);
		if (!p || !alive(job)) return;
		killed.set(job.id, reason);
		log(`kill ${job.id}: ${reason}`);
		for (const each of sessions().get(p)?.pids ?? []) {
			try {
				process.kill(each, "SIGKILL");
			} catch {}
		}
	}

	function deliver(job: Job) {
		const { env: _env, ...shown } = job as Job & { env?: unknown };
		for (const socket of watchers.get(job.owner) ?? []) if (!socket.destroyed) socket.write(`${JSON.stringify({ event: "ended", job: shown })}\n`);
	}

	function finish(job: Job, patch: Partial<Job>) {
		Object.assign(job, { ended: Date.now(), ...patch });
		save(job);
		log(`${job.state} ${job.id} code ${job.code}${job.reason ? `: ${job.reason}` : ""}`);
		deliver(job);
		dispatch();
	}

	function start(job: Job) {
		const path = dir(job.id);
		for (const name of ["pid", "exit"]) rmQuiet(join(path, name));
		job.state = "running";
		job.runs += 1;
		job.started = Date.now();
		save(job);
		const env = JSON.parse(readFileSync(join(path, "env.json"), "utf8"));
		const out = openSync(join(path, "log"), "a");
		if (job.runs > 1) appendFileSync(join(path, "log"), `\n[ompd: run ${job.runs}, started again after the last run was lost]\n`);
		try {
			if (!existsSync(job.cwd)) throw new Error(`no directory ${job.cwd}`);
			const proc = Bun.spawn(["setsid", join(ROOT, "bin", "ompd-job"), path], { cwd: job.cwd, env, stdin: "ignore", stdout: out, stderr: out });
			proc.unref();
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
		const procs = sessions();
		for (const job of running) {
			const up = alive(job);
			const code = exitCode(job);
			if (code !== undefined) {
				finish(job, { state: "done", code, reason: killed.get(job.id) ?? null });
				killed.delete(job.id);
				continue;
			}
			if (!up) {
				if (killed.has(job.id)) {
					finish(job, { state: "done", code: null, reason: killed.get(job.id)! });
					killed.delete(job.id);
				} else if (Date.now() - (job.started ?? 0) > 5_000 || pid(job)) lost(job, "its processes ended without recording an exit status (killed, or the machine restarted)");
				continue;
			}
			const p = pid(job)!;
			const rss = procs.get(p)?.rss ?? 0;
			if (rss > memory) kill(job, `killed for using ${Math.round(rss / 2 ** 20)} MiB, over the ${Math.round(memory / 2 ** 20)} MiB a job may use`);
			else if (job.timeout > 0 && Date.now() - (job.started ?? 0) > job.timeout * 1000) kill(job, `killed after its ${job.timeout}s timeout`);
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
		const tool = message.tool ? String(message.tool) : null;
		if (tool) {
			const existing = [...jobs.values()].find(job => job.owner === owner && job.tool === tool);
			if (existing) return existing;
		}
		const lean = LEAN.test(command);
		const job: Job = {
			v: V,
			id: Bun.randomUUIDv7(),
			owner,
			tool,
			command,
			cwd: String(message.cwd ?? process.cwd()),
			timeout: Math.max(0, Number(message.timeout) || 0),
			rerunnable: Boolean(message.rerunnable) || lean,
			lean,
			state: "queued",
			runs: 0,
			created: Date.now(),
			started: null,
			ended: null,
			code: null,
			reason: null,
			delivered: false,
		};
		mkdirSync(dir(job.id), { recursive: true, mode: 0o700 });
		writeFileSync(join(dir(job.id), "command"), command, { mode: 0o600 });
		writeFileSync(join(dir(job.id), "env.json"), JSON.stringify(message.env ?? {}), { mode: 0o600 });
		save(job);
		jobs.set(job.id, job);
		log(`queue ${job.id} for ${owner}${tool ? ` call ${tool}` : ""}`);
		dispatch();
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
			case "watch": {
				const owner = String(message.owner ?? "");
				if (!watchers.has(owner)) watchers.set(owner, new Set());
				watchers.get(owner)!.add(socket);
				socket.on("close", () => watchers.get(owner)?.delete(socket));
				reply({ watching: owner });
				for (const job of jobs.values()) if (job.owner === owner && !job.delivered && (job.state === "done" || job.state === "lost")) deliver(job);
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
		if (job.state === "running") log(alive(job) ? `reattach ${id}` : `found ${id} not running`);
	}
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
		log(`listening on ${SOCKET}, ${slots} Lean slots, ${Math.round(memory / 2 ** 30)} GiB per job`);
		tend();
		setInterval(tend, POLL_MS);
	});
	for (const signal of ["SIGTERM", "SIGINT"] as const)
		process.on(signal, () => {
			server.close();
			process.exit(0);
		});
}

const USAGE = `usage: ompd COMMAND
  serve                                  run the daemon (bin/ompd serve takes its lock)
  run [--owner O] [--timeout S] [--rerunnable] -- CMD
                                         start CMD as a job and print its id
  jobs [--owner O]                       list jobs
  show ID                                a job's record and log path
  kill ID                                kill a job's processes`;

function line(job: Job): string {
	const took = job.started ? `${Math.round(((job.ended ?? Date.now()) - job.started) / 1000)}s` : "-";
	return `${job.id}  ${job.state}${job.code !== null ? ` ${job.code}` : ""}  ${took}  ${job.owner}  ${job.command.replace(/\s+/g, " ").slice(0, 80)}${job.reason ? `\n  ${job.reason}` : ""}`;
}

if (import.meta.main) {
	const [command, ...args] = process.argv.slice(2);
	const opt = (name: string) => {
		const at = args.indexOf(`--${name}`);
		return at >= 0 ? args[at + 1] : undefined;
	};
	try {
		switch (command) {
			case "serve":
				serve();
				break;
			case "run": {
				const at = args.indexOf("--");
				if (at < 0 || at === args.length - 1) throw new Error(USAGE);
				const reply = await request({ op: "run", owner: opt("owner") ?? `cli:${process.env.USER ?? "user"}`, command: args.slice(at + 1).join(" "), cwd: process.cwd(), env: process.env, timeout: Number(opt("timeout")) || 0, rerunnable: args.slice(0, at).includes("--rerunnable") });
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
			default:
				throw new Error(USAGE);
		}
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
