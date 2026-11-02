import { col, elapsed, node, row, span, text } from "@oh-my-pi/pi-tui/native/describe";
import { TranscriptContainer } from "@oh-my-pi/pi-tui/chrome";
import { ToolExecutionComponent } from "@oh-my-pi/pi-tui/chat/tool-execution";
import { ReadToolGroupComponent } from "@oh-my-pi/pi-tui/chat/read-tool-group";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";

const PATCHED = Symbol.for("omp-bot.transcript");
const HUD_PATCHED = Symbol.for("omp-bot.hud");
const NAMES = ["Pip", "Nova", "Mote", "Lumen", "Kiki", "Orbit"];
const IDLE = ["Ready when you are.", "What are we building?", "Standing by.", "Ask me anything."];
const THINKING = ["Thinking…", "Hmm, let me see…", "Mulling it over…", "Working it out…"];
const MOOD_LABEL = {
	idle: "idle",
	thinking: "thinking",
	working: "working",
	talking: "talking",
	happy: "done",
	error: "oops",
	waiting: "your turn",
};

function pick(list, seed) {
	return list[Math.abs(seed) % list.length];
}

function base(path) {
	if (typeof path !== "string" || !path) return undefined;
	const clean = path.replace(/[?#].*$/, "").replace(/\/+$/, "");
	return clean.slice(clean.lastIndexOf("/") + 1) || clean;
}

function host(url) {
	try {
		return new URL(String(url)).host;
	} catch {
		return undefined;
	}
}

function firstWord(command) {
	if (typeof command !== "string") return undefined;
	return command.trim().split(/\s+/)[0];
}

function say(toolName, args) {
	const a = args ?? {};
	const intent = a.i ?? a.intent ?? a.title ?? a.description;
	if (typeof intent === "string" && intent.trim()) return intent.trim();
	switch (toolName) {
		case "read":
			return `Reading ${base(a.path) ?? "a file"}`;
		case "write":
			return `Writing ${base(a.path) ?? "a file"}`;
		case "edit":
			return "Editing code";
		case "bash":
			return `Running ${firstWord(a.command) ?? "a command"}`;
		case "grep":
		case "find":
		case "glob":
		case "ast_grep":
			return "Searching the code";
		case "web_search":
			return "Searching the web";
		case "web_fetch":
			return `Reading ${host(a.url) ?? "a page"}`;
		case "task":
			return "Briefing helpers";
		case "ask":
			return "Waiting on you";
		case "lsp":
			return "Asking the language server";
		case "todo":
			return "Updating the plan";
		default:
			return toolName ? `Using ${toolName.replace(/_/g, " ")}` : "Working";
	}
}

function clock(ms) {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

class Bot {
	constructor(name) {
		this.name = name;
		this.mood = "idle";
		this.line = pick(IDLE, Date.now());
		this.turnStart = 0;
		this.steps = 0;
		this.active = false;
		this.stopped = false;
		this.running = new Map();
		this.tui = undefined;
		this.settle = undefined;
	}

	set(mood, line) {
		if (this.mood === mood && this.line === line) return;
		this.mood = mood;
		if (line !== undefined) this.line = line;
		this.tui?.requestRender?.();
	}

	later(ms, fn) {
		clearTimeout(this.settle);
		this.settle = setTimeout(fn, ms);
	}
}

class BotWidget {
	constructor(bot, theme, stop) {
		this.bot = bot;
		this.theme = theme;
		this.stop = stop;
	}

	handleNativeEvent(event) {
		if (event?.type === "action" && event.act === "interrupt") this.stop();
	}

	invalidate() {}

	render(width) {
		const b = this.bot;
		const t = this.theme;
		const head = t?.fg ? t.fg("accent", `◉ ${b.name}`) : `◉ ${b.name}`;
		const mood = t?.fg ? t.fg("muted", MOOD_LABEL[b.mood]) : MOOD_LABEL[b.mood];
		const line = ` ${head} · ${mood} · ${b.line}`;
		return [truncateToWidth(replaceTabs(line), width)];
	}

	describe() {
		const b = this.bot;
		const m = b.mood;
		const busy = b.active;
		const words = [
			row(
				[
					text([span(b.name, "strong")], { role: "omp.bot.name", wrap: "none" }),
					text(MOOD_LABEL[m], { role: `omp.bot.mood.${m}`, wrap: "none" }),
					busy && b.turnStart ? elapsed(Date.now() - b.turnStart) : undefined,
					busy && b.steps ? text(`${b.steps} step${b.steps === 1 ? "" : "s"}`, { role: "omp.bot.steps", wrap: "none" }) : undefined,
					busy
						? row([node("kbd", { keys: ["escape"] }), text("Stop")], {
								role: "omp.bot.stop",
								gap: "xs",
								align: "center",
								title: "Stop  esc",
								actions: { click: "interrupt" },
							})
						: undefined,
				].filter(Boolean),
				{ role: "omp.bot.head", align: "center", gap: "sm" },
			),
			busy
				? node("shimmer", {
						spans: [{ t: b.line, s: "muted" }],
						mode: "classic",
						palette: { low: "dim", mid: "muted", high: "accent" },
						role: "omp.bot.say",
					})
				: text(b.line, { role: "omp.bot.say" }),
		];
		const orb = col(
			[
				col([], { role: "omp.bot.glow" }),
				col([], { role: "omp.bot.ring.a" }),
				col([], { role: "omp.bot.ring.b" }),
				col([], { role: "omp.bot.ring.c" }),
				col([], { role: "omp.bot.core" }),
				row([col([], { role: "omp.bot.eye.l" }), col([], { role: "omp.bot.eye.r" })], { role: "omp.bot.face" }),
			],
			{ role: `omp.bot.orb.${m}` },
		);
		return row([orb, col(words, { role: "omp.bot.words", gap: "none" })], {
			role: `omp.bot.${m}`,
			align: "center",
			gap: "md",
		});
	}
}

function hideTools(state) {
	const proto = TranscriptContainer.prototype;
	if (proto[PATCHED]) {
		proto[PATCHED].state = state;
		return;
	}
	const inner = proto.nativeBlocks;
	const memo = new WeakMap();
	proto[PATCHED] = { state };
	proto.nativeBlocks = function () {
		const blocks = inner.call(this);
		if (!proto[PATCHED].state.on || proto[PATCHED].state.reveal) return blocks;
		const shown = blocks.filter(
			block => !(block instanceof ToolExecutionComponent) && !(block instanceof ReadToolGroupComponent),
		);
		const previous = memo.get(this);
		if (previous && previous.length === shown.length && previous.every((block, i) => block === shown[i])) {
			return previous;
		}
		memo.set(this, shown);
		return shown;
	};
}

function isPlainWorkingRow(child, cx) {
	const node = child?.describe?.(cx);
	if (node?.p?.role !== "omp.working" || !Array.isArray(node.c)) return false;
	return node.c[0]?.k === "spinner" && !node.c.some(part => part?.k === "progress");
}

function foldWorkingRow(state) {
	const proto = InteractiveMode.prototype;
	if (proto[HUD_PATCHED]) {
		proto[HUD_PATCHED].state = state;
		return;
	}
	const inner = proto.describeStatusHud;
	if (typeof inner !== "function") return;
	proto[HUD_PATCHED] = { state };
	proto.describeStatusHud = function (children, cx) {
		if (!proto[HUD_PATCHED].state.on) return inner.call(this, children, cx);
		return inner.call(
			this,
			children.filter(child => !isPlainWorkingRow(child, cx)),
			cx,
		);
	};
}

export default function ompBot(pi) {
	const bot = new Bot(process.env.OMP_BOT_NAME || pick(NAMES, Math.floor(Date.now() / 1000)));
	const state = { on: process.env.OMP_BOT !== "0", reveal: false };
	let ui;
	let abort;

	pi.setLabel("Bot mode");

	function mount() {
		if (!ui || ctxMode !== "tui") return;
		if (!state.on) {
			ui.setWidget("omp-bot", undefined);
			return;
		}
		ui.setWidget("omp-bot", (tui, theme) => {
			bot.tui = tui;
			return new BotWidget(bot, theme, () => abort?.());
		});
	}
	let ctxMode;

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub" || ctx.mode !== "tui") return;
		ui = ctx.ui;
		ctxMode = ctx.mode;
		abort = () => {
			bot.stopped = true;
			ctx.abort();
		};
		hideTools(state);
		foldWorkingRow(state);
		mount();
	});

	pi.registerCommand("bot", {
		description: "Bot mode: an orb that works for you; /bot toggles it, /bot name NAME renames it",
		handler: async (args, ctx) => {
			const parts = String(args ?? "").trim().split(/\s+/).filter(Boolean);
			if (parts[0] === "name" && parts[1]) {
				bot.name = parts.slice(1).join(" ");
				bot.set(bot.mood, `Hi, I'm ${bot.name}.`);
			} else {
				state.on = !state.on;
			}
			ui = ctx.ui;
			ctxMode = ctx.mode;
			mount();
			bot.tui?.requestRender?.();
			abort = () => {
				bot.stopped = true;
				ctx.abort();
			};
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (ctx.agent?.kind === "sub" || !state.on || !Array.isArray(event.systemPrompt) || event.systemPrompt.length === 0) return undefined;
		const persona = `\n# Bot mode\nThe user sees you in their terminal as ${bot.name}, a small living orb. Tool cards are compressed; /bot reveals them. Use short, plain tool titles where the tool schema supports them. Speak as ${bot.name}: warm, curious, brief.\n`;
		const systemPrompt = [...event.systemPrompt];
		systemPrompt[systemPrompt.length - 1] = `${systemPrompt[systemPrompt.length - 1]}${persona}`;
		return { systemPrompt };
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		clearTimeout(bot.settle);
		bot.turnStart = Date.now();
		bot.steps = 0;
		bot.active = true;
		bot.stopped = false;
		state.reveal = false;
		bot.running.clear();
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
		bot.steps += 1;
		const line = say(event.toolName, event.args);
		bot.running.set(event.toolCallId, line);
		bot.set(event.toolName === "ask" ? "waiting" : "working", line);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		const failedLine = bot.running.get(event.toolCallId) ?? say(event.toolName, event.args);
		bot.running.delete(event.toolCallId);
		if (event.isError) {
			state.reveal = true;
			bot.set("error", `${failedLine} failed — details are open`);
			return;
		}
		const next = [...bot.running.values()].at(-1);
		bot.set(next ? "working" : "thinking", next ?? bot.line);
	});

	pi.on("agent_end", async (event, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		if (event.willContinue) {
			bot.set("waiting", "Waiting for helpers…");
			return;
		}
		bot.active = false;
		bot.running.clear();
		const final = event.messages?.findLast(message => message.role === "assistant");
		const reason = final?.stopReason;
		if (bot.stopped || reason === "aborted") {
			bot.set("idle", "Stopped. Ready when you are.");
			return;
		}
		if (reason === "error" || reason === "length") {
			state.reveal = true;
			bot.set("error", final.errorMessage || "The reply ended early — check the transcript");
			return;
		}
		const took = clock(Date.now() - bot.turnStart);
		const summary = bot.steps ? `Finished · ${took} · ${bot.steps} step${bot.steps === 1 ? "" : "s"}` : `Finished in ${took}`;
		if (state.reveal) {
			bot.set("error", `${summary} · review tool errors`);
			return;
		}
		bot.set("happy", summary);
		bot.later(4000, () => bot.set("idle", summary));
	});
}
