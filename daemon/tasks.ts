import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { STATE } from "./paths";

export const TASKS = join(STATE, "tasks");

export type TaskState = "open" | "running" | "checking" | "waiting" | "done" | "dropped";

export type Task = {
	v: number;
	id: string;
	owner: string;
	key: string | null;
	title: string;
	check: string | null;
	cwd: string;
	checkTimeout: number;
	note: string | null;
	jobs: string[];
	checkJob: string | null;
	checked: { job: string; code: number | null; reason: string | null; at: number } | null;
	question: string | null;
	answer: string | null;
	dropped: string | null;
	state: TaskState;
	seq: number;
	acked: number;
	created: number;
	updated: number;
};

export function taskState(task: Task, live: (job: string) => boolean): TaskState {
	if (task.dropped !== null) return "dropped";
	if (task.check === null) return task.answer === null ? "waiting" : "done";
	if (task.checked?.code === 0) return "done";
	if (task.question !== null) return "waiting";
	if (task.checkJob !== null) return "checking";
	if (task.jobs.some(live)) return "running";
	return "open";
}

export function final(task: Task): boolean {
	return task.state === "done" || task.state === "dropped";
}

export function verdict(task: Task): string {
	if (task.dropped !== null) return `dropped: ${task.dropped}`;
	const check = task.checked;
	if (check?.code === 0) return "check passed; the task is done";
	if (check) return `check failed (${check.code === null ? check.reason ?? "no exit code" : `exit ${check.code}`}); the task stays ${task.state}`;
	return `task ${task.state}`;
}

export function loadTask(id: string): Task | undefined {
	try {
		return JSON.parse(readFileSync(join(TASKS, id, "task.json"), "utf8"));
	} catch {
		return undefined;
	}
}

export function loadTasks(owner?: string): Task[] {
	let ids: string[] = [];
	try {
		ids = readdirSync(TASKS);
	} catch {}
	return ids
		.flatMap(id => loadTask(id) ?? [])
		.filter(task => !owner || task.owner === owner)
		.sort((a, b) => a.created - b.created);
}
