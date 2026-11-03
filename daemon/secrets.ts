import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { STATE } from "./paths";

export const NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
export const REFERENCE = /\$\{?SECRET_([A-Z][A-Z0-9_]{0,63})/g;
export const KEY = process.env.OMP_BOT_SECRET_KEY || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "omp-bot", "secrets.key");
const AGE = process.env.OMP_BOT_AGE || "age";
const DEFAULT_TTL = "24h";

export type Meta = { name: string; reason?: string; set: number; expires: number | null };
export type Request = { bot: string; name: string; reason: string; ttl?: string; at: number };

export function dir(bot: string): string {
	return join(STATE, "bots", bot, "secrets");
}

export function names(command: string): string[] {
	return [...new Set([...command.matchAll(REFERENCE)].map(match => match[1]))];
}

export function ttl(text: string | undefined): number | null {
	const value = text || DEFAULT_TTL;
	if (value === "never") return null;
	const match = /^(\d+)(m|h|d)$/.exec(value);
	if (!match || Number(match[1]) === 0) throw new Error(`bad expiry '${value}': use 30m, 12h, 7d or never`);
	return Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
}

function own(path: string) {
	mkdirSync(path, { recursive: true, mode: 0o700 });
	chmodSync(path, 0o700);
}

function readJson<T>(path: string, fallback: T): T {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return fallback;
	}
}

function writeJson(path: string, value: unknown) {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, { mode: 0o600 });
	renameSync(tmp, path);
}

export function forget(bot: string, name: string): boolean {
	const base = join(dir(bot), name);
	const had = existsSync(`${base}.age`);
	rmSync(`${base}.age`, { force: true });
	rmSync(`${base}.json`, { force: true });
	return had;
}

export function meta(bot: string, name: string): Meta | undefined {
	const base = join(dir(bot), name);
	if (!existsSync(`${base}.age`)) return undefined;
	const found = readJson<Meta | undefined>(`${base}.json`, undefined);
	if (!found || (found.expires !== null && found.expires <= Date.now())) {
		forget(bot, name);
		return undefined;
	}
	return found;
}

export function list(bot: string): Meta[] {
	if (!existsSync(dir(bot))) return [];
	return readdirSync(dir(bot))
		.filter(file => file.endsWith(".age"))
		.map(file => meta(bot, file.slice(0, -4)))
		.filter((found): found is Meta => found !== undefined);
}

export function bots(): string[] {
	const root = join(STATE, "bots");
	return existsSync(root) ? readdirSync(root).filter(bot => existsSync(dir(bot))) : [];
}

async function age(args: string[], input?: string): Promise<string> {
	const child = Bun.spawn([AGE, ...args], { stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(`age: ${stderr.trim()}`);
	return stdout;
}

async function key() {
	if (existsSync(KEY)) return;
	own(dirname(KEY));
	const child = Bun.spawn([`${AGE}-keygen`, "-o", KEY], { stdout: "ignore", stderr: "pipe" });
	const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
	if (code !== 0) throw new Error(`age-keygen: ${stderr.trim()}`);
	chmodSync(KEY, 0o600);
}

export async function reveal(bot: string, name: string): Promise<string | undefined> {
	if (!meta(bot, name)) return undefined;
	return age(["-d", "-i", KEY, join(dir(bot), `${name}.age`)]);
}

export function modified(bot: string, name: string): number {
	try {
		return statSync(join(dir(bot), `${name}.age`)).mtimeMs;
	} catch {
		return 0;
	}
}

export async function store(bot: string, name: string, value: string, expiry: string | undefined, reason?: string): Promise<Meta> {
	const life = ttl(expiry);
	await key();
	own(dir(bot));
	const base = join(dir(bot), name);
	const cipher = await age(["-e", "-a", "-i", KEY], value);
	const now = Date.now();
	const found: Meta = { name, reason, set: now, expires: life === null ? null : now + life };
	writeFileSync(`${base}.age.tmp`, cipher, { mode: 0o600 });
	renameSync(`${base}.age.tmp`, `${base}.age`);
	writeJson(`${base}.json`, found);
	settle(bot, name);
	return found;
}

function requestsFile(bot: string): string {
	return join(dir(bot), "requests.json");
}

export function request(bot: string, name: string, reason: string, expiry?: string) {
	own(dir(bot));
	const open = readJson<Request[]>(requestsFile(bot), []).filter(entry => entry.name !== name);
	open.push({ bot, name, reason, ttl: expiry, at: Date.now() });
	writeJson(requestsFile(bot), open);
}

export function settle(bot: string, name: string) {
	const open = readJson<Request[]>(requestsFile(bot), []);
	const left = open.filter(entry => entry.name !== name);
	if (left.length !== open.length) writeJson(requestsFile(bot), left);
}

export function pending(): Request[] {
	return bots().flatMap(bot => readJson<Request[]>(requestsFile(bot), []));
}
