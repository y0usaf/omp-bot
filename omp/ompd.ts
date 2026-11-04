const UNKNOWN = "Previous OMP process exited before this tool returned";

function cutOff(entries): Set<string> {
	const started = new Set<string>();
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === "tool_execution_start" && entry.data?.toolCallId) started.add(entry.data.toolCallId);
		if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
		const text = entry.message.content?.find?.(part => part?.type === "text")?.text ?? "";
		if (!text.startsWith(UNKNOWN)) started.delete(entry.message.toolCallId);
	}
	return started;
}

export default function ompd(pi) {
	const cut = new Set<string>();

	pi.setLabel("ompd");

	pi.on("session_start", async (_event, ctx) => {
		for (const id of cutOff(ctx.sessionManager.getEntries())) cut.add(id);
	});

	pi.on("tool_call", async event => {
		if (!cut.delete(event.toolCallId)) return undefined;
		return {
			block: true,
			reason: `This ${event.toolName} call was cut off when the last run ended, before it returned. Its outcome is unknown and it was not run again: check what it did before deciding to run it again.`,
		};
	});
}
