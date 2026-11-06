import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome";
import { Loader } from "@oh-my-pi/pi-tui/components/loader";
import { col, elapsed, node, row, text } from "@oh-my-pi/pi-tui/native/describe";
import { isNativeSettled, settleNative } from "@oh-my-pi/pi-tui/native/settle";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { chaoOf, drawChao } from "./chao.ts";

const PATCHED = Symbol.for("omp-bot.transcript");
const HUD_PATCHED = Symbol.for("omp-bot.hud");
const DOCK_PATCHED = Symbol.for("omp-bot.dock");
const NONE = col([], { role: "omp.bot.none" });
const BOOPS = ["boop.", "hey!", "hehe", "…again?"];
const NAP_MS = Number(process.env.OMP_BOT_NAP_MS) || 45000;
const IDLE = ["Ready when you are.", "What are we building?", "Standing by.", "Ask me anything."];
const THINKING = ["Thinking…", "Hmm, let me see…", "Mulling it over…", "Working it out…"];
const TIMERS = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimer: timer => clearTimeout(timer) };
const GAP_MS = 15 * 60 * 1000;
const PENDING = Symbol("pending");
const HIDDEN = Symbol("hidden");
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
	if (entry?.type === "message") return entry.message?.role === "user" || entry.message?.role === "assistant" ? firstText(entry.message.content) : "";
	if (entry?.type !== "custom_message") return "";
	return String(entry.customType ?? "").startsWith("irc:") && typeof entry.details?.message === "string" ? entry.details.message : firstText(entry.content);
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
		this.sync();
		const call = described?.p?.key;
		if (typeof call === "string" && this.calls.has(call)) return this.calls.get(call);
		return this.texts.get(textKey(bodyText(described)))?.shift();
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
		this.failed = false;
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
		const busy = b.active && !b.boop;
		const status = b.boop ?? b.line;
		return row(
			[
				b.chao(),
				busy
					? node("shimmer", {
							spans: [{ t: status, s: "muted" }],
							mode: "classic",
							palette: { low: "dim", mid: "muted", high: "accent" },
							role: "omp.bot.say",
						})
					: text(status, { role: "omp.bot.say", wrap: "none" }),
				busy ? node("row", { role: "omp.bot.took" }, [elapsed(Date.now() - b.turnStart)]) : undefined,
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

function spansText(spans) {
	return (Array.isArray(spans) ? spans : []).map(part => part?.t ?? "").join("");
}

function withRole(node, role) {
	if (!node || typeof node !== "object") return undefined;
	if (node.p?.role === role) return node;
	for (const child of node.c ?? []) {
		const found = withRole(child, role);
		if (found) return found;
	}
	return undefined;
}

const GLYPHS = /^[←→›\uE000-\uF8FF\s]+/;

function eventInfo(block, bot) {
	const role = String(block?.p?.role ?? "");
	const head = headText(block);
	if (role === "omp.tool.write") {
		const title = block.p.title ?? block.c?.[0]?.c?.[0]?.p?.spans ?? [];
		if (spansText(title.slice(0, 1)).trim() !== "IRC") return undefined;
		const name = title.slice(1).find(part => String(part?.s ?? "").includes("accent"))?.t?.trim();
		const settled = block.p.status === "done" || block.p.status === "error";
		if (!name || name === "…") return settled ? undefined : PENDING;
		if (name === "all") return undefined;
		const preview = withRole(block, "omp.tool.proc.preview");
		return { action: "Messaged", name, from: bot.name, body: spansText(preview?.p?.spans) || preview?.p?.text || "" };
	}
	if (role.startsWith("omp.irc.")) {
		const body = bodyText(block);
		if (role === "omp.irc.incoming") {
			const name = head.replace(/^IRC\s+/, "").replace(GLYPHS, "").trim();
			if (name) return { action: "Message from", name, from: name, body, card: true };
		}
		const routed = head.match(/^(?:IRC|Pool)\s+(.+?)\s*(?:→|->|›|[\uE000-\uF8FF])+\s*(.+)$/);
		if (routed) {
			const name = routed[2].trim();
			return { action: "Messaged", name, from: routed[1].replace(GLYPHS, "").trim() || bot.name, body };
		}
		const name = head.match(/^(?:IRC|Pool)\s+(.+)$/)?.[1]?.replace(GLYPHS, "").trim();
		if (name) return { action: "Messaged", name, from: bot.name, body };
	}
	const body = bodyText(block);
	if (head === "ompd-job" || body.startsWith("[ompd job ")) return HIDDEN;
	if (body.startsWith("[omp-bot task ")) {
		const marker = body.slice(0, body.indexOf("]") + 1);
		const origin = marker.match(/from (?:bot|reply):(.+?)(?:,|\])/)?.[1]?.trim();
		return origin
			? { action: "Task from", name: origin, from: origin, body: body.slice(marker.length).trim() }
			: { action: "Task for", name: bot.name };
	}
	if (role === "omp.user.collab") {
		const name = head.match(/^«(.+?)»/)?.[1]?.trim();
		if (name) return { action: "Message from", name };
	}
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


function patchTranscript(state) {
	const proto = TranscriptContainer.prototype;
	if (proto[PATCHED]) {
		proto[PATCHED].state = state;
		return;
	}
	const inner = proto.nativeBlocks;
	const removable = proto.canRemoveBlock;
	const clear = proto.clear;
	const shownBy = new WeakMap();
	const wrapped = new WeakMap();
	const events = new WeakMap();
	const advice = new WeakMap();
	const stamps = new WeakMap();
	const times = new WeakMap();
	const mores = new WeakMap();
	const collected = new WeakMap();
	proto[PATCHED] = { state };

	const updateResult = ToolExecutionComponent.prototype.updateResult;
	ToolExecutionComponent.prototype.updateResult = function (result, isPartial, toolCallId) {
		const waited = !isPartial && result?.details?.op === "wait" ? result.details.waited : undefined;
		if (typeof waited?.from === "string") {
			const body = String(waited.body ?? "");
			collected.set(this, { action: "Message from", name: waited.from, from: waited.from, body, ts: Number(waited.ts) || undefined });
		}
		return updateResult.call(this, result, isPartial, toolCallId);
	};

	proto.canRemoveBlock = function (component) {
		if (proto[PATCHED].state.on && String(component?.describe?.()?.p?.role ?? "").startsWith("omp.irc.")) return false;
		return removable.call(this, component);
	};

	proto.clear = function () {
		const s = proto[PATCHED].state;
		if (s.clock) {
			s.clock = new Clock(s.clock.session);
			s.restoring = true;
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
		const source = block?.source ?? block;
		const reply = source instanceof AssistantMessageComponent;
		let event = reply ? null : (collected.get(block) ?? events.get(block));
		if (!reply && event === undefined) {
			event = eventInfo(block.describe?.(lastCx), proto[PATCHED].state.bot) ?? null;
			if (event !== PENDING) events.set(block, event);
		}
		if (event === PENDING) return block;
		if (event === HIDDEN) return undefined;
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

	function stamp(item) {
		const block = item.block ?? item.items?.[0];
		if (!block) return undefined;
		if (stamps.has(block)) return stamps.get(block) ?? undefined;
		const s = proto[PATCHED].state;
		const ts = item.info?.ts ?? (s.restoring ? (s.clock?.find(block.describe?.(lastCx)) ?? (s.bot.hero ? Date.now() : null)) : Date.now());
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
		const shownBlocks = [s.top];
		let last;
		let previous;
		const taken = [];
		for (const block of blocks) {
			const waited = collected.get(block);
			if (waited) taken.push(waited);
		}
		for (const block of blocks) {
			const item = shown(block);
			if (!item) continue;
			if (taken.length > 0 && item instanceof BotEvent && item.info.card) {
				const body = item.info.body.trim();
				const at = taken.findIndex(waited => waited.from === item.info.from && waited.body.trim() === body);
				if (at >= 0) {
					taken.splice(at, 1);
					continue;
				}
			}
			const visible = item instanceof BotReply ? item.shows() : item instanceof Marked || item instanceof BotEvent;
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
		if (blocks.length > 0) s.restoring = false;
		if (!s.bot.hero) shownBlocks.push(s.status);
		const before = shownBy.get(this);
		if (before && same(before, shownBlocks)) return before;
		shownBy.set(this, shownBlocks);
		return shownBlocks;
	};
}

function patchDock(state) {
	const proto = Composer.prototype;
	if (proto[DOCK_PATCHED]) {
		proto[DOCK_PATCHED].state = state;
		return;
	}
	const inner = proto.describeSurface;
	const docks = new WeakMap();
	proto[DOCK_PATCHED] = { state };
	proto.describeSurface = function (cx) {
		const surface = inner.call(this, cx);
		if (!proto[DOCK_PATCHED].state.on) return surface;
		let marked = docks.get(surface);
		if (!marked) {
			marked = { ...surface, dock: [new Marked(surface.dock, "omp.bot.dock")] };
			docks.set(surface, marked);
		}
		return marked;
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
		restoring: false,
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

	async function begin(_event, ctx) {
		if (ctx.agent?.kind === "sub" || ctx.mode !== "tui") return;
		attach(ctx);
		bot.hero = !ctx.sessionManager?.getEntries?.().some(entry => entry.type === "message");
		state.clock = new Clock(ctx.sessionManager);
		state.restoring = true;
		patchTranscript(state);
		patchWorkingRow(state);
		patchDock(state);
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
		bot.failed = false;
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
		if (kind === "text_delta" || kind === "text_start") bot.set("talking", "Writing it up…");
		else if (kind === "thinking_delta" || kind === "thinking_start") bot.set("thinking", bot.mood === "thinking" ? bot.line : pick(THINKING, Date.now()));
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		bot.running.set(event.toolCallId, true);
		const target =
			event.toolName === "write" && typeof event.args?.path === "string"
				? event.args.path.match(/^agent:\/\/([^/]+)$/)?.[1]
				: undefined;
		bot.set(
			event.toolName === "ask" ? "waiting" : "working",
			event.toolName === "ask" ? "Waiting on you" : target ? `Messaging ${target}` : "Working",
		);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		bot.running.delete(event.toolCallId);
		if (event.isError) {
			bot.failed = true;
			bot.set("error", "A step failed");
			return;
		}
		bot.set(bot.running.size > 0 ? "working" : "thinking", bot.running.size > 0 ? "Working" : bot.line);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		if (event.willContinue) {
			bot.set("waiting", "Waiting for helpers…");
			return;
		}
		bot.active = false;
		bot.running.clear();
		bot.nap();
		const final = event.messages?.findLast(message => message.role === "assistant");
		const reason = final?.stopReason;
		if (bot.stopped || reason === "aborted") {
			bot.set("idle", "Stopped. Ready when you are.");
			return;
		}
		if (reason === "error" || reason === "length") {
			bot.set("error", final.errorMessage || "The reply ended early — check the transcript");
			return;
		}
		if (bot.failed) {
			bot.failed = false;
			bot.set("error", "Done · a step failed");
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
