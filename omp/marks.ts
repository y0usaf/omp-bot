import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fnv } from "./avatar.ts";

const DIR = fileURLToPath(new URL("../tern/marks/", import.meta.url));
const CHAIN_SECONDS = 600;
const SETTLE_SECONDS = 1.4;
const FINISH_SECONDS = 8;

interface Segment {
	name: string;
	frames: number;
}

interface Manifest {
	fps: number;
	segments: Record<string, Segment>;
	programs: Record<string, { intro: string[]; loop: string[] }>;
	static: Record<string, string>;
}

interface Track {
	intro: string[];
	loop: string[];
	ends: number[];
}

interface SeqState {
	t: number;
	bags: Record<string, string[]>;
	current: string | null;
}

const CHAINS: Record<string, string[]> = {
	working: ["Working_A", "Working_B", "Working_C", "Working_D", "Working_E", "Working_F"],
	streaming: ["Streaming_A", "Streaming_B", "Streaming_C"],
};
const CLIP_OF: Record<string, string> = {
	settle: "Idle_B",
	thinking: "Idle_B",
	searching: "Idle_B",
	waiting: "Idle_B",
	writing: "Idle_B",
	sending: "Idle_B",
	blocked: "Blocked_A",
	finished: "Idle_B",
	failed: "Idle_B",
};
const POKES = ["spin", "bounce", "nod"];

class Sequencer {
	state: SeqState;

	constructor(seed: string) {
		this.state = { t: fnv(seed) | 0, bags: {}, current: null };
	}

	next(): number {
		const s = this.state;
		s.t = (s.t + 0x6d2b79f5) | 0;
		let e = Math.imul(s.t ^ (s.t >>> 15), s.t | 1);
		e ^= e + Math.imul(e ^ (e >>> 7), e | 61);
		return ((e ^ (e >>> 14)) >>> 0) / 4294967296;
	}

	save(): SeqState {
		const s = this.state;
		return { t: s.t, bags: Object.fromEntries(Object.entries(s.bags).map(([k, v]) => [k, [...v]])), current: s.current };
	}

	pop(chain: string): string {
		let bag = this.state.bags[chain];
		if (!bag || bag.length === 0) {
			bag = [...CHAINS[chain]];
			for (let e = bag.length - 1; e > 0; e--) {
				const j = Math.floor(this.next() * (e + 1));
				[bag[e], bag[j]] = [bag[j], bag[e]];
			}
			const i = bag.findIndex(c => c !== this.state.current);
			if (i > 0) [bag[0], bag[i]] = [bag[i], bag[0]];
			this.state.bags[chain] = bag;
		}
		const clip = bag.shift()!;
		this.state.current = clip;
		return clip;
	}
}

export class Mark {
	readonly name: string;
	readonly shape: string;
	readonly manifest: Manifest;
	private seq: Sequencer;
	private saved: SeqState | null = null;
	state = "idle";
	program = "rest";
	started = 0;
	track: Track | null = null;
	pokes = 0;
	gen = 0;

	constructor(name: string, shape: string) {
		this.name = name;
		this.shape = shape;
		this.manifest = JSON.parse(readFileSync(`${DIR}${shape}.json`, "utf8"));
		this.seq = new Sequencer(`sand-agent-mark-source-${name}`);
	}

	private seconds(keys: string[]): number {
		return keys.reduce((n, k) => n + this.manifest.segments[k].frames, 0) / this.manifest.fps;
	}

	private elapsed(now: number): number {
		return (now - this.started) / 1000;
	}

	private settled(now: number): boolean {
		if (this.program === "rest") return true;
		if (!this.track || CHAINS[this.program] || this.program === "blocked") return false;
		const loop = this.track.loop;
		return loop.length === 1 && this.manifest.segments[loop[0]].frames === 1 && this.elapsed(now) >= this.seconds(this.track.intro);
	}

	private leaveChain(now: number) {
		if (!this.track || !this.saved) return;
		const elapsed = this.elapsed(now);
		this.seq.state = this.saved;
		this.saved = null;
		let pops = 1;
		for (const end of this.track.ends) if (end <= elapsed) pops++;
		for (let i = 0; i < pops; i++) this.seq.pop(this.program);
	}

