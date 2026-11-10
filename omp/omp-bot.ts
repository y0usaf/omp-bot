import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome";
import { Loader } from "@oh-my-pi/pi-tui/components/loader";
import { col, elapsed, node, row, text } from "@oh-my-pi/pi-tui/native/describe";
import { isNativeSettled, settleNative } from "@oh-my-pi/pi-tui/native/settle";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { chaoOf, drawChao } from "./chao.ts";

const PATCHED = Symbol.for("omp-bot.transcript");
const HUD_PATCHED = Symbol.for("omp-bot.hud");
const NONE = col([], { role: "omp.bot.none" });
const BOOPS = ["boop.", "hey!", "hehe", "…again?"];
const NAP_MS = Number(process.env.OMP_BOT_NAP_MS) || 45000;
const HISTORY_CHUNK = 40;
const IDLE = ["Ready when you are.", "What are we building?", "Standing by.", "Ask me anything."];
const THINKING = ["Thinking it through", "Mulling it over", "Putting it together"];
const WORKING = ["Getting it done", "Making progress", "Working on it", "Handling it", "Chipping away"];
const DOING = {
	bash: "Running a few commands",
	eval: "Running a few commands",
	ssh: "Running a few commands",
	read: "Reading the file",
	grep: "Digging around",
	glob: "Digging around",
	find: "Digging around",
	ast_grep: "Digging around",
	lsp: "Digging around",
	edit: "Jotting it down",
	write: "Jotting it down",
	ast_edit: "Jotting it down",
	web_search: "Doing some reading",
	web_fetch: "Doing some reading",
	fetch: "Doing some reading",
	browser: "Clicking through pages",
	task: "Checking with helpers",
	wait: "Waiting on results",
	ask: "Needs your input",
};
const KEYS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const TIMERS = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimer: timer => clearTimeout(timer) };
const GAP_MS = 15 * 60 * 1000;
let lastCx;

