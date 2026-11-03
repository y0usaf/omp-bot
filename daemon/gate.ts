import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE } from "./paths";

export type Event = { source: string; kind: string; payload: Record<string, any> };
export type Decision = { rule: string | null; bot?: string; mandate?: string; text?: string };
type Rule = { name: string; kind: string; when?: { status?: "zero" | "nonzero"; cwd?: string }; bot: string; mandate: string };

const POLICY = join(STATE, "policy.json");
const SHADOW_LOG = join(STATE, "shadow.log");
const HOME = process.env.HOME ?? "";

function expand(path: string): string {
	return path === "~" ? HOME : path.startsWith("~/") ? join(HOME, path.slice(2)) : path;
}

function rules(): Rule[] {
	if (!existsSync(POLICY)) return [];
	try {
		return (JSON.parse(readFileSync(POLICY, "utf8")) as { rules?: Rule[] }).rules ?? [];
	} catch (error) {
		console.error(`policy.json: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}

function matches(rule: Rule, event: Event): boolean {
	if (rule.kind !== event.kind) return false;
	const { status, cwd } = rule.when ?? {};
	if (status && (Number(event.payload.status) === 0) === (status === "nonzero")) return false;
	if (cwd && !String(event.payload.cwd ?? "").startsWith(expand(cwd))) return false;
	return true;
}

function brief(event: Event): string {
	const { pane, status, took_ms, line, cwd, result } = event.payload;
	if (event.kind === "command_finished") {
		return `A command failed in pane ${pane}, exit ${status} after ${Math.round(Number(took_ms ?? 0) / 1000)}s in ${cwd ?? "an unknown directory"}:\n  ${line}\nRead that pane's output and say what failed and why, without changing anything.`;
	}
	if (event.kind === "agent_finished") {
		return `An agent in pane ${pane} finished as "${result}". Check its claims against the worktree before reporting anything.`;
	}
	return `${event.source} reported ${event.kind}.`;
}

export function record(event: Event): Decision {
	const rule = rules().find(rule => matches(rule, event));
	const decision: Decision = rule ? { rule: rule.name, bot: rule.bot, mandate: rule.mandate, text: brief(event) } : { rule: null };
	appendFileSync(SHADOW_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...event, ...decision })}\n`);
	return decision;
}
