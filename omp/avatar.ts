import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { col } from "@oh-my-pi/pi-tui/native/describe";

const AVATARS = JSON.parse(readFileSync(fileURLToPath(new URL("../tern/avatars.json", import.meta.url)), "utf8"));
const TINTS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];

export function fnv(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	return h >>> 0;
}

function mix(text: string): number {
	let h = fnv(text) | 0;
	h = Math.imul(h ^ (h >>> 16), 0x045d9f3b);
	h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
	return (h ^ (h >>> 16)) >>> 0;
}

function rng(seed: number): () => number {
	let t = seed | 0;
	return () => {
		t = (t + 0x6d2b79f5) | 0;
		let e = Math.imul(t ^ (t >>> 15), t | 1);
		e ^= e + Math.imul(e ^ (e >>> 7), e | 61);
		return ((e ^ (e >>> 14)) >>> 0) / 4294967296;
	};
}

function roster(name: string) {
	try {
		const bots = JSON.parse(readFileSync(`${process.env.OMP_BOT_STATE}/bots.json`, "utf8"));
		return bots.find(bot => bot.name === name) ?? {};
	} catch {
		return {};
	}
}

interface Look {
	shape: string;
	color: string;
	tint: string;
}

function lookOf(name: string, own: { shape?: string; color?: string } = {}, tint?: string): { shape: string; color: string } {
	const shapes: string[] = AVATARS.shapes;
	const palette: string[] = AVATARS.palette;
	const shape = shapes.includes(own.shape ?? "") ? own.shape! : shapes[mix(name) % shapes.length];
	let color = AVATARS.inks[own.color ?? ""] ? own.color! : palette[Math.floor(rng(fnv(name))() * palette.length)];
	if (!AVATARS.inks[own.color ?? ""] && AVATARS.identity === "tint" && tint && AVATARS.tints[tint]) color = AVATARS.tints[tint];
	return { shape, color };
}

export function avatarOf(name: string, tint?: string): Look {
	const entry = roster(name);
	const shade = tint ?? entry.tint;
	const look = lookOf(name, entry.avatar ?? {}, shade);
	return { ...look, tint: TINTS.includes(shade) ? shade : TINTS[fnv(name) % TINTS.length] };
}

export type Kind = "live" | "still" | "hero" | "event";

export function drawAvatar(kind: Kind, name: string, poke = true) {
	return col([], { role: `omp.bot.mark.${kind}/${name}`, gap: "none", align: "center", ...(poke ? { actions: { click: "boop" } } : {}) });
}
