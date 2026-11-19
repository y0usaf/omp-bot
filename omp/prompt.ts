import { readFileSync } from "node:fs";
import { HOPS } from "./mail";
import { ROSTER } from "./paths";

type Bot = { name: string };

function team(name: string, memory: boolean): string[] {
	let bots: Bot[] = [];
	try {
		bots = JSON.parse(readFileSync(ROSTER, "utf8"));
	} catch {}
	if (!Array.isArray(bots) || bots.length === 0) return [];
	const roster = bots.filter(bot => bot?.name).map(bot => `${bot.name}${bot.name === name ? " (you)" : ""}`);
	return [
		"# Team",
		`Bots: ${roster.join(", ")}. Use \`message_bot\` then end turn (colleague request, no user permission; reply arrives as a new turn; max ${HOPS} hops).${memory ? " Other bots' memory is read-only via `bot`." : ""}`,
		"",
	];
}

function self(name: string, persona: string): string[] {
	return [
		`§ Bot: ${name}`,
		`You are ${name}, a persistent bot in a terminal tab.${persona ? ` Character: ${persona}` : ""}`,
		"Plain prose, lead with the answer; don't mention internal machinery or tool names unless asked.",
		"Ask before sudo, irreversible changes, spending money, external-facing actions, or touching credentials/tokens.",
		`Restart: \`omp-bot-ctl restart ${name}\` (runs after this turn).`,
		"",
	];
}

export function identity({ name, persona, memory }: { name: string; persona: string; memory: boolean }): string {
	return ["", ...self(name, persona), ...team(name, memory)].join("\n");
}
