import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE } from "./paths";

const MAX = Number(process.env.OMP_BOT_WORK_NUDGES) || 6;

export default function work(pi) {
	const name = process.env.OMP_BOT_NAME;
	if (!name) return;
	const file = join(STATE, "bots", name, "work.txt");
	const rule = `\n\n# Open work\n${file} lists everything the user asked you for that isn't finished, one line each and nothing else: \`todo <ask>\` while you can act on it, \`wait <ask> (<on whom>)\` while it waits on the user or a running helper. Add a line when you take work on and keep it current. Delete the line when the work is done, meaning the user can try it, or when you drop it, telling the user why in one line. A question you answer outright gets no line. When a turn ends with a todo line left, you are sent the todo lines to keep going.`;
	const read = () => (existsSync(file) ? readFileSync(file, "utf8") : "");
	let nudges = 0;
	let nudging = false;
	let calls = 0;

	pi.on("before_agent_start", async (event, c) => {
		if (c.agent?.kind === "sub") return undefined;
		if (!nudging) nudges = 0;
		nudging = false;
		calls = 0;
		if (!Array.isArray(event.systemPrompt) || event.systemPrompt.length === 0) return undefined;
		const systemPrompt = [...event.systemPrompt];
		systemPrompt[systemPrompt.length - 1] = `${systemPrompt[systemPrompt.length - 1]}${rule}`;
		return { systemPrompt };
	});

	pi.on("tool_execution_start", async (_event, c) => {
		if (c.agent?.kind !== "sub") calls += 1;
	});

	pi.on("agent_end", async (event, c) => {
		if (c.agent?.kind === "sub" || event.willContinue || c.hasPendingMessages()) return;
		const reason = event.messages?.findLast(message => message.role === "assistant")?.stopReason;
		if (reason === "aborted" || reason === "error" || reason === "length") return;
		const todo = read().split("\n").filter(line => line.startsWith("todo "));
		if (todo.length === 0 || nudges >= MAX || (nudges > 0 && calls === 0)) return;
		nudges += 1;
		nudging = true;
		pi.sendMessage(
			{
				customType: "work",
				content: `Open work you can act on:\n${todo.join("\n")}\n\nKeep going. Mark a line wait if it now waits on the user or a helper; delete it once done or dropped.`,
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});
}