	private chain(chain: string): Track {
		this.saved = this.seq.save();
		const first = this.seq.pop(chain);
		const intro = ["rest", `rest>${first}`];
		const ends: number[] = [];
		let clip = first;
		let t = this.seconds(intro);
		while (t < CHAIN_SECONDS) {
			const next = this.seq.pop(chain);
			intro.push(clip, `${clip}>${next}`);
			t += this.manifest.segments[clip].frames / this.manifest.fps;
			ends.push(t);
			t += this.manifest.segments[`${clip}>${next}`].frames / this.manifest.fps;
			clip = next;
		}
		intro.push(clip);
		return { intro, loop: [], ends };
	}

	enter(state: string, now = Date.now()): boolean {
		const was = this.state;
		if (state === was) return false;
		const held = this.elapsed(now);
		if (state === "idle" && (this.program === "finished" || this.program === "failed") && held >= FINISH_SECONDS - 0.5) {
			this.state = state;
			return false;
		}
		const resting = this.settled(now);
		if (CHAINS[this.program]) this.leaveChain(now);
		else if (resting || (this.program === "settle" && held >= SETTLE_SECONDS) || ((this.program === "finished" || this.program === "failed") && held >= FINISH_SECONDS + SETTLE_SECONDS))
			this.seq.state.current = null;
		this.state = state;
		this.started = now;
		this.program = state === "idle" ? (resting ? "rest" : "settle") : this.manifest.programs[state] || CHAINS[state] ? state : "settle";
		if (this.program === "rest") this.track = null;
		else if (CHAINS[this.program]) this.track = this.chain(this.program);
		else {
			this.track = { ...this.manifest.programs[this.program], ends: [] };
			this.seq.state.current = CLIP_OF[this.program] ?? this.seq.state.current;
		}
		this.gen++;
		return true;
	}

	poke(now = Date.now()): boolean {
		if (!this.settled(now)) return false;
		this.program = `poke-${POKES[this.pokes++ % POKES.length]}`;
		this.started = now;
		this.track = { ...this.manifest.programs[this.program], ends: [] };
		this.gen++;
		return true;
	}

	renew(now = Date.now()): boolean {
		if (!this.track || !CHAINS[this.program]) return false;
		this.leaveChain(now);
		this.started = now;
		this.track = this.chain(this.program);
		this.gen++;
		return true;
	}

	expires(now = Date.now()): number | null {
		if (!this.track || !CHAINS[this.program]) return null;
		return this.started + this.seconds(this.track.intro) * 1000 - now;
	}

	css(): string {
		const on = this.gen % 2 ? "after" : "before";
		const off = this.gen % 2 ? "before" : "after";
		const sel = ":root:not(#bot):not(#mk):not(#mk2) %MARK%";
		const still = this.manifest.static[this.state] ?? this.manifest.static.idle;
		const anims: string[] = [];
		if (this.track) {
			let at = 0;
			for (const key of this.track.intro) {
				const seg = this.manifest.segments[key];
				const d = seg.frames / this.manifest.fps;
				anims.push(`${seg.name} ${+d.toFixed(6)}s linear ${+at.toFixed(6)}s 1 forwards`);
				at += d;
			}
			for (const key of this.track.loop) {
				const seg = this.manifest.segments[key];
				anims.push(`${seg.name} ${+(seg.frames / this.manifest.fps).toFixed(6)}s linear ${+at.toFixed(6)}s infinite forwards`);
			}
		}
		const fixed = `background-image:url("${still}");background-size:1em 1em;background-position:0 0`;
		return [
			`${sel}::${on}{display:block;background-image:url("marks/${this.shape}/rest.svgz");background-size:1em 1em;background-position:0 0;animation:${anims.length ? anims.join(",") : "none"};animation-play-state:running}`,
			`${sel}::${off}{display:none;animation:none}`,
			`:root:not(#bot):not(#mk):not(#mk2) .sf-paused %MARK%::${on}{animation-play-state:paused}`,
			`:root:not(#bot):not(#mk):not(#mk2) .sf-covered %MARK%::${on}{animation-play-state:running !important}`,
			`:root.sf-still:not(#bot):not(#mk):not(#mk2) %MARK%::${on}, :root:not(#bot):not(#mk):not(#mk2) .sf-still %MARK%::${on}{animation:none;${fixed}}`,
			`@media (prefers-reduced-motion: reduce){${sel}::${on}{animation:none;${fixed}}}`,
		].join("\n");
	}
}
