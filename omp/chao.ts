import { readFileSync } from "node:fs";
import { col, row } from "@oh-my-pi/pi-tui/native/describe";

const TINTS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];
const AVATARS = JSON.parse(readFileSync(new URL("../tern/avatars.json", import.meta.url), "utf8"));
const EYES = {
	open: ["ee", "ee", "ee"],
	blink: ["..", "ee", ".."],
	shut: ["..", "..", "ee"],
};
const BODIES = Object.keys(AVATARS.bodies).sort();
const INKS = Object.keys(AVATARS.inks).sort();
const SHUT: Record<string, true> = { sleep: true, drowsy: true };
const SQUINT: Record<string, true> = { boop: true, happy: true };

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

function stamp(body, variant) {
	const [left, right, top] = body.eyes;
	const grid = body.rows.map(line => [...line]);
	for (const [dy, line] of EYES[variant].entries()) {
		for (const [dx, c] of [...line].entries()) {
			if (c !== "e") continue;
			for (const x of [left + dx, right + dx]) if (grid[top + dy][x] !== ".") grid[top + dy][x] = "e";
		}
	}
	return grid;
}

function cells(chars) {
	return [...chars].map(c => col([], { role: `omp.bot.px.${c}` }));
}

function pixels(grid) {
	const rows = grid.filter(line => line.some(c => c !== "."));
	const left = Math.min(...rows.map(line => line.findIndex(c => c !== ".")));
	const right = Math.max(...rows.map(line => line.findLastIndex(c => c !== ".")));
	return rows.map(line => row(cells(line.slice(left, right + 1).join("")), { role: "omp.bot.line", gap: "none" }));
}

export function drawChao(look, mood) {
	const body = AVATARS.bodies[look.body] ?? AVATARS.bodies[AVATARS.default.body];
	const variant = SHUT[mood] ? "shut" : SQUINT[mood] ? "blink" : "open";
	return col([col(pixels(stamp(body, variant)), { role: "omp.bot.body", gap: "none", align: "center" })], {
		role: `omp.bot.chao.${mood}`,
		gap: "none",
		align: "center",
		actions: { click: "boop" },
	});
}
