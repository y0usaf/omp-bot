import { realpathSync } from "node:fs";
import { connect } from "node:net";
import { SOCKET } from "./paths";

const args = process.argv.slice(2);
let at = 0;
while (args[at]?.startsWith("-")) {
	const option = args[at++];
	if (["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"].includes(option)) at++;
}
const [command, ...rest] = args.slice(at);
const guarded = (command === "push" && !rest.some(arg => arg === "--dry-run" || arg === "-n")) || (command === "rebase" && !rest.some(arg => arg === "--abort" || arg === "--quit")) || (command === "commit" && rest.includes("--amend")) || command === "filter-repo" || command === "filter-branch";
try {
	if (guarded && process.env.OMP_BOT_NAME) await new Promise<void>((resolve, reject) => {
		const socket = connect(SOCKET);
		let buffer = "";
		socket.setTimeout(5000, () => socket.destroy(new Error("git approval daemon timed out")));
		socket.on("connect", () => socket.write(`${JSON.stringify({ op: "git-check", bot: process.env.OMP_BOT_NAME })}\n`));
		socket.on("data", chunk => {
			buffer += chunk;
			if (!buffer.includes("\n")) return;
			socket.end();
			try {
				const reply = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
				reply.ok && reply.allowed ? resolve() : reject(new Error(reply.error || "git publishing/history changes need the user's task approval; ask_decision and wait"));
			} catch (error) { reject(error); }
		});
		socket.on("error", reject);
	});
	const git = process.env.OMP_BOT_REAL_GIT;
	if (!git) throw new Error("OMP_BOT_REAL_GIT is unset");
	if (realpathSync(git) === realpathSync(`${import.meta.dir}/../git/git`)) throw new Error(`OMP_BOT_REAL_GIT points at this wrapper (${git}), not git`);
	process.exit(await Bun.spawn([git, ...args], { stdin: "inherit", stdout: "inherit", stderr: "inherit" }).exited);
} catch (error) {
	console.error(`omp-bot: ${error instanceof Error ? error.message : error}`);
	process.exit(1);
}