function when(ts, hour12, now = new Date()) {
	const at = new Date(ts);
	const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", hour12 });
	if (at.toDateString() === now.toDateString()) return `Today ${time}`;
	const yesterday = new Date(now);
	yesterday.setDate(now.getDate() - 1);
	if (at.toDateString() === yesterday.toDateString()) return `Yesterday ${time}`;
	const day = at.getFullYear() === now.getFullYear() ? { weekday: "short", month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" };
	return `${at.toLocaleDateString([], day)} ${time}`;
}

function apart(ts, previous) {
	return previous === undefined || ts - previous >= GAP_MS || new Date(ts).toDateString() !== new Date(previous).toDateString();
}

function textKey(value) {
	return String(value ?? "").trim().slice(0, 200);
}

function firstText(content) {
	if (typeof content === "string") return content;
	return (Array.isArray(content) ? content : []).find(part => part?.type === "text")?.text ?? "";
}

function entryText(entry) {
	return entry?.type === "message" && (entry.message?.role === "user" || entry.message?.role === "assistant") ? firstText(entry.message.content) : "";
}

class Clock {
	constructor(session) {
		this.session = session;
		this.read = 0;
		this.texts = new Map();
		this.calls = new Map();
	}

	sync() {
		const entries = this.session?.getEntries?.() ?? [];
		for (; this.read < entries.length; this.read++) {
			const entry = entries[this.read];
			const ts = Date.parse(entry?.timestamp ?? "");
			if (!Number.isFinite(ts)) continue;
			if (entry.message?.role === "assistant") {
				for (const part of entry.message.content ?? []) if (part?.type === "toolCall" && part.id) this.calls.set(part.id, ts);
			}
			const key = textKey(entryText(entry));
			if (!key) continue;
			const list = this.texts.get(key);
			if (list) list.push(ts);
			else this.texts.set(key, [ts]);
		}
	}

	find(described) {
		const call = described?.p?.key;
		if (typeof call === "string" && this.calls.has(call)) return this.calls.get(call);
		return this.texts.get(textKey(bodyText(described)))?.pop();
	}
}

class BotTime {
	constructor(ts, user) {
		this.ts = ts;
		this.user = user;
	}

	invalidate() {}

	render(width) {
		const label = when(this.ts);
		return [truncateToWidth(`${" ".repeat(Math.max(0, Math.floor((width - label.length) / 2)))}${label}`, width)];
	}

	describe(cx) {
		return text(when(this.ts, cx?.hour12), { role: this.user ? "omp.bot.time.you" : "omp.bot.time.reply", wrap: "none" });
	}
}

function pick(list, seed) {
	return list[Math.abs(seed) % list.length];
}

function same(a, b) {
	return a.length === b.length && a.every((item, i) => item === b[i]);
}

class Bot {
	constructor() {
		this.name = process.env.OMP_BOT_NAME || "Pip";
		this.look = chaoOf(this.name, process.env.OMP_BOT_TINT);
		this.tint = this.look.tint;
		this.mood = "idle";
		this.line = pick(IDLE, Date.now());
		this.hero = true;
		this.turnStart = 0;
		this.submitted = 0;
		this.active = false;
		this.stopped = false;
		this.running = new Map();
		this.tui = undefined;
		this.clock = undefined;
		this.boop = undefined;
		this.boops = 0;
		this.typing = false;
		this.awake = ["idle", this.line];
		this.timers = {};
	}

	rename(name) {
		this.name = name;
		this.look = chaoOf(name, this.tint);
	}

	set(mood, line) {
		if (this.mood === mood && this.line === line) return;
		this.mood = mood;
		if (line !== undefined) this.line = line;
		this.render();
	}

	render() {
		this.tui?.requestRender?.();
	}

	after(key, ms, fn) {
		if (!this.clock) return;
		this.cancel(key);
		this.timers[key] = this.clock.setTimeout(fn, ms);
	}

	cancel(key) {
		if (this.timers[key] !== undefined) this.clock?.clearTimer(this.timers[key]);
		this.timers[key] = undefined;
	}

	stopTimers() {
		for (const key of Object.keys(this.timers)) this.cancel(key);
	}

	nap() {
		this.after("nap", NAP_MS, () => {
			if (this.active || this.mood === "sleep" || this.mood === "drowsy") return;
			this.awake = [this.mood === "happy" ? "idle" : this.mood, this.line];
			this.set("drowsy");
			this.after("nap", 12000, () => {
				if (!this.active && this.mood === "drowsy") this.set("sleep", "Napping. Boop to wake.");
			});
		});
	}

	wake() {
		if (this.mood === "sleep" || this.mood === "drowsy") this.set(...this.awake);
	}

	poke() {
		this.boop = BOOPS[this.boops++ % BOOPS.length];
		this.wake();
		this.render();
		this.after("boop", 1200, () => {
			this.boop = undefined;
			this.render();
		});
		if (!this.active) this.nap();
	}

	type() {
		this.wake();
		if (!this.typing) {
			this.typing = true;
			this.render();
		}
		this.after("typing", 1400, () => {
			this.typing = false;
			this.render();
		});
		if (!this.active) this.nap();
	}

	face() {
		return this.boop ? "boop" : this.typing && !this.active ? "listen" : this.mood;
	}

	chao() {
		return drawChao(this.look, this.face());
	}
}

class BotHero {
	constructor(bot) {
		this.bot = bot;
	}

	handleNativeEvent(event) {
		if (event?.type === "action" && event.act === "boop") this.bot.poke();
	}

	invalidate() {}

	render(width) {
		const b = this.bot;
		return [truncateToWidth(replaceTabs(` ◉ ${b.name} · ${b.boop ?? b.line}`), width)];
	}

	describe() {
		const b = this.bot;
		if (!b.hero) return col([], { role: "omp.bot.none" });
		return col(
			[
				b.chao(),
				col(
					[
						text(`Hi, I'm ${b.name}.`, { role: "omp.bot.hello", wrap: "none" }),
						text(b.boop ?? b.line, { role: "omp.bot.say", wrap: "none" }),
					],
					{ role: "omp.bot.words", align: "center", gap: "xs" },
				),
			],
			{ role: `omp.bot.hero.${b.tint}`, align: "center", gap: "sm" },
		);
	}
}

class BotTop {
	constructor(bot, stop) {
		this.bot = bot;
		this.stop = stop;
	}

	handleNativeEvent(event) {
		if (event?.type !== "action") return;
		if (event.act === "interrupt") this.stop();
		else if (event.act === "boop") this.bot.poke();
	}

	invalidate() {}

	render() {
		return [];
	}

	describe() {
		const b = this.bot;
		return row(
			[
				b.chao(),
				text(b.name, { role: "omp.bot.name", wrap: "none" }),
				b.active
					? row([text("Stop", { wrap: "none" }), node("kbd", { keys: ["escape"] })], {
							role: "omp.bot.stop",
							gap: "xs",
							align: "center",
							title: "Stop  esc",
							actions: { click: "interrupt" },
						})
					: undefined,
			].filter(Boolean),
			{ role: `omp.bot.top.${b.tint}`, align: "center", gap: "sm" },
		);
	}
}

class BotStatus {
	constructor(bot) {
		this.bot = bot;
	}

	handleNativeEvent(event) {
		if (event?.type === "action" && event.act === "boop") this.bot.poke();
	}

	invalidate() {}

	render() {
		return [];
	}

	describe() {
		const b = this.bot;
		const failed = !b.active && b.mood === "error";
		if (!b.active && !b.boop && !failed) return NONE;
		const asking = b.active && b.mood === "waiting" && b.running.size > 0;
		const busy = !b.boop && !asking && !failed;
		const status = b.boop ?? b.line;
		return row(
			[
				b.active || b.boop || failed ? b.chao() : drawChao(b.look, "waiting"),
				busy
					? node("shimmer", {
							spans: [{ t: status, s: "muted" }],
							mode: "classic",
							palette: { low: "dim", mid: "muted", high: "accent" },
							role: "omp.bot.say",
						})
					: text(status, { role: "omp.bot.say", wrap: "none", tone: asking ? "accent" : failed ? "error" : undefined }),
				b.active ? node("row", { role: "omp.bot.took" }, [elapsed(Date.now() - b.turnStart)]) : undefined,
			].filter(Boolean),
			{ role: `omp.bot.chat.${b.tint}`, align: "center", gap: "sm" },
		);
	}
}

function unsaid(child) {
	if (typeof child?.render === "function") return false;
	return String(child?.p?.role ?? "").startsWith("omp.thinking") || child?.p?.stream === true;
}

function says(child) {
	return typeof child?.render !== "function" && (child?.k === "md" || child?.k === "image" || child?.key === "error");
}

class BotReply {
	constructor(block) {
		this.block = block;
		this.whole = undefined;
		this.node = NONE;
	}

	invalidate() {
		this.block.invalidate?.();
	}

	render(width) {
		return this.block.render(width);
	}

	handleNativeEvent(event) {
		this.block.handleNativeEvent?.(event);
	}

	shows() {
		this.describe(lastCx);
		return this.node !== NONE;
	}

	describe(cx) {
		if (cx) lastCx = cx;
		const whole = this.block.describe(cx);
		if (whole === this.whole) return this.node;
		this.whole = whole;
		const children = (whole?.c ?? []).filter(child => !unsaid(child));
		this.node = children.some(says) ? col([{ ...whole, c: children }], { role: "omp.bot.reply" }) : NONE;
		return this.node;
	}
}

class Marked {
	constructor(items, role) {
		this.items = items;
		this.node = col(items, { role });
	}

	invalidate() {
		for (const item of this.items) item.invalidate?.();
	}

	render(width) {
		return this.items.flatMap(item => item.render(width));
	}

	describe() {
		return this.node;
	}
}

function headText(block) {
	return (block?.p?.head ?? []).map(part => part?.t ?? "").join("").trim();
}

function bodyText(block) {
	if (block?.k === "md" && typeof block?.p?.text === "string") return block.p.text;
	for (const child of block?.c ?? []) {
		if (typeof child === "object") {
			const body = bodyText(child);
			if (body) return body;
		}
	}
	return "";
}

function eventInfo(block) {
	const role = String(block?.p?.role ?? "");
	if (role !== "omp.user.collab") return undefined;
	const name = headText(block).match(/^«(.+?)»/)?.[1]?.trim();
	if (name) return { action: "Message from", name };
	return undefined;
}

class BotEvent {
	constructor(block, info, state) {
		this.block = block;
		this.info = info;
		this.bot = state.bot;
		this.look = chaoOf(info.name);
		this.open = false;
		this.node = undefined;
		this.drawn = undefined;
	}

	invalidate() {
		this.block.invalidate?.();
	}

	setExpanded(expanded) {
		this.open = expanded;
		this.bot.render();
	}
	handleNativeEvent(event) {
		if (event?.type === "action" && event.act === "toggle-event") {
			this.setExpanded(!this.open);
			return;
		}
		this.block.handleNativeEvent?.(event);
	}

	render(width) {
		const summary = truncateToWidth(` ${this.label()} ◉ ${this.info.name} ${this.open ? "−" : "+"}`, width);
		return this.open ? [summary, ...this.block.render(width)] : [summary];
	}

	label() {
		return this.info.action;
	}

	describe(cx) {
		if (cx) lastCx = cx;
		const label = this.label();
		const whole = this.open ? this.block.describe(cx) : undefined;
		const drawn = this.drawn;
		if (this.node && drawn.label === label && drawn.open === this.open && drawn.whole === whole) return this.node;
		const title = this.open ? "Hide full message" : "Show full message";
		let detail;
		if (whole) {
			detail = col([whole.k === "card" ? { ...whole, p: { ...whole.p, collapsible: false, collapsed: false, preview: undefined } } : whole], {
				role: "omp.bot.event.detail",
			});
		}
		this.node = col(
			[
				row(
					[
						text(label, { role: "omp.bot.event.action", wrap: "none" }),
						col([drawChao(this.look, "idle")], { role: "omp.bot.event.avatar" }),
						text(this.info.name, { role: "omp.bot.event.name", truncate: "end", shrink: 1 }),
						text(this.open ? "⌃" : "›", { role: "omp.bot.event.more", wrap: "none" }),
					],
					{
						role: "omp.bot.event.row",
						align: "center",
						justify: "center",
						gap: "xs",
						actions: { click: "toggle-event" },
						title,
						aria: title,
					},
				),
				detail,
			].filter(Boolean),
			{ role: `omp.bot.eventbox.${this.look.tint}`, align: "center", gap: "xs" },
		);
		this.drawn = { label, open: this.open, whole };
		return this.node;
	}
}

class BotHistory {
	constructor(bot, load) {
		this.bot = bot;
		this.load = load;
		this.node = row([text("Show earlier messages", { tone: "muted" })], {
			role: "omp.bot.history",
			justify: "center",
			actions: { click: "earlier" },
			aria: "Show earlier messages",
		});
	}

	invalidate() {}

	render() {
		return [];
	}

	describe() {
		return this.node;
	}

	handleNativeEvent(event) {
		if (event?.type !== "action" || event.act !== "earlier") return;
		this.load();
		this.bot.render();
	}
}
function asked(details) {
	if (!details || typeof details !== "object") return undefined;
	if (details.chatRedirect === true) return (details.questions ?? []).map(question => ({ question, redirect: true }));
	if (Array.isArray(details.results)) return details.results.every(q => typeof q?.question === "string" && Array.isArray(q.selectedOptions)) ? details.results : undefined;
	return typeof details.question === "string" && Array.isArray(details.selectedOptions) ? [details] : undefined;
}

function answered(questions, tint) {
	const parts = questions.flatMap(q => {
		const options = Array.isArray(q.options) ? q.options : [];
		const chosen = q.selectedOptions ?? [];
		const picks = options.flatMap((label, i) => (chosen.includes(label) ? [[KEYS[i] ?? "•", label]] : []));
		for (const label of chosen) if (!options.includes(label)) picks.push(["•", label]);
		if (typeof q.customInput === "string") picks.push([KEYS[options.length] ?? "•", q.customInput]);
		const rows = picks.map(([key, label]) =>
			row([node("badge", { text: key, tone: "accent" }), text(label, { wrap: "word", shrink: 1 })], { role: "omp.bot.asked.pick", align: "center", gap: "sm" }),
		);
		const notes = [
			q.redirect ? "Talked it over in chat instead" : undefined,
			!q.redirect && rows.length === 0 ? "Nothing picked" : undefined,
			q.timedOut ? "Picked automatically when the question timed out" : undefined,
			typeof q.note === "string" && q.note ? q.note : undefined,
		].filter(Boolean);
		return [text(q.question, { role: "omp.bot.asked.q", wrap: "word" }), ...rows, ...notes.map(note => text(note, { role: "omp.bot.asked.note", wrap: "word", tone: "muted" }))];
	});
	return col([node("card", { role: "omp.bot.asked" }, parts)], { role: `omp.bot.answer.${tint}` });
}

class BotAnswer {
	constructor(block, questions, tint) {
		this.block = block;
		this.questions = questions;
		this.node = answered(questions, tint);
	}

	invalidate() {
		this.block.invalidate?.();
	}

	render(width) {
		return this.block.render(width);
	}

	describe() {
		return this.node;
	}
}

function patchTranscript(state) {
	const proto = TranscriptContainer.prototype;
	if (proto[PATCHED]) {
		proto[PATCHED].state = state;
		return;
	}
	const inner = proto.nativeBlocks;
	const clear = proto.clear;
	const shownBy = new WeakMap();
	const wrapped = new WeakMap();
	const events = new WeakMap();
	const advice = new WeakMap();
	const stamps = new WeakMap();
	const times = new WeakMap();
	const mores = new WeakMap();
	const answers = new WeakMap();
	const pages = new WeakMap();
	proto[PATCHED] = { state };

	const updateResult = ToolExecutionComponent.prototype.updateResult;
	ToolExecutionComponent.prototype.updateResult = function (result, isPartial, toolCallId) {
		const questions = isPartial || result?.isError ? undefined : asked(result?.details);
		if (questions) answers.set(this, questions);
		return updateResult.call(this, result, isPartial, toolCallId);
	};

	proto.clear = function () {
		pages.delete(this);
		const s = proto[PATCHED].state;
		if (s.clock) {
			s.clock = new Clock(s.clock.session);
		}
		return clear.call(this);
	};

	function advises(block) {
		let is = advice.get(block);
		if (is === undefined) {
			is = block.describe?.()?.p?.role === "omp.advisor";
			advice.set(block, is);
		}
		return is;
	}

	function shown(block) {
		if (block?.mode === "thinking" || advises(block)) return undefined;
		const questions = answers.get(block);
		if (questions) {
			let kept = wrapped.get(block);
			if (kept?.questions !== questions) {
				kept = new BotAnswer(block, questions, proto[PATCHED].state.bot.tint);
				wrapped.set(block, kept);
			}
			if (isNativeSettled(block) && !isNativeSettled(kept)) settleNative(kept);
			return kept;
		}
		const source = block?.source ?? block;
		const reply = source instanceof AssistantMessageComponent;
		let event = reply ? null : events.get(block);
		if (!reply && event === undefined) {
			event = eventInfo(block.describe?.(lastCx)) ?? null;
			events.set(block, event);
		}
		const notice = !reply && !event && !(block instanceof UserMessageComponent) && block.describe?.(lastCx)?.p?.role === "omp.custom";
		if (!reply && !(block instanceof UserMessageComponent) && !event && !notice) return block;
		let wrapper = wrapped.get(block);
		if (!wrapper) {
			wrapper = reply
				? new BotReply(block)
				: event
					? new BotEvent(block, event, proto[PATCHED].state)
					: new Marked([block], notice ? "omp.bot.notice" : "omp.bot.you");
			wrapped.set(block, wrapper);
		}
		if (isNativeSettled(block) && !isNativeSettled(wrapper)) settleNative(wrapper);
		return wrapper;
	}

	function stamp(item, restoring) {
		const block = item.block ?? item.items?.[0];
		if (!block) return undefined;
		if (stamps.has(block)) return stamps.get(block) ?? undefined;
		const s = proto[PATCHED].state;
		const ts = item.info?.ts ?? (restoring ? (s.clock?.find(block.describe?.(lastCx)) ?? (s.bot.hero ? Date.now() : null)) : Date.now());
		stamps.set(block, ts);
		return ts ?? undefined;
	}

	function moreOf(item) {
		let more = mores.get(item);
		if (!more) {
			more = new Marked([], "omp.bot.more");
			mores.set(item, more);
		}
		return more;
	}

	function timeOf(item, ts) {
		let time = times.get(item);
		if (time?.ts !== ts) {
			time = new BotTime(ts, item instanceof Marked && item.node.p.role === "omp.bot.you");
			times.set(item, time);
		}
		return time;
	}

	proto.nativeBlocks = function () {
		const blocks = inner.call(this);
		const s = proto[PATCHED].state;
		if (!s.on || !s.top) return blocks;
		let page = pages.get(this);
		if (!page && blocks.length > 0) {
			s.clock?.sync();
			page = { start: Math.max(0, blocks.length - HISTORY_CHUNK), restored: blocks.length };
			page.control = new BotHistory(s.bot, () => {
				page.start = Math.max(0, page.start - HISTORY_CHUNK);
			});
			pages.set(this, page);
		}
		const start = page?.start ?? 0;
		for (let i = blocks.length - 1; i >= start; i--) {
			const item = shown(blocks[i]);
			if (item instanceof BotReply ? item.shows() : item instanceof Marked || item instanceof BotEvent || item instanceof BotAnswer) {
				stamp(item, i < page.restored);
			}
		}
		const shownBlocks = [s.top];
		if (start > 0) shownBlocks.push(page.control);
		let last;
		let previous;
		for (let i = start; i < blocks.length; i++) {
			const item = shown(blocks[i]);
			if (!item) continue;
			const visible = item instanceof BotReply ? item.shows() : item instanceof Marked || item instanceof BotEvent || item instanceof BotAnswer;
			if (!visible) {
				shownBlocks.push(item);
				continue;
			}
			const ts = stamp(item);
			const separated = ts !== undefined && apart(ts, last);
			if (separated) shownBlocks.push(timeOf(item, ts));
			if (ts !== undefined) last = ts;
			if (item instanceof BotReply && previous instanceof BotReply && !separated) shownBlocks.push(moreOf(item));
			previous = item;
			shownBlocks.push(item);
		}
		if (!s.bot.hero) shownBlocks.push(s.status);
		const before = shownBy.get(this);
		if (before && same(before, shownBlocks)) return before;
		shownBy.set(this, shownBlocks);
		return shownBlocks;
	};
}

function patchWorkingRow(state) {
	const proto = Loader.prototype;
	if (proto[HUD_PATCHED]) {
		proto[HUD_PATCHED].state = state;
		return;
	}
	const innerRender = proto.render;
	const innerDescribe = proto.describe;
	proto[HUD_PATCHED] = { state };
	proto.render = function (width) {
		return proto[HUD_PATCHED].state.on ? [] : innerRender.call(this, width);
	};
	proto.describe = function (cx) {
		return proto[HUD_PATCHED].state.on ? row([]) : innerDescribe.call(this, cx);
	};
}

export default function ompBot(pi) {
	const bot = new Bot();
	const state = {
		on: process.env.OMP_BOT !== "0",
		bot,
		top: undefined,
		status: new BotStatus(bot),
		clock: undefined,
	};
	let ui;
	let abort;
	let unlisten;

	pi.setLabel("Bot mode");

	function mount() {
		if (!ui) return;
		state.top = new BotTop(bot, () => abort?.());
		ui.setWidget(
			"omp-bot",
			state.on
				? tui => {
						bot.tui = tui;
						return new BotHero(bot);
					}
				: undefined,
		);
		ui.setWidget("omp-bot-floor", state.on && bot.hero ? () => new BotFloor() : undefined, { placement: "belowEditor" });
	}

	function attach(ctx) {
		ui = ctx.ui;
		bot.clock = typeof ctx.setTimeout === "function" && typeof ctx.clearTimer === "function" ? ctx : TIMERS;
		abort = () => {
			bot.stopped = true;
			ctx.abort();
		};
	}

	function listen() {
		unlisten?.();
		unlisten = ui.onTerminalInput(data => {
			if (state.on && typeof data === "string" && data.length > 0 && data[0] !== "\x1b") bot.type();
		});
	}

	function begin(_event, ctx) {
		if (ctx.agent?.kind === "sub" || ctx.mode !== "tui") return;
		attach(ctx);
		bot.hero = !ctx.sessionManager?.getEntries?.().some(entry => entry.type === "message");
		state.clock = new Clock(ctx.sessionManager);
		patchTranscript(state);
		patchWorkingRow(state);
		listen();
		mount();
		bot.nap();
	}

	pi.on("session_start", begin);
	pi.on("session_switch", begin);

	pi.on("session_shutdown", async () => {
		bot.stopTimers();
		unlisten?.();
		unlisten = undefined;
	});

	pi.registerCommand("bot", {
		description: "Bot mode: a Chao that works for you; /bot toggles it, /bot name NAME renames it",
		handler: async (args, ctx) => {
			const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "name" && parts[1]) {
				bot.rename(parts.slice(1).join(" "));
				bot.set(bot.mood, `Hi, I'm ${bot.name}.`);
			} else {
				state.on = !state.on;
			}
			attach(ctx);
			mount();
			bot.render();
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent?.kind !== "sub") bot.submitted = Date.now();
		if (ctx.agent?.kind === "sub" || !state.on || !Array.isArray(event.systemPrompt) || event.systemPrompt.length === 0) return undefined;
		const persona = `\n# Bot mode\nThe user sees you in their terminal as ${bot.name}, a small Chao: your replies and one status word, nothing else.\n`;
		const systemPrompt = [...event.systemPrompt];
		systemPrompt[systemPrompt.length - 1] = `${systemPrompt[systemPrompt.length - 1]}${persona}`;
		return { systemPrompt };
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		bot.cancel("settle");
		bot.cancel("nap");
		bot.turnStart = bot.submitted || Date.now();
		bot.submitted = 0;
		bot.active = true;
		bot.stopped = false;
		bot.running.clear();
		if (bot.hero) {
			bot.hero = false;
			mount();
		}
		bot.set("thinking", pick(THINKING, bot.turnStart));
	});

	pi.on("message_update", async (event, ctx) => {
		if (ctx.agent?.kind === "sub" || !bot.active || bot.running.size > 0) return;
		const kind = event.assistantMessageEvent?.type;
		if (kind === "text_delta" || kind === "text_start") bot.set("talking", "Writing it up");
		else if (kind === "thinking_delta" || kind === "thinking_start") bot.set("thinking", bot.mood === "thinking" ? bot.line : pick(THINKING, Date.now()));
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		const label = DOING[event.toolName] ?? pick(WORKING, bot.turnStart + bot.running.size);
		bot.running.set(event.toolCallId, label);
		bot.set(label === DOING.ask ? "waiting" : "working", label);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		bot.running.delete(event.toolCallId);
		if (event.isError) {
			bot.set("error", "A step failed");
			return;
		}
		const left = [...bot.running.values()].at(-1);
		bot.set(left === undefined ? "thinking" : left === DOING.ask ? "waiting" : "working", left ?? pick(THINKING, Date.now()));
	});

	pi.on("agent_end", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		if (event.willContinue) {
			bot.set("thinking", pick(THINKING, Date.now()));
			return;
		}
		bot.active = false;
		bot.running.clear();
		bot.nap();
		const final = event.messages?.findLast(message => message.role === "assistant");
		const reason = final?.stopReason;
		if (reason === "aborted" && !bot.stopped && ctx.hasPendingMessages()) return;
		if (bot.stopped || reason === "aborted") {
			bot.set("idle", "Stopped. Ready when you are.");
			return;
		}
		if (reason === "error" || reason === "length") {
			bot.set("error", final.errorMessage || "The reply ended early — check the transcript");
			return;
		}
		bot.set("happy", "Done");
		bot.after("settle", 4000, () => bot.mood === "happy" && bot.set("idle", "Ready"));
	});
}

class BotFloor {
	invalidate() {}

	render() {
		return [];
	}

	describe() {
		return text("\u00a0", { role: "omp.bot.floor" });
	}
}
