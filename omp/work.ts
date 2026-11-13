import { spawn } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { STATE } from "./paths";

const MAX = Number(process.env.OMP_BOT_WORK_NUDGES) || 6;
const CHECK_SECONDS = Number(process.env.OMP_BOT_WORK_CHECK_SECONDS) || 60;
const DAY = 86_400_000;

const parse = line => {
	const d = /^done (.*?) build: (.*?) seen: (.*)$/.exec(line.trim());
	if (d) {
		const ask = d[1].trim();
		return { kind: "done", ask, key: ask.replace(/\s*\([^()]*\)$/, ""), build: d[2].trim(), seen: d[3].trim(), line: line.trim() };
	}
	const m = /^(todo|wait|drop) (.*?)(?: check: (.*))?$/.exec(line.trim());
	if (!m) return undefined;
	const ask = m[2].trim();
	return { kind: m[1], ask, key: ask.replace(/\s*\([^()]*\)$/, ""), check: m[3]?.trim(), line: line.trim() };
};

const run = command => {
	const { promise, resolve } = Promise.withResolvers();
	const child = spawn("bash", ["-c", command], { cwd: homedir(), stdio: ["ignore", "pipe", "pipe"], detached: true });
	let out = "";
	const add = d => (out = (out + d).slice(-4000));
	child.stdout.on("data", add);
	child.stderr.on("data", add);
	let done = false;
	let code;
	const finish = exit => {
		if (done) return;
		done = true;
		clearTimeout(timer);
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch {}
		child.stdout.destroy();
		child.stderr.destroy();
		resolve({ exit, out });
	};
	const timer = setTimeout(() => finish(`timeout after ${CHECK_SECONDS}s`), CHECK_SECONDS * 1000);
	child.on("exit", (c, signal) => {
		code = c ?? signal;
		setTimeout(() => finish(code), 500);
	});
	child.on("close", () => finish(code));
	child.on("error", error => finish(error.message));
	return promise;
};

