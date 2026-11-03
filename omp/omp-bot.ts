import { AssistantMessageComponent } from "@oh-my-pi/pi-tui/chat/assistant-message";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { chatTranscriptDisplayPreferences } from "@oh-my-pi/pi-tui/chat/display-preferences";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome";
import { Loader } from "@oh-my-pi/pi-tui/components/loader";
import { Composer } from "@oh-my-pi/pi-tui/prompt/composer";
import { col, node, row, text } from "@oh-my-pi/pi-tui/native/describe";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";

const PATCHED = Symbol.for("omp-bot.transcript");
const HUD_PATCHED = Symbol.for("omp-bot.hud");
const DOCK_PATCHED = Symbol.for("omp-bot.dock");
const TINTS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];
const ZONES = ["nw", "ne", "w", "e", "sw", "se", "n", "s"];
const BOOPS = ["boop.", "hey!", "hehe", "…again?"];
const NAP_MS = Number(process.env.OMP_BOT_NAP_MS) || 45000;
const IDLE = ["Ready when you are.", "What are we building?", "Standing by.", "Ask me anything."];
const THINKING = ["Thinking…", "Hmm, let me see…", "Mulling it over…", "Working it out…"];
const SEED = 0x811cb697;
const TRAITS = [
	["eyes", ["pill", "round", "visor", "lids", "dots"]],
	["rings", ["atom", "saturn", "twin", "orbit"]],
	["gear", ["antenna", "sprout", "halo", "ears", "moon"]],
	["glow", ["drift", "pulse", "flare"]],
	["tempo", ["calm", "even", "brisk"]],
	["tint", TINTS],
];
const TIMERS = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimer: timer => clearTimeout(timer) };
const TOOLS = [ToolExecutionComponent, ReadToolGroupComponent];

function pick(list, seed) {
	return list[Math.abs(seed) % list.length];
}

