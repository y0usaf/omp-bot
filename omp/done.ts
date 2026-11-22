import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { STATE } from "./paths.ts";
import { announceDone, installQuietDone } from "./quiet.ts";

const DIR = join(STATE, "bots", process.env.OMP_BOT_NAME ?? "-", "checks");
const ROUNDS = Number(process.env.OMP_BOT_CHECK_ROUNDS) || 3;
const TIMEOUT = 600000;
const POLL_MS = 2000;
const TAIL = 1200;
const EXPIRES = 12 * 60 * 60 * 1000;

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function normalizeAudit(raw) {
	if (!raw || typeof raw !== "object") return undefined;
	if (raw.kind !== "design" && raw.kind !== "code" && raw.kind !== "repo") return undefined;
	if (!Array.isArray(raw.targets)) return undefined;
	const targets = raw.targets.filter(t => typeof t === "string" && t.trim().length > 0).map(t => t.trim());
	if (targets.length === 0) return undefined;
	const maxRounds = Math.max(1, Math.min(2, Math.floor(Number(raw.max_rounds) || 2)));
	const baseRef = typeof raw.base_ref === "string" && raw.base_ref.trim() ? raw.base_ref.trim() : undefined;
	return { kind: raw.kind, targets, base_ref: baseRef, max_rounds: maxRounds };
}

async function loadGoldfish() {
	const candidates = [
		process.env.OMP_GOLDFISH_EXT,
		join(homedir(), ".omp", "agent", "ext", "goldfish.ts"),
	].filter(Boolean);
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		const mod = await import(pathToFileURL(candidate).href);
		if (typeof mod.runGoldfishAudit === "function") return mod;
	}
	return undefined;
}