export default function work(pi) {
	const name = process.env.OMP_BOT_NAME;
	if (!name) return;
	const dir = join(STATE, "bots", name);
	const file = join(dir, "work.txt");
	const stateFile = join(dir, "work.json");
	const logFile = join(dir, "done.log");
	const rule = `\n\n# Open work\n${file} lists everything the user asked you for that isn't finished, one line each and nothing else:\n- \`todo <ask> check: <command>\` while you can act on it.\n- \`wait <ask> (<helper name>) check: <command>\` while a running helper has it.\n- \`wait <ask> (user: "<the question you asked them>") check: <command>\` only when you asked the user a question and it is unanswered; quote it. A rule of theirs that already covers the work means it is yours: todo, not wait.\n- \`check: <command>\` is a shell command (run from home, ${CHECK_SECONDS}s limit) that exits 0 only once the work is done, meaning the user can try it: it tests the deployed thing or the pushed revision, never that code exists. \`check: manual <what must be seen>\` for what only eyes or the real monitor can judge.\nAdd a line when you take work on. After each turn the checks run: a passing one removes its line and logs the command, exit and output to ${logFile}; you're told so, and tell the user. Deleting a line never closes it; it comes back. A manual-check item closes only when you replace its line with \`done <ask> build: <the exact revision or store path tested> seen: <what was observed, with numbers or file paths>\`, written after the check was actually seen; it is logged to ${logFile}. To drop work, replace its line with \`drop <ask> (why)\` and tell the user why in one line. A question you answer outright gets no line.`;
	const read = () => (existsSync(file) ? readFileSync(file, "utf8") : "");
	const load = () => {
		try {
			return JSON.parse(readFileSync(stateFile, "utf8"));
		} catch {
			return {};
		}
	};
	const log = entry => appendFileSync(logFile, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
	let nudges = 0;
	let nudging = false;
	let calls = 0;

	pi.on("before_agent_start", async (event, c) => {
		if (c.agent?.kind === "sub") return undefined;
		if (!nudging) nudges = 0;
		nudging = false;
		calls = 0;
		if (!Array.isArray(event.systemPrompt) || event.systemPrompt.length === 0) return undefined;
		const systemPrompt = [...event.systemPrompt];
		systemPrompt[systemPrompt.length - 1] = `${systemPrompt[systemPrompt.length - 1]}${rule}`;
		return { systemPrompt };
	});

	pi.on("tool_execution_start", async (_event, c) => {
		if (c.agent?.kind !== "sub") calls += 1;
	});

	pi.on("agent_end", async (event, c) => {
		if (c.agent?.kind === "sub" || event.willContinue || c.hasPendingMessages()) return;
		const reason = event.messages?.findLast(message => message.role === "assistant")?.stopReason;
		if (reason === "aborted" || reason === "error" || reason === "length") return;
		const text = read();
		const state = load();
		const now = Date.now();
		const next = {};
		const keep = [];
		const notes = [];
		const items = text.split("\n").map(parse).filter(Boolean);
		const dropped = new Set(items.filter(item => item.kind === "drop").map(item => item.key));
		const known = new Map([...Object.entries(state).map(([key, old]) => [key, old.check]), ...items.filter(item => item.check).map(item => [item.key, item.check])]);
		const valid = item => known.get(item.key)?.startsWith("manual") && item.build && item.seen;
		const closed = new Set(items.filter(item => item.kind === "done" && valid(item)).map(item => item.key));
		for (const line of text.split("\n")) {
			if (!line.trim()) continue;
			const item = parse(line);
			if (!item) {
				keep.push(line);
				notes.push(`Not a todo/wait/drop line or a complete done line (done <ask> build: … seen: …), fix it: ${line}`);
				continue;
			}
			if (item.kind === "drop") {
				log({ ask: item.ask, dropped: true });
				continue;
			}
			if (item.kind === "done") {
				const check = known.get(item.key);
				if (!valid(item)) {
					keep.push(line);
					notes.push(
						check?.startsWith("manual")
							? `A done line needs both build: and seen: filled in: ${line}`
							: `done only closes a manual-check item; this ask has ${check ? "a command check, which closes itself" : "no open item"}: ${line}`,
					);
					continue;
				}
				log({ ask: item.ask, check, closed: "seen", build: item.build, seen: item.seen });
				notes.push(`Closed on what was seen: ${item.ask}\nTell the user it's done.`);
				continue;
			}
			if (closed.has(item.key)) continue;
			if (dropped.has(item.key)) continue;
			if (item.check && !item.check.startsWith("manual")) {
				const result = await run(item.check);
				if (result.exit === 0) {
					log({ ask: item.ask, check: item.check, exit: 0, output: result.out });
					closed.add(item.key);
					notes.push(`Check passed, closed: ${item.ask}\nTell the user it's done.`);
					continue;
				}
				if (item.kind === "todo") notes.push(`${line}\n  check exit ${result.exit}: ${result.out.trim().split("\n").slice(-3).join(" | ")}`);
			} else if (item.kind === "todo") notes.push(line);
			if (!item.check) notes.push(`No check, add one: ${line}`);
			const user = /\(user\b[^()]*\)$/.test(item.ask);
			if (item.kind === "wait" && user && !/\(user: "[^"]+"\)$/.test(item.ask))
				notes.push(`Waits on the user without a question you asked, so it's yours: act on it, or ask and quote the question: ${line}`);
			let since = state[item.key]?.since ?? now;
			if (item.kind === "wait" && user && now - since > DAY) {
				notes.push(`Unanswered for a day, ask again or act on it: ${line}`);
				since = now;
			}
			next[item.key] = { line, check: item.check, since };
			keep.push(line);
		}
		for (const [key, old] of Object.entries(state)) {
			if (next[key] || dropped.has(key) || closed.has(key)) continue;
			keep.push(old.line);
			next[key] = old;
			notes.push(`Restored, deleted without closing it (manual checks close with a done line, else drop): ${old.line}`);
		}
		const out = keep.length ? `${keep.join("\n")}\n` : "";
		if (out !== text) writeFileSync(file, out);
		writeFileSync(stateFile, JSON.stringify(next));
		if (notes.length === 0 || nudges >= MAX || (nudges > 0 && calls === 0)) return;
		nudges += 1;
		nudging = true;
		pi.sendMessage(
			{
				customType: "work",
				content: `Open work:\n${notes.join("\n")}\n\nKeep going.`,
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
}
