import { readFileSync } from "node:fs";
import { col } from "@oh-my-pi/pi-tui/native/describe";

const TINTS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];
const AVATARS = JSON.parse(readFileSync(new URL("../tern/avatars.json", import.meta.url), "utf8"));
const BODIES = Object.keys(AVATARS.bodies).sort();
const INKS = Object.keys(AVATARS.inks).sort();

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
	const entry = roster(name);
	const own = entry.avatar ?? {};
	let h = hash(name);
	const body = AVATARS.bodies[own.body] ? own.body : AVATARS.bots[name]?.body ?? BODIES[h % BODIES.length];
	h = Math.floor(h / BODIES.length);
	const ink = AVATARS.inks[own.ink] ? own.ink : AVATARS.bots[name]?.ink ?? INKS[h % INKS.length];
	const shade = tint ?? entry.tint;
	return { body, ink, tint: TINTS.includes(shade) ? shade : TINTS[h % TINTS.length] };
}

export type Shape = "open" | "squint" | "wide" | "shut" | "happy" | "sad";
export type Gaze = "c" | "l" | "r" | "u" | "d";
export interface Pose {
	mood: string;
	shape: Shape;
	gaze: Gaze;
}

const MOODS: Record<string, { shape: Shape; gaze: Gaze }> = {
	idle: { shape: "open", gaze: "c" },
	listen: { shape: "open", gaze: "d" },
	thinking: { shape: "squint", gaze: "u" },
	working: { shape: "squint", gaze: "d" },
	talking: { shape: "open", gaze: "c" },
	waiting: { shape: "wide", gaze: "u" },
	boop: { shape: "happy", gaze: "c" },
	happy: { shape: "happy", gaze: "c" },
	drowsy: { shape: "squint", gaze: "d" },
	sleep: { shape: "shut", gaze: "c" },
	error: { shape: "sad", gaze: "u" },
};

export function poseOf(mood: string): Pose {
	const face = MOODS[mood] ?? MOODS.idle;
	return { mood, shape: face.shape, gaze: face.gaze };
}

export function drawChao(look, pose: Pose) {
	return col(
		[
			col([], { role: `omp.bot.skin.${look.body}.${look.ink}`, gap: "none" }),
			col([], { role: `omp.bot.face.${pose.shape}.${pose.gaze}`, gap: "none" }),
		],
		{ role: `omp.bot.chao.${pose.mood}`, gap: "none", align: "center", actions: { click: "boop" } },
	);
}