function traits(name) {
	let h = SEED;
	for (const byte of new TextEncoder().encode(name)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
	h = (h ^ (h >>> 16)) >>> 0;
	const look = {};
	for (const [key, list] of TRAITS) {
		look[key] = list[h % list.length];
		h = Math.floor(h / list.length);
	}
	return look;
}

function clock(ms) {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

function same(a, b) {
	return a.length === b.length && a.every((item, i) => item === b[i]);
}

function isTool(block) {
	return TOOLS.some(kind => block instanceof kind);
}

function speaks(block, cx) {
	if (!(block instanceof AssistantMessageComponent)) return false;
	return (block.describe(cx)?.c ?? []).some(child => typeof child?.render !== "function" && (child?.k === "md" || child?.key === "error"));
}

class Bot {
	constructor() {
		this.name = process.env.OMP_BOT_NAME || "Pip";
		this.role = process.env.OMP_BOT_ROLE || "Chief of staff";
		this.look = traits(this.name);
		this.tint = TINTS.includes(process.env.OMP_BOT_TINT) ? process.env.OMP_BOT_TINT : this.look.tint;
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
		this.look = traits(name);
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

	orb(gaze) {
		const look = this.look;
		const shape = col(
			[
				col([], { role: `omp.bot.glow.${look.glow}` }),
				col(
					[col([], { role: "omp.bot.ring.a" }), col([], { role: "omp.bot.ring.b" }), col([], { role: "omp.bot.ring.c" })],
					{ role: `omp.bot.rings.${look.rings}` },
				),
				col([], { role: `omp.bot.gear.${look.gear}` }),
				col([], { role: "omp.bot.core" }),
				row(
					[
						col([], { role: "omp.bot.eye.l" }),
						col([], { role: "omp.bot.eye.r" }),
						col([], { role: "omp.bot.blush.l" }),
						col([], { role: "omp.bot.blush.r" }),
						col([], { role: "omp.bot.mouth" }),
					],
					{ role: `omp.bot.face.${look.eyes}` },
				),
				col([], { role: "omp.bot.heart.a" }),
				col([], { role: "omp.bot.heart.b" }),
				col([], { role: "omp.bot.heart.c" }),
				col([], { role: "omp.bot.spark.a" }),
				col([], { role: "omp.bot.spark.b" }),
				text("z", { role: "omp.bot.z", wrap: "none" }),
				text("purrr", { role: "omp.bot.purr", wrap: "none" }),
			],
			{ role: `omp.bot.orb.${this.face()}`, actions: { click: "boop" } },
		);
		const body = gaze
			? ZONES.reduceRight(
					(inner, zone) => col([col([], { role: `omp.bot.zone.${zone}` }), inner], { role: `omp.bot.gaze.${zone}` }),
					shape,
				)
			: shape;
		return col([body], { role: `omp.bot.tempo.${look.tempo}` });
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
				b.orb(true),
				col(
					[
						text(`Hi, I'm ${b.name}.`, { role: "omp.bot.hello", wrap: "none" }),
						text(b.boop ?? b.role, { role: "omp.bot.say", wrap: "none" }),
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
				b.orb(false),
				text(b.name, { role: "omp.bot.name", wrap: "none" }),
				text(b.role, { role: "omp.bot.role", wrap: "none" }),
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
		const busy = b.active;
		const status = b.boop ?? b.line;
		return row(
			[
				b.orb(true),
				col(
					[
						text(b.name, { role: "omp.bot.name", wrap: "none" }),
						row(
							[
								busy && !b.boop
									? node("shimmer", {
											spans: [{ t: status, s: "muted" }],
											mode: "classic",
											palette: { low: "dim", mid: "muted", high: "accent" },
											role: "omp.bot.say",
										})
									: text(status, { role: "omp.bot.say", wrap: "none" }),
							].filter(Boolean),
							{ role: "omp.bot.status", align: "center", gap: "sm" },
						),
					],
					{ role: "omp.bot.words", gap: "none" },
				),
			],
			{ role: `omp.bot.chat.${b.tint}`, align: "center", gap: "md" },
		);
	}
}

class BotWork {
	constructor() {
		this.blocks = [];
		this.toggled = undefined;
	}

	handleNativeEvent(event) {
		if (event?.type === "toggle" && event.key === "work") this.toggled = event.collapsed;
	}

	invalidate() {}

	render() {
		return [];
	}

	update(blocks, live) {
		if (live && this.startedAt === undefined) this.startedAt = Date.now();
		if (!live && this.startedAt !== undefined && this.endedAt === undefined) this.endedAt = Date.now();
		this.blocks = blocks;
	}

	describe(cx) {
		const tools = this.blocks.filter(isTool);
		const failed = tools.filter(block => block.describe(cx)?.p?.status === "error").length;
		const collapsed = this.toggled ?? failed === 0;
		const ms =
			this.endedAt !== undefined
				? this.endedAt - this.startedAt
				: tools.reduce((total, block) => total + (block.describe(cx)?.p?.took ?? 0), 0);
		const key = [...this.blocks, collapsed, failed, Math.round(ms / 1000)];
		if (this.key && same(this.key, key)) return this.node;
		this.key = key;
		const head = [text(ms >= 1000 ? `Worked ${clock(ms)}` : "Worked", { wrap: "none" })];
		if (failed > 0) head.push(node("badge", { text: `${failed} failed`, tone: "error" }));
		this.node = node(
			"section",
			{ role: "omp.bot.work", collapsible: true, collapsed },
			[node("row", { gap: "sm", align: "center" }, head, "head"), ...this.blocks],
			"work",
		);
		return this.node;
	}
}

class BotMarked {
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

function patchTranscript(state) {
	const proto = TranscriptContainer.prototype;
	if (proto[PATCHED]) {
		proto[PATCHED].state = state;
		return;
	}
	const assistant = AssistantMessageComponent.prototype;
	const describeAssistant = assistant.describe;
	const inner = proto.nativeBlocks;
	const innerDescribe = proto.describe;
	const works = new WeakMap();
	const shownBy = new WeakMap();
	const nodeBy = new WeakMap();
	const marked = new WeakMap();
	proto[PATCHED] = { state, cx: undefined };

	assistant.describe = function (cx) {
		if (cx) proto[PATCHED].cx = cx;
		return describeAssistant.call(this, cx);
	};

	function mark(block) {
		if (!(block instanceof UserMessageComponent || block instanceof AssistantMessageComponent)) return block;
		let wrapped = marked.get(block);
		if (!wrapped) {
			wrapped = new BotMarked([block], "omp.bot.msg");
			marked.set(block, wrapped);
		}
		return wrapped;
	}

	function work(first) {
		let folded = works.get(first);
		if (!folded) {
			folded = new BotWork();
			works.set(first, folded);
		}
		return folded;
	}

	proto.nativeBlocks = function () {
		const blocks = inner.call(this);
		const s = proto[PATCHED].state;
		if (!s.on || !s.top) return blocks;
		const shown = [s.top];
		let run = [];
		const close = live => {
			if (run.some(isTool)) {
				const folded = work(run[0]);
				folded.update(run, live);
				if (!live && !chatTranscriptDisplayPreferences.hideToolActivity) shown.push(folded);
			}
			run = [];
		};
		for (const block of blocks) {
			if (isTool(block) || (block instanceof AssistantMessageComponent && !speaks(block, proto[PATCHED].cx))) {
				run.push(block);
				continue;
			}
			close(false);
			shown.push(mark(block));
		}
		close(s.bot.active);
		if (!s.bot.hero) shown.push(s.status);
		const previous = shownBy.get(this);
		if (previous && same(previous, shown)) return previous;
		shownBy.set(this, shown);
		return shown;
	};

	proto.describe = function () {
		if (!proto[PATCHED].state.on) return innerDescribe.call(this);
		const blocks = this.nativeBlocks();
		const cached = nodeBy.get(this);
		if (cached?.blocks === blocks) return cached.node;
		const described = col(blocks, { role: "omp.transcript" });
		nodeBy.set(this, { blocks, node: described });
		return described;
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
		let wrapped = docks.get(surface);
		if (!wrapped) {
			wrapped = { main: surface.main, dock: [new BotMarked(surface.dock, "omp.bot.dock")] };
			docks.set(surface, wrapped);
		}
		return wrapped;
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
	const state = { on: process.env.OMP_BOT !== "0", bot, top: undefined, status: new BotStatus(bot) };
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
		patchTranscript(state);
		patchDock(state);
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
		description: "Bot mode: an orb that works for you; /bot toggles it, /bot name NAME renames it",
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
		const persona = `\n# Bot mode\nThe user sees you in their terminal as ${bot.name}, a small living orb: your replies and one status word, nothing else. Your tool calls are hidden from the transcript, so say in words what you found and what you ran rather than pointing at a card.\n`;
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
		if (ctx.agent?.kind === "sub" || bot.running.size > 0) return;
		const kind = event.assistantMessageEvent?.type;
		if (kind === "text_delta" || kind === "text_start") bot.set("talking", "Writing it up…");
		else if (kind === "thinking_delta" || kind === "thinking_start") bot.set("thinking", bot.mood === "thinking" ? bot.line : pick(THINKING, Date.now()));
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		bot.running.set(event.toolCallId, true);
		bot.set(event.toolName === "ask" ? "waiting" : "working", event.toolName === "ask" ? "Waiting on you" : "Working");
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
