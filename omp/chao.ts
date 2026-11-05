import { readFileSync } from "node:fs";
import { col } from "@oh-my-pi/pi-tui/native/describe";

const TINTS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];
const TRAITS = [
	["eyes", ["oval", "round", "dot"]],
	["type", ["neutral", "neutral", "hero", "dark"]],
	["tempo", ["calm", "even", "brisk"]],
	["tint", TINTS],
];

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
	if (TRAITS[1][1].includes(own.type)) look.type = own.type;
	if (TRAITS[0][1].includes(own.eyes)) look.eyes = own.eyes;
	const shade = tint ?? entry.tint;
	if (TINTS.includes(shade)) look.tint = shade;
	return look;
}

export function drawChao(look, mood) {
	const eyes = MOOD_EYES[mood] ?? look.eyes;
	const emote = EMOTE[mood] ?? "ball";
	const layer = role => col([], { role, gap: "none" });
	const chao = col([layer(`omp.bot.emote.${emote}`), layer("omp.bot.skin"), layer(`omp.bot.eyes.${eyes === look.eyes ? "own" : "mood"}.${eyes}`)], {
		role: `omp.bot.chao.${mood}`,
		gap: "none",
		actions: { click: "boop" },
	});
	return col([col([chao], { role: `omp.bot.type.${look.type}`, gap: "none" })], { role: `omp.bot.tempo.${look.tempo}`, gap: "none" });
}
