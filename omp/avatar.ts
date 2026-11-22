import { readFileSync } from "node:fs";
import { col } from "@oh-my-pi/pi-tui/native/describe";

const TINTS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];
const AVATARS = JSON.parse(readFileSync(new URL("../tern/avatars.json", import.meta.url), "utf8"));
const SHAPES = Object.keys(AVATARS.shapes).sort();
const AUTO_COLORS: string[] = AVATARS.autoColors ?? Object.keys(AVATARS.colors).sort();

function hash(name: string): number {
	let h = 0x811cb697;
	for (const byte of new TextEncoder().encode(name)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
	h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
	return (h ^ (h >>> 16)) >>> 0;
}

function roster(name: string) {
	try {
		const bots = JSON.parse(readFileSync(`${process.env.OMP_BOT_STATE}/bots.json`, "utf8"));
		return bots.find(bot => bot.name === name) ?? {};
	} catch {
		return {};
	}
}

export interface Look {
	shape: string;
	color: string;
	tint: string;
}

export function avatarOf(name: string, tint?: string): Look {
	const entry = roster(name);
	const own = entry.avatar ?? {};
	let h = hash(name);
	const shape = AVATARS.shapes[own.shape]
		? own.shape
		: AVATARS.bots[name]?.shape ?? SHAPES[h % SHAPES.length];
	h = Math.floor(h / SHAPES.length);
	const color = AVATARS.colors[own.color]
		? own.color
		: AVATARS.bots[name]?.color ?? AUTO_COLORS[h % AUTO_COLORS.length];
	const shade = tint ?? entry.tint;
	return { shape, color, tint: TINTS.includes(shade) ? shade : TINTS[h % TINTS.length] };
}

export type Face = "open" | "listen" | "thinking" | "working" | "wide" | "happy" | "drowsy" | "sleep" | "error";

export interface Pose {
	mood: string;
	face: Face;
}

const MOODS: Record<string, Face> = {
	idle: "open",
	listen: "listen",
	thinking: "thinking",
	working: "working",
	talking: "open",
	waiting: "wide",
	boop: "happy",
	happy: "happy",
	drowsy: "drowsy",
	sleep: "sleep",
	error: "error",
};

export function poseOf(mood: string): Pose {
	return { mood, face: MOODS[mood] ?? "open" };
}

export function drawAvatar(look: Look, pose: Pose) {
	return col(
		[
			col([], { role: `omp.bot.skin.${look.shape}.${look.color}`, gap: "none" }),
			col([], { role: `omp.bot.face.${pose.face}`, gap: "none" }),
			col([], { role: "omp.bot.lid", gap: "none" }),
		],
		{ role: `omp.bot.avatar.${pose.mood}`, gap: "none", align: "center", actions: { click: "boop" } },
	);
}