export default function (pi) {
	const name = process.env.OMP_BOT_NAME;
	if (!name) return;
	pi.setLabel("Bot done-checks");
	installQuietDone(pi);
	let mine;
	const watched = new Map();
	let timer;
	let where;

	const take = id => {
		const file = join(DIR, `${id}.json`);
		const spec = readJson(file);
		if (spec) rmSync(file, { force: true });
		return spec;
	};

	const lastWords = id => {
		try {
			const file = where?.sessionManager?.getSessionFile?.();
			if (!file) return "";
			let text = "";
			for (const line of readFileSync(file.replace(/\.jsonl$/, `/${id}.jsonl`), "utf8").split("\n")) {
				if (!line.includes('"assistant"')) continue;
				const message = JSON.parse(line)?.message;
				if (message?.role !== "assistant") continue;
				const said = (message.content ?? [])
					.filter(part => part?.type === "text")
					.map(part => part.text)
					.join("")
					.trim();
				if (said) text = said;
			}
			return text.length > TAIL ? `${text.slice(0, TAIL)}…` : text;
		} catch {
			return "";
		}
	};

	const forget = id => {
		watched.delete(id);
		rmSync(join(DIR, `${id}.json`), { force: true });
		rmSync(join(DIR, `${id}.status`), { force: true });
	};

	const fail = (id, text) => {
		const report = lastWords(id);
		pi.sendMessage(
			{ customType: "done-check", content: report ? `${text}\n\nHelper's last word: ${report}` : text, display: true, attribution: "agent" },
			{ deliverAs: "followUp", triggerTurn: true },
		);
		forget(id);
	};

	const pass = (id, entry, rounds, auditNote) => {
		const parts = [];
		if (rounds) parts.push(`after ${rounds} failed ${rounds === 1 ? "try" : "tries"}`);
		if (auditNote) parts.push(auditNote);
		announceDone(pi, {
			ask: entry.ask || id,
			agent: id,
			check: entry.command || (entry.audit ? `goldfish:${entry.audit.kind}` : ""),
			note: parts.join("; "),
			output: lastWords(id),
		}, where);
		forget(id);
	};

	const sweep = () => {
		for (const [id, entry] of watched) {
			const seen = readJson(join(DIR, `${id}.status`));
			if (seen?.state === "passed") {
				const auditNote = seen.verdict ? `goldfish ${seen.verdict}${seen.summary ? `: ${seen.summary}` : ""}` : "";
				pass(id, entry, seen.rounds, auditNote);
				continue;
			}
			if (seen?.state === "audit_rethink") {
				fail(
					id,
					`Goldfish audit on ${id} returned RETHINK and stopped:\n\n${seen.report || seen.summary || "(no report)"}`,
				);
				continue;
			}
			if (seen?.state === "audit_failed") {
				fail(
					id,
					`Goldfish audit on ${id} did not pass after ${seen.auditRounds ?? 0} round(s) and stopped:\n\n${seen.report || seen.summary || "(no report)"}`,
				);
				continue;
			}
			if (seen?.state === "failed") {
				fail(
					id,
					`Done-check on ${id} failed every try (${seen.rounds}) and the helper stopped: \`${entry.command}\` exited ${seen.code}. ${seen.output || "(no output)"}`,
				);
				continue;
			}
			if (Date.now() - entry.since > EXPIRES) watched.delete(id);
		}
		if (watched.size === 0 && timer !== undefined) {
			where?.clearTimer?.(timer);
			timer = undefined;
		}
	};

	const watch = (ctx, id, command, ask, audit) => {
		if (!id) return;
		watched.set(id, { command, ask, audit, since: Date.now() });
		where = ctx;
		if (timer === undefined) {
			timer = ctx.setInterval(sweep, POLL_MS);
			timer?.unref?.();
		}
	};

	pi.on("agent_end", async (event, ctx) => {
		if (ctx.agent?.kind !== "sub" || event.willContinue || ctx.hasPendingMessages()) return;
		if (!mine) mine = take(ctx.agent.id);
		if (!mine) return;
		const reason = event.messages?.findLast(message => message.role === "assistant")?.stopReason;
		if (reason === "aborted" || reason === "error" || reason === "length") return;
		const id = ctx.agent.id;
		const file = join(DIR, `${id}.status`);
		const before = readJson(file) ?? { rounds: 0, auditRounds: 0 };
		if (
			before.state === "passed" ||
			before.state === "failed" ||
			before.state === "audit_rethink" ||
			before.state === "audit_failed"
		) {
			return;
		}

		let checkOutput;
		if (mine.command) {
			if ((before.rounds ?? 0) > mine.rounds) return;
			const result = await pi.exec("sh", ["-c", mine.command], { cwd: mine.cwd, timeout: TIMEOUT });
			const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
			const tail = output.length > TAIL ? `…${output.slice(-TAIL)}` : output;
			if (result.code !== 0) {
				const rounds = (before.rounds ?? 0) + 1;
				writeFileSync(
					file,
					JSON.stringify({
						state: rounds > mine.rounds ? "failed" : "running",
						rounds,
						auditRounds: before.auditRounds ?? 0,
						code: result.code,
						output: tail,
					}),
				);
				if (rounds > mine.rounds) return;
				pi.sendMessage(
					{
						customType: "done-check",
						content: `Not done: the done-check exited ${result.code} (round ${rounds} of ${mine.rounds}).\n${tail || "(no output)"}\n\nKeep working until it passes.`,
						display: false,
					},
					{ deliverAs: "followUp", triggerTurn: true },
				);
				return;
			}
			if (!mine.audit) {
				writeFileSync(file, JSON.stringify({ state: "passed", rounds: before.rounds ?? 0 }));
				return;
			}
			checkOutput = { command: mine.command, code: 0, output: tail };
		}

		if (!mine.audit) return;

		let goldfishMod;
		try {
			goldfishMod = await loadGoldfish();
		} catch (err) {
			writeFileSync(
				file,
				JSON.stringify({
					state: "audit_failed",
					rounds: before.rounds ?? 0,
					auditRounds: before.auditRounds ?? 0,
					report: `Goldfish extension failed to load: ${err?.message ?? String(err)}`,
				}),
			);
			return;
		}
		if (!goldfishMod) {
			writeFileSync(
				file,
				JSON.stringify({
					state: "audit_failed",
					rounds: before.rounds ?? 0,
					auditRounds: before.auditRounds ?? 0,
					report: "Goldfish extension unavailable.",
				}),
			);
			return;
		}

		let auditResult;
		try {
			auditResult = await goldfishMod.runGoldfishAudit(
				{
					kind: mine.audit.kind,
					targets: mine.audit.targets,
					base_ref: mine.audit.base_ref,
					check_output: checkOutput,
				},
				ctx,
			);
		} catch (err) {
			writeFileSync(
				file,
				JSON.stringify({
					state: "audit_failed",
					rounds: before.rounds ?? 0,
					auditRounds: before.auditRounds ?? 0,
					report: `Goldfish audit failed: ${err?.message ?? String(err)}`,
				}),
			);
			return;
		}

		const report =
			typeof goldfishMod.formatGoldfishReport === "function"
				? goldfishMod.formatGoldfishReport(auditResult)
				: JSON.stringify(auditResult, null, 2);

		if (auditResult.verdict === "SHIP") {
			writeFileSync(
				file,
				JSON.stringify({
					state: "passed",
					rounds: before.rounds ?? 0,
					auditRounds: before.auditRounds ?? 0,
					verdict: "SHIP",
					summary: auditResult.summary,
					report,
				}),
			);
			return;
		}

		if (auditResult.verdict === "RETHINK") {
			writeFileSync(
				file,
				JSON.stringify({
					state: "audit_rethink",
					rounds: before.rounds ?? 0,
					auditRounds: (before.auditRounds ?? 0) + 1,
					verdict: "RETHINK",
					summary: auditResult.summary,
					report,
				}),
			);
			return;
		}

		const auditRounds = (before.auditRounds ?? 0) + 1;
		const maxAudit = mine.audit.max_rounds ?? 2;
		if (auditRounds > maxAudit) {
			writeFileSync(
				file,
				JSON.stringify({
					state: "audit_failed",
					rounds: before.rounds ?? 0,
					auditRounds,
					verdict: "FIX_FIRST",
					summary: auditResult.summary,
					report,
				}),
			);
			return;
		}

		writeFileSync(
			file,
			JSON.stringify({
				state: "running",
				rounds: before.rounds ?? 0,
				auditRounds,
				verdict: "FIX_FIRST",
				summary: auditResult.summary,
			}),
		);
		const blockers = (auditResult.findings ?? [])
			.filter(f => f.severity === "blocking")
			.map(f => `- ${f.file}:${f.line} — ${f.issue}\n  Scenario: ${f.scenario}\n  Fix: ${f.fix}`)
			.join("\n");
		pi.sendMessage(
			{
				customType: "goldfish-audit",
				content: `Goldfish blind audit returned FIX_FIRST (round ${auditRounds} of ${maxAudit}). Fix these concrete blocking defects:\n\n${blockers || report}`,
				display: false,
			},
			{ deliverAs: "followUp", triggerTurn: true },
		);
	});

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.agent?.kind === "sub") {
			mine = take(ctx.agent.id);
			return;
		}
		let native;
		try {
			native = pi.getAllTools().find(tool => tool.name === "task" && tool.sourceInfo?.source === "builtin");
		} catch {}
		const schema = native?.parameters?.toJsonSchema?.({ target: "draft-2020-12" });
		const item = schema?.properties?.tasks?.items?.properties;
		if (!item) return;
		item.check = {
			type: "string",
			description: "Hidden post-stop shell check; non-zero output continues helper.",
		};
		item.audit = {
			type: "object",
			additionalProperties: false,
			required: ["kind", "targets"],
			properties: {
				kind: { type: "string", enum: ["design", "code", "repo"] },
				targets: { type: "array", items: { type: "string" }, minItems: 1 },
				base_ref: { type: "string" },
				max_rounds: { type: "integer", minimum: 1, maximum: 2 },
			},
			description: "Hidden post-stop blind Goldfish audit; blocking findings continue helper up to max_rounds (1-2, default 2).",
		};
		pi.registerTool({
			name: "task",
			label: "Task",
			description: `${native.description ?? "Spawn subagents."}\n\`check\`: hidden post-stop shell check (up to ${ROUNDS} rounds).\n\`audit\`: hidden post-stop blind Goldfish audit (up to 2 rounds).`,
			parameters: schema,
			loadMode: "essential",
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const tasks = Array.isArray(params?.tasks) ? params.tasks : undefined;
				if (!tasks) return await ctx.invokeTool(params, { signal, onUpdate });
				const checks = [];
				const clean = tasks.map((task, index) => {
					const { check: rawCommand, audit: rawAudit, ...rest } = task ?? {};
					const command = typeof rawCommand === "string" && rawCommand.trim().length > 0 ? rawCommand.trim() : "";
					const audit = normalizeAudit(rawAudit);
					if (!command && !audit) return rest;
					const id = String(rest.name ?? "").trim() || `Checked${randomBytes(4).toString("hex")}${index}`;
					const ask = typeof rest.task === "string" && rest.task.trim() ? rest.task.trim() : id;
					checks[index] = { id, command, ask, audit };
					mkdirSync(DIR, { recursive: true });
					writeFileSync(
						join(DIR, `${id}.json`),
						JSON.stringify({ command, audit, ask, cwd: ctx.cwd, rounds: ROUNDS }),
					);
					return { ...rest, name: id };
				});
				const result = await ctx.invokeTool({ ...params, tasks: clean }, { signal, onUpdate });
				const spawns = result?.details?.progress ?? result?.details?.results ?? [];
				for (const spawn of spawns) {
					const want = checks[spawn?.index];
					if (!want) continue;
					const kept = join(DIR, `${want.id}.json`);
					if (spawn.id && spawn.id !== want.id && existsSync(kept)) {
						writeFileSync(join(DIR, `${spawn.id}.json`), JSON.stringify(readJson(kept)));
						rmSync(kept, { force: true });
						want.id = spawn.id;
					}
					watch(ctx, want.id, want.command, want.ask, want.audit);
				}
				sweep();
				return result;
			},
		});
	});
}
