import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const COMMAND = /^[/!]/;

export default function bargeIn(pi: ExtensionAPI) {
	let tools = 0;
	pi.on("tool_execution_start", () => {
		tools += 1;
	});
	pi.on("tool_execution_end", () => {
		tools = Math.max(0, tools - 1);
	});
	pi.on("agent_end", () => {
		tools = 0;
	});
	pi.on("input", (event, ctx) => {
		if (ctx.agent?.kind === "sub" || event.source === "extension" || tools > 0 || ctx.isIdle()) return;
		const text = event.text.trim();
		if (!text || COMMAND.test(text)) return;
		const content = event.images?.length
			? [{ type: "text" as const, text }, ...event.images]
			: text;
		pi.sendUserMessage(content, { deliverAs: "steer" });
		ctx.abort();
		return { handled: true };
	});
}
