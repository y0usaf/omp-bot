import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE } from "./paths.ts";

const ASK = 60;
const TAIL = 1200;
const HEAD = "check passed";

export function brief(text) {
	const line = String(text ?? "")
		.replace(/\s+/g, " ")
		.trim();
	if (line.length <= ASK) return line;
	return `${line.slice(0, ASK - 1).trimEnd()}…`;
}

function clip(text, width) {
	if (width <= 1 || text.length <= width) return text;
	return `${text.slice(0, Math.max(0, width - 1))}${"…"}`;
}

function headOf(details) {
	return [{ t: brief(details?.ask) || "helper", s: "muted" }, { t: ` · ${HEAD}`, s: "dim" }];
}

function headText(details) {
	return `${brief(details?.ask) || "helper"} · ${HEAD}`;
}

class QuietDone {
	constructor(message, expanded) {
		this.message = message;
		this.expanded = expanded === true;
		this.node = undefined;
	}

	invalidate() {
		this.node = undefined;
	}

	describe() {
		const expanded = this.expanded;
		if (this.node?.expanded === expanded) return this.node.value;
		const details = this.message.details;
		const card = {
			k: "card",
			p: {
				role: "omp.custom",
				variant: "bare",
				head: headOf(details),
				collapsible: true,
				collapsed: !expanded,
				preview: "none",
			},
			c: [{ k: "md", p: { text: String(this.message.content ?? "") } }],
		};
		this.node = { expanded, value: card };
		return card;
	}

	handleNativeEvent(event) {
		if (event?.type !== "toggle" || event.key !== "") return;
		this.expanded = !event.collapsed;
		this.node = undefined;
	}

	render(width) {
		const lines = [clip(headText(this.message.details), width)];
		if (!this.expanded) return lines;
		for (const line of String(this.message.content ?? "").split("\n")) lines.push(clip(line, width));
		return lines;
	}
}

function noticeDir() {
	return join(STATE, "bots", process.env.OMP_BOT_NAME ?? "-", "quiet");
}

function keepNotice(payload) {
	const file = join(noticeDir(), `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}.json`);
	mkdirSync(noticeDir(), { recursive: true });
	writeFileSync(file, JSON.stringify(payload));
	return () => rmSync(file, { force: true });
}

function replayNotices(pi, ctx) {
	if (ctx?.isIdle && !ctx.isIdle()) {
		ctx.setTimeout(() => replayNotices(pi, ctx), 500);
		return;
	}
	let names;
	try {
		names = readdirSync(noticeDir()).sort();
	} catch {
		return;
	}
	for (const name of names) {
		const file = join(noticeDir(), name);
		let payload;
		try {
			payload = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			rmSync(file, { force: true });
			continue;
		}
		try {
			pi.sendMessage(payload);
		} catch {
			return;
		}
		rmSync(file, { force: true });
	}
}

export function installQuietDone(pi) {
	for (const type of ["done-check", "work"]) {
		pi.registerMessageRenderer(type, (message, options) =>
			message?.details?.passed === true ? new QuietDone(message, options?.expanded) : undefined,
		);
	}
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		ctx.setTimeout(() => replayNotices(pi, ctx), 1000);
	});
}

function log(entry) {
	const name = process.env.OMP_BOT_NAME;
	if (!name) return;
	const file = join(STATE, "bots", name, "done.log");
	try {
		mkdirSync(dirname(file), { recursive: true });
		appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
	} catch {}
}

/**
 * Record and post a passing check as one quiet line. The log entry and the
 * queued notice are written first, so a restart while the line waits for an
 * idle session still keeps both; the notice replays at the next start. No
 * `deliverAs` and no `triggerTurn`, so an idle append starts no turn.
 *
 * @param {{ask?: string, check?: string, output?: string, note?: string, type?: string, agent?: string}} done
 */
export function announceDone(pi, done, ctx) {
	const ask = String(done.ask ?? "").replace(/\s+/g, " ").trim() || "helper";
	const check = String(done.check ?? "").trim();
	const output = String(done.output ?? "").trim();
	const note = done.note ? brief(done.note) : "";
	const content = [`${ask} — ${HEAD}${note ? ` ${note}` : ""}`];
	if (check) content.push(`\`${check}\``);
	if (output) content.push(output.length > TAIL ? `${output.slice(0, TAIL)}…` : output);
	const payload = {
		customType: done.type ?? "done-check",
		content: content.join("\n\n"),
		display: true,
		attribution: "agent",
		details: { passed: true, ask },
	};
	log({ ask, check: check || undefined, agent: done.agent, exit: 0, output: output || undefined });
	let clear = () => {};
	try {
		clear = keepNotice(payload);
	} catch {}
	const post = () => {
		try {
			pi.sendMessage(payload);
		} catch {
			return;
		}
		const timer = setTimeout(clear, 5000);
		timer?.unref?.();
	};
	if (!ctx?.isIdle || ctx.isIdle()) {
		post();
		return;
	}
	const later = () => {
		if (ctx.isIdle()) post();
		else ctx.setTimeout(later, 250);
	};
	ctx.setTimeout(later, 250);
}
