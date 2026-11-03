import { readFileSync } from "node:fs";
import { col, row } from "@oh-my-pi/pi-tui/native/describe";

const TINTS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];
const TRAITS = [
	["eyes", ["oval", "round", "dot"]],
	["type", ["neutral", "neutral", "hero", "dark"]],
	["tempo", ["calm", "even", "brisk"]],
	["tint", TINTS],
];

const HEAD = {
	neutral: ["........o", ".......oa", ".....ooaa"],
	hero: ["..oo.....", "..oho....", "...ohoooo"],
	dark: ["........o", "........o", ".....oooo"],
};

const TRUNK = [
	"...oobbbb",
	"..obbbbbb",
	".obbbbbbb",
	".obbbbbbb",
	"obbbbbbbb",
	"obbbbbbbb",
	"obbbbbbbb",
	"obbbbbbbb",
	".obbbbbbb",
	"..oobbbbb",
	"....oosss",
	"..oaobbbb",
	".oaaobbbb",
	"..ooobbbb",
	"...obbbbb",
	"..oaaaaob",
	"..oaaaaoo",
	"...oooo..",
];

const EYE_ROW = 7;
const NECK_ROW = 13;

const EYES = {
	oval: ["beeb", "weew", "weew", "beeb"],
	round: [".ee.", "ewee", "eeee", ".ee."],
	dot: ["....", ".we.", ".ee.", "...."],
	happy: ["....", ".ee.", "e..e", "...."],
	sad: ["....", "...e", ".ew.", "ee.."],
	half: ["....", "....", "weew", ".ee."],
	shut: ["....", "....", "e..e", ".ee."],
};

const BLINK = ["bbbb", "bbbb", "eeee", "bbbb"];

const GLYPHS = {
	ball: ["aaa", "aaa", "aad"],
	ask: [".aaa.", "aa.aa", "...aa", "..aa.", ".....", "..aa."],
	bang: ["aa", "aa", "aa", "aa", "..", "aa"],
	heart: [".rr.rr.", "rrrrrrr", "rrrrrrr", ".rrrrr.", "..rrr..", "...r..."],
	swirl: [".aaa.", "a....", "a.aa.", "a...a", ".aaa."],
	droop: ["aaa", "ddd"],
	spiky: ["a.a.a", ".aaa.", "aadaa", ".aaa.", "a.a.a"],
	z: ["aaaa", "..a.", ".a..", "aaaa"],
};

const HALO = [".dddddd.", "d......d", ".dddddd."];

const BALL = { neutral: "ball", hero: "halo", dark: "spiky" };

const EMOTE = {
	idle: "ball",
	listen: "ball",
	drowsy: "ball",
	thinking: "ask",
	working: "swirl",
	talking: "swirl",
	happy: "bang",
	waiting: "bang",
	boop: "heart",
	error: "droop",
	sleep: "z",
};

const MOOD_EYES = { boop: "happy", error: "sad", drowsy: "half", sleep: "shut" };

function hash(name) {
	let h = 0x811cb697;
	for (const byte of new TextEncoder().encode(name)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
	return (h ^ (h >>> 16)) >>> 0;
}

function roster(name) {
	try {
		const bots = JSON.parse(readFileSync(`${process.env.OMP_BOT_STATE}/bots.json`, "utf8"));
		return bots.find(bot => bot.name === name) ?? {};
	} catch {
		return {};
	}
}

export function chaoOf(name, tint) {
	let h = hash(name);
	const look = {};
	for (const [key, list] of TRAITS) {
		look[key] = list[h % list.length];
		h = Math.floor(h / list.length);
	}
	const entry = roster(name);
	const own = typeof entry.chao === "string" ? { type: entry.chao } : (entry.chao ?? {});
	if (HEAD[own.type]) look.type = own.type;
	if (TRAITS[0][1].includes(own.eyes)) look.eyes = own.eyes;
	if (TINTS.includes(tint)) look.tint = tint;
	return look;
}

function mirror(rows) {
	return rows.map(r => r + [...r].reverse().join(""));
}

function shade(rows) {
	const at = (x, y) => rows[y]?.[x] ?? ".";
	const edge = c => c === "o" || c === ".";
	return rows.map((r, y) =>
		[...r]
			.map((c, x) => {
				if (c === "a") return edge(at(x, y + 1)) || edge(at(x + 1, y)) ? "d" : c;
				if (c !== "b") return c;
				if (edge(at(x, y + 1)) || edge(at(x + 1, y))) return "s";
				return edge(at(x, y - 1)) || edge(at(x - 1, y)) ? "h" : c;
			})
			.join(""),
	);
}

function stamp(rows, eye, top) {
	const out = rows.map(r => [...r]);
	eye.forEach((r, dy) =>
		[...r].forEach((c, dx) => {
			if (c === ".") return;
			out[top + dy][3 + dx] = c;
			out[top + dy][14 - dx] = c;
		}),
	);
	return out.map(r => r.join(""));
}

function outline(mask) {
	const w = mask[0].length + 2;
	const grid = [".".repeat(w), ...mask.map(r => `.${r}.`), ".".repeat(w)];
	const filled = (x, y) => (grid[y]?.[x] ?? ".") !== ".";
	return grid.map((r, y) =>
		[...r].map((c, x) => (c === "." && (filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1)) ? "o" : c)).join(""),
	);
}

function pixels(rows, trim) {
	return rows.map(r => {
		const line = trim ? r.replace(/^\.+|\.+$/g, "") : r;
		return row(
			[...line].map(c => col([], { role: `omp.bot.px.${c === "." ? "_" : c}` })),
			{ role: "omp.bot.line", gap: "none" },
		);
	});
}

export function drawChao(look, mood) {
	const sleep = mood === "sleep";
	const eyes = MOOD_EYES[mood] ?? look.eyes;
	let base = mirror([...HEAD[look.type], ...TRUNK]);
	if (sleep) base = [".".repeat(18), ...base.slice(0, NECK_ROW), ...base.slice(NECK_ROW + 1)];
	const top = EYE_ROW + (sleep ? 1 : 0);
	const body = stamp(shade(base), EYES[eyes], top);
	const emote = EMOTE[mood] ?? "ball";
	const kind = emote === "ball" ? BALL[look.type] : emote;
	const glyph = kind === "halo" ? HALO : outline(GLYPHS[kind]);
	const parts = [
		col([col(pixels(glyph, false), { role: `omp.bot.glyph.${kind}`, gap: "none" })], { role: "omp.bot.emote", gap: "none" }),
		col(pixels(body, true), { role: "omp.bot.body", gap: "none" }),
	];
	if (eyes === look.eyes) parts.push(col(pixels(BLINK.map(r => `...${r}....${[...r].reverse().join("")}...`), false), { role: "omp.bot.blink", gap: "none" }));
	return col(
		[col([col(parts, { role: `omp.bot.chao.${mood}`, gap: "none", actions: { click: "boop" } })], { role: `omp.bot.type.${look.type}`, gap: "none" })],
		{ role: `omp.bot.tempo.${look.tempo}`, gap: "none" },
	);
}
