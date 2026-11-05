import { readFileSync } from "node:fs";
import { col, row } from "@oh-my-pi/pi-tui/native/describe";

const TINTS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"];
const TRAITS = [
	["eyes", ["oval", "round", "dot"]],
	["type", ["neutral", "neutral", "hero", "dark"]],
	["tempo", ["calm", "even", "brisk"]],
	["tint", TINTS],
];

const SPRITES = {
	neutral: {
		ball: [
			".ooo.",
			"oaaio",
			"oaido",
			"oiddo",
			".ooo.",
		],
		body: [
			"...........oo......",
			".........ooddo.....",
			".....oooodiaado....",
			"...oonijjjjjjino...",
			"..oembbbbbbbbbmeo..",
			".osmbbbbbbbbbbbmso.",
			".ombbbbbbbbbbbbbmo.",
			"ocmbbwwbbbbbwwbbmco",
			"osmbweewbbbweewbmso",
			"osmbweewbbbweewbmso",
			"osmmweewbbbweewmmso",
			"ocmmweewbbbweewmmco",
			"oesmmwwmmmmmwwmmseo",
			".oecsssssssssssceo.",
			"..oooecsssssceooo..",
			".oosmcmmmmmmmcmsoo.",
			"odjbmsmbbbbbmsmbjdo",
			"oiaiecsmmmmmsceiaio",
			"odinoecsssssceonido",
			".ooodsseoooessdooo.",
			"..odajmscocsmjado..",
			"..ondimscocsmidno..",
			"...oooooo.oooooo...",
		],
		anchor: 14,
		gap: 3,
		eyes: [7, 4, 18],
		pupil: "e",
		slump: 13,
	},
	hero: {
		ball: [
			"...ooooooo...",
			".ooaaaaaaaoo.",
			"oaaaoooooaaao",
			".ooaaaaaaaoo.",
			"...ooooooo...",
		],
		body: [
			"........oo.....oo........",
			".......oaao...oaao.......",
			".......oajjo.ojjao.......",
			"........ojbo.objo........",
			".........obbobbo.........",
			".........oocbcoo.........",
			".......oocbbbbbcoo.......",
			"......obbbbbbbbbbbo......",
			".....ocbbbbbbbbbbbco.....",
			"....osbbbbbbbbbbbbbso....",
			"....obbbbbbbbbbbbbbbo....",
			"...ocbbbccbbbbbccbbbco...",
			"...osbbccbcbbbccbcbbso...",
			"...osbbcbbcbbbcbbcbbso...",
			"...osbbcbbcbbbcbbcbbso...",
			"...osbbcbccbbbcbccbbso...",
			"...ocsbbccbbbbbccbbsco...",
			"..oooccsbbbbbbbbbsccooo..",
			".oyyyooocccssscccoooyyyo.",
			"oyyyoosbcsbbbbbscbsooyyyo",
			"oyyoajjbsbbbbbbbsbjjaoyyo",
			".oooajjjcsbbbbbscjjjaooo.",
			"...oaaaoccsssssccoaaao...",
			"....oooajscooocsjaooo....",
			".....oajjjscocsjjjao.....",
			".....oaaajscocsjaaao.....",
			"......oooooo.oooooo......",
		],
		anchor: 12,
		gap: 1,
		eyes: [11, 7, 24],
		pupil: "c",
		slump: 17,
	},
	dark: {
		ball: [
			"...o...",
			".odado.",
			".oadad.",
			"oadadad",
			".oadad.",
			".ooaoo.",
			"...o...",
		],
		body: [
			"...........oooo.............",
			".......ooooooooooo.oo.......",
			"....ooooobbbbbbbboodao......",
			"...ooobbbbbbbboobbbddao.....",
			"..oobbbbbbbbbbbbobboodo.....",
			".oobbbbbbbbbbbbbbobo........",
			".obbbbbbbbbbbbbbbooo........",
			"oobbbbbbbbbbbbbbboo.........",
			"oobbewbbbbbbbwebboo.........",
			"oobbewwbbbbbwwebboo.........",
			"oobbewwbbbbbwwebboo.........",
			"oobbewwebbbewwebboo.........",
			"oobbeweebbbeweebboo.........",
			"ooobbeebbbbbeebbooo.........",
			".oooobbbbbbbbboooo..........",
			"..oooodooooodoooo...........",
			".ddoboaoooooaobodd..........",
			"dadobobaaaaabobodao.........",
			"daddooooaaaooooddao.........",
			"daaaoooobbbooooaaao.........",
			".ooddoooooooooddoo..........",
			"..oaddbboooboddao...........",
			"..oaaadbbobbdaaao...........",
			"...oooooo.oooooo............",
		],
		anchor: 24,
		gap: 0,
		eyes: [8, 4, 18],
		pupil: "e",
		slump: 14,
	},
};

