import { homedir } from "node:os";
import { join } from "node:path";

const PINNED = Symbol.for("omp-bot.cwd");
const SAVE = `tmp=$(mktemp "$1.XXXXXX") || exit 1
jq --arg n "$2" --arg c "$3" 'map(if .name == $n then .cwd = $c else . end)' "$1" >"$tmp" || { rm -f "$tmp"; exit 1; }
chmod 644 "$tmp" && mv -f "$tmp" "$1"`;

function tilde(dir: string) {
	const home = homedir();
	if (dir === home) return "~";
	return dir.startsWith(`${home}/`) ? `~/${dir.slice(home.length + 1)}` : dir;
}

export default function cwd(pi) {
	const name = process.env.OMP_BOT_NAME;
	const state = process.env.OMP_BOT_STATE;
	if (!name || !state) return;
	let ctx;

	pi.setLabel("Bot directory");

	async function remember(dir: string) {
		const save = Bun.spawn(["flock", join(state, "bots.lock"), "sh", "-c", SAVE, "sh", join(state, "bots.json"), name, tilde(dir)], { stdout: "ignore", stderr: "pipe" });
		if ((await save.exited) === 0) return;
		const why = (await new Response(save.stderr).text()).trim();
		ctx?.ui?.notify?.(`omp-bot: moved to ${dir}, but couldn't save it to the roster${why ? `: ${why}` : ""}`, "warning");
	}

	function pin(c) {
		if (c.agent?.kind === "sub") return;
		ctx = c;
		const manager = c.sessionManager;
		if (!manager || manager[PINNED]) return;
		manager[PINNED] = true;
		const moveTo = manager.moveTo.bind(manager);
		manager.moveTo = async (dir: string, sessionDir?: string) => {
			await moveTo(dir, sessionDir ?? manager.getSessionDir());
			await remember(manager.getCwd());
		};
	}

	pi.on("session_start", async (_event, c) => pin(c));
	pi.on("session_switch", async (_event, c) => pin(c));

	pi.on("input", async event => {
		const dir = /^\/cwd\s+(\S[\s\S]*)$/.exec(String(event.text ?? "").trim())?.[1];
		return dir ? { text: `/move ${dir}` } : undefined;
	});

	pi.registerCommand("cwd", {
		description: "Show the bot's working directory; /cwd DIR moves the bot there, as /move does, and it starts there from now on",
		handler: async (_args, c) => {
			c.ui.notify(c.sessionManager.getCwd(), "info");
		},
	});
}
