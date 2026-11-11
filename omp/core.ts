import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE } from "./paths";
import { identity } from "./prompt";

export default function core(pi) {
	const name = process.env.OMP_BOT_NAME;
	if (!name) return;
	const persona = process.env.OMP_BOT_PERSONA || "";
	const restart = join(STATE, "bots", name, "restart");
	let ctx;

	pi.setLabel("Bot core");

	pi.on("session_start", async (_event, c) => {
		if (c.agent?.kind === "sub") return;
		ctx = c;
		c.setInterval(() => {
			if (!existsSync(restart) || !ctx?.isIdle()) return;
			rmSync(restart, { force: true });
			if (process.env.OMP_BOT_RELAUNCH) writeFileSync(process.env.OMP_BOT_RELAUNCH, "");
			ctx.shutdown();
		}, 1000);
	});

	pi.on("before_agent_start", async (event, c) => {
		if (c.agent?.kind === "sub" || !Array.isArray(event.systemPrompt) || event.systemPrompt.length === 0) return undefined;
		const text = identity({ name, persona, memory: process.env.OMP_BOT_MEMORY === "optchat" });
		const systemPrompt = [...event.systemPrompt];
		systemPrompt[systemPrompt.length - 1] = `${systemPrompt[systemPrompt.length - 1]}${text}`;
		return { systemPrompt };
	});
}
