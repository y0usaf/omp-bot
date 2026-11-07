const CHANGE = String.raw`\b(?:push|rebase|amend|filter-(?:repo|branch))`;
const NAMED = new RegExp(CHANGE, "i");
const REFUSED = new RegExp(String.raw`\b(?:don'?t|do not|does not|never|not|no|stop|hold off|wait)\b[^.!?;\n]{0,20}${CHANGE}`, "i");

export function approvesGit(text: string): boolean {
	return text.split(/[.!?;\n]+/).some(clause => NAMED.test(clause) && !REFUSED.test(clause));
}

export function gitAllowed(held: { id: string; answer: string | null }[], task: string, live: boolean): boolean {
	if (live) return true;
	return task ? held.some(row => row.id === task && row.answer !== null && JSON.parse(row.answer).action === "approve") : held.length === 0;
}
