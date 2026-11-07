import { expect, test } from "bun:test";
import { approvesGit, gitAllowed } from "./guard";

const approved = [{ id: "t1", answer: JSON.stringify({ action: "approve" }) }];
const asked = [{ id: "t1", answer: JSON.stringify({ action: "deny" }) }];
const running = [{ id: "t1", answer: null }];

test("a live approval names the change", () => {
	for (const text of ["yeah, you can push", "Push it, branch and all", "go ahead and rebase onto main", "you can push; and amend the message"])
		expect(approvesGit(text)).toBe(true);
});

test("other live chat and refusals are not approval", () => {
	for (const text of ["sounds good, carry on", "don't push yet", "no push today", "wait, do not rebase that", "not yet: push after the tests", ""])
		expect(approvesGit(text)).toBe(false);
});

test("a task-only turn needs that task's approval", () => {
	expect(gitAllowed(running, "t1", false)).toBe(false);
	expect(gitAllowed([], "t1", false)).toBe(false);
	expect(gitAllowed(approved, "t1", false)).toBe(true);
	expect(gitAllowed(asked, "t1", false)).toBe(false);
	expect(gitAllowed(approved, "t2", false)).toBe(false);
});

test("live chat is approval without a task and overrides a waiting task", () => {
	expect(gitAllowed([], "", false)).toBe(true);
	expect(gitAllowed(running, "t1", true)).toBe(true);
	expect(gitAllowed(asked, "t1", true)).toBe(true);
	expect(gitAllowed(running, "", true)).toBe(true);
});
