import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { STATE } from "./paths.ts";

const BOT = join(STATE, "bots", process.env.OMP_BOT_NAME ?? "-");
const DIR = join(BOT, "helpers");
const BOOT = join(BOT, "boot");
const TAIL = 65536;
const SLACK = 60000;
const KEEP = 24 * 60 * 60 * 1000;
const OUTPUT = 6000;

const key = (parent, id) => `${basename(parent, ".jsonl")}.${String(id).replace(/[^A-Za-z0-9._-]/g, "_")}`;

function lines(file) {
	try {
		const size = statSync(file).size;
		const length = Math.min(size, TAIL);
		const buffer = Buffer.allocUnsafe(length);
		const fd = openSync(file, "r");
		try {
			readSync(fd, buffer, 0, length, size - length);
		} finally {
			closeSync(fd);
		}
		const out = buffer.toString("utf8").split("\n");
		if (length < size) out.shift();
		return out;
	} catch {
		return [];
	}
}

function lastMessage(file) {
	for (const line of lines(file).reverse()) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry?.type !== "message") continue;
		const message = entry.message;
		const text = Array.isArray(message?.content)
			? message.content
					.filter(part => part?.type === "text")
					.map(part => part.text)
					.join("")
					.trim()
			: "";
		return { role: message?.role, stop: message?.stopReason, text };
	}
	return undefined;
}

function delivered(session, id) {
	return session.includes(`task-result id=\\"${id}\\"`);
}

export default function supervise(pi) {
	if (!process.env.OMP_BOT_NAME) return;
	let ctx;
	let booted = false;

	pi.setLabel("Bot helpers");

	const register = c => {
		if (c.agent?.kind !== "sub" || (c.agent.depth ?? 0) > 1) return;
		const transcript = c.sessionManager?.getSessionFile?.();
		if (!transcript) return;
		const parent = `${dirname(transcript)}.jsonl`;
		if (!existsSync(parent)) return;
		mkdirSync(DIR, { recursive: true });
		writeFileSync(
			join(DIR, `${key(parent, c.agent.id)}.json`),
			JSON.stringify({ id: c.agent.id, agent: c.agent.name, transcript, parent, since: Date.now() }),
		);
	};

	const recover = c => {
		const session = c.sessionManager?.getSessionFile?.();
		if (!session) return;
		let previous = 0;
		if (!booted) {
			booted = true;
			try {
				previous = Number(readFileSync(BOOT, "utf8")) || 0;
			} catch {}
			try {
				mkdirSync(BOT, { recursive: true });
				writeFileSync(BOOT, String(Date.now()));
			} catch {}
		}
		let files;
		try {
			files = readdirSync(DIR);
		} catch {
			return;
		}
		let parent = "";
		const found = [];
		for (const name of files) {
			if (!name.endsWith(".json")) continue;
			const file = join(DIR, name);
			let entry;
			try {
				entry = JSON.parse(readFileSync(file, "utf8"));
			} catch {
				rmSync(file, { force: true });
				continue;
			}
			if (!entry?.id || !entry?.transcript) {
				rmSync(file, { force: true });
				continue;
			}
			if (entry.reported) {
				if (Date.now() - entry.reported > KEEP) rmSync(file, { force: true });
				continue;
			}
			if (Date.now() - (entry.since ?? 0) > KEEP || !existsSync(entry.transcript)) {
				rmSync(file, { force: true });
				continue;
			}
			if (entry.parent !== session) continue;
			const words = lastMessage(entry.transcript);
			if (!words || words.role !== "assistant" || !words.text) continue;
			if (words.stop === "aborted" || words.stop === "error") continue;
			let mtime = 0;
			try {
				mtime = statSync(entry.transcript).mtimeMs;
			} catch {
				continue;
			}
			if (mtime < previous - SLACK || mtime > Date.now()) continue;
			if (!parent) {
				try {
					parent = readFileSync(session, "utf8");
				} catch {
					return;
				}
			}
			if (delivered(parent, entry.id)) {
				rmSync(file, { force: true });
				continue;
			}
			found.push({ ...entry, text: words.text });
		}
		if (found.length === 0) return;
		const blocks = found.map(entry => {
			const text =
				entry.text.length > OUTPUT ? `${entry.text.slice(0, OUTPUT)}\n…(cut; the rest is in ${entry.transcript})` : entry.text;
			return `<task-result id="${entry.id}" agent="${entry.agent}" status="completed" recovered="restart">\n<output>\n${text}\n</output>\n</task-result>`;
		});
		pi.sendMessage(
			{
				customType: "helper-result",
				content: `<system-notice>\n${found.length === 1 ? "A background job finished" : `${found.length} background jobs finished`} before this session restarted, and ${found.length === 1 ? "its result never reached you" : "their results never reached you"}. Resume your work using ${found.length === 1 ? "it" : "them"} below.\n${blocks.join("\n")}\n</system-notice>`,
				display: true,
				attribution: "agent",
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
		for (const entry of found) {
			try {
				writeFileSync(join(DIR, `${key(entry.parent, entry.id)}.json`), JSON.stringify({ ...entry, reported: Date.now() }));
			} catch {}
		}
	};

	pi.on("session_start", async (_event, c) => {
		ctx = c;
		if (c.agent?.kind === "sub") {
			register(c);
			return;
		}
		c.setTimeout(() => {
			try {
				recover(c);
			} catch (error) {
				ctx?.ui?.notify?.(`omp-bot: couldn't recover helper results: ${error?.message ?? error}`, "warning");
			}
		}, 1500);
	});
}