const EYES = {
	round: ["....", ".ww.", "wxxw", "wxxw", ".ww.", "...."],
	dot: ["....", "....", ".xx.", ".xx.", "....", "...."],
	happy: ["....", "....", ".xx.", "x..x", "....", "...."],
	sad: ["...x", "..xx", ".xxx", "wxxx", "wxxw", "...."],
	half: ["....", "....", "xxxx", "x..x", ".xx.", "...."],
	shut: ["....", "....", "....", "x..x", ".xx.", "...."],
};

const GLYPHS = {
	ask: [".aai.", "ai.ad", "...ad", "..ad.", ".....", "..ad."],
	bang: ["ai", "ai", "ad", "ad", "..", "ad"],
	heart: [".rr.rr.", "rrrrrrr", "rrrrrrr", ".rrrrr.", "..rrr..", "...r..."],
	swirl: [".aai.", "a....", "a.ai.", "a...d", ".idd."],
	droop: ["aai", "idd"],
	z: ["aaaa", "..a.", ".a..", "aadd"],
};

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
	if (SPRITES[own.type]) look.type = own.type;
	if (TRAITS[0][1].includes(own.eyes)) look.eyes = own.eyes;
	const shade = tint ?? entry.tint;
	if (TINTS.includes(shade)) look.tint = shade;
	return look;
}

function outline(mask) {
	const w = mask[0].length + 2;
	const grid = [".".repeat(w), ...mask.map(r => `.${r}.`), ".".repeat(w)];
	const filled = (x, y) => (grid[y]?.[x] ?? ".") !== ".";
	return grid.map((r, y) =>
		[...r].map((c, x) => (c === "." && (filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1)) ? "o" : c)).join(""),
	);
}

function eyed(sprite, name) {
	const [top, left, axis] = sprite.eyes;
	const out = sprite.body.map(r => [...r]);
	const eye = c => c === sprite.pupil || c === "w";
	EYES[name].forEach((stamp, dy) => {
		const line = out[top + dy];
		for (let dx = 0; dx < 4; dx++) {
			for (const x of [left + dx, axis - left - dx]) {
				if (eye(line[x])) {
					let k = x - 1;
					while (eye(line[k])) k--;
					line[x] = line[k];
				}
			}
		}
		[...stamp].forEach((c, dx) => {
			if (c === ".") return;
			const v = c === "x" ? sprite.pupil : c;
			line[left + dx] = v;
			line[axis - left - dx] = v;
		});
	});
	return out;
}

function cells(chars) {
	return [...chars].map(c => col([], { role: `omp.bot.px.${c === "." ? "_" : c}` }));
}

function pixels(rows) {
	return rows.map(r => {
		const cut = Math.min(r.length - r.replace(/^\.+/, "").length, r.length - r.replace(/\.+$/, "").length);
		return row(cells(r.slice(cut, r.length - cut)), { role: "omp.bot.line", gap: "none" });
	});
}

export function drawChao(look, mood) {
	const sprite = SPRITES[look.type];
	const eyes = MOOD_EYES[mood] ?? look.eyes;
	let body = (eyes === "oval" ? sprite.body.map(r => [...r]) : eyed(sprite, eyes)).map(r => r.join(""));
	const [top, left, axis] = sprite.eyes;
	const shut = eyed(sprite, "shut");
	let blink = body.map((r, y) =>
		y < top || y >= top + 6 ? "" : [...r].map((_, x) => (x >= left && x < left + 4) || (x <= axis - left && x > axis - left - 4) ? shut[y][x] : ".").join(""),
	);
	if (mood === "sleep") {
		const slump = rows => ["", ...rows.slice(0, sprite.slump), ...rows.slice(sprite.slump + 1)];
		body = slump(body);
		blink = slump(blink);
	}
	const emote = EMOTE[mood] ?? "ball";
	const kind = emote === "ball" ? BALL[look.type] : emote;
	const glyph = emote === "ball" ? sprite.ball : outline(GLYPHS[emote]);
	const width = glyph[0].length;
	const pad = Math.max(0, Math.min(sprite.anchor - Math.floor(width / 2), sprite.body[0].length - width));
	const parts = [
		row([row(cells(".".repeat(pad)), { role: "omp.bot.line", gap: "none" }), col(glyph.map(r => row(cells(r), { role: "omp.bot.line", gap: "none" })), { role: `omp.bot.glyph.${kind}`, gap: "none" })], {
			role: "omp.bot.emote",
			gap: "none",
		}),
		...Array.from({ length: sprite.gap }, () => row([], { role: "omp.bot.line", gap: "none" })),
		col([...pixels(body), ...(eyes === look.eyes ? [col(pixels(blink), { role: "omp.bot.blink", gap: "none" })] : [])], { role: "omp.bot.body", gap: "none" }),
	];
	return col(
		[col([col(parts, { role: `omp.bot.chao.${mood}`, gap: "none", actions: { click: "boop" } })], { role: `omp.bot.type.${look.type}`, gap: "none" })],
		{ role: `omp.bot.tempo.${look.tempo}`, gap: "none" },
	);
}
