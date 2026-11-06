import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@oh-my-pi/pi-coding-agent";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";

const DIRECT: Readonly<Record<string, true>> = { eval: true, think: true, yield: true, goal: true, checkpoint: true, rewind: true };
const HIDDEN = new Set(process.env.OMP_BOT_NAME === "Lloyd" ? ["debug", "init_experiment", "run_experiment", "log_experiment", "update_notes", "web_crawl"] : []);
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const START = "\n# Code Mode\n";
const END = "\n# End Code Mode\n";
const COVERED: Readonly<Record<string, true>> = { read: true, write: true, grep: true, glob: true, bash: true };
const DRIVER = readFileSync(new URL("bash-cell.py", import.meta.url), "utf8");
const SHIM = readFileSync(new URL("bash-tool.py", import.meta.url), "utf8");
let builtins: Set<string> | undefined;
const argsIndex = process.argv.lastIndexOf("--tools");
const restricted = process.argv.includes("--no-tools") ? new Set<string>()
	: process.env.OMP_BOT_HELPER && argsIndex >= 0
		? new Set(process.argv[argsIndex + 1].split(",").filter(Boolean)) : undefined;
if (process.env.OMP_BOT_NAME === "Lloyd" && !process.env.OMP_BOT_BOXED) {
	HIDDEN.add("box");
	HIDDEN.add("context_check");
}

function description(value: unknown): string {
	return typeof value === "string" && value.trim()
		? `/** ${value.replaceAll("*/", "* /").replace(/\s+/g, " ").trim()} */ ` : "";
}

function enabled(pi: ExtensionAPI, ctx: ExtensionContext): Set<string> {
	return new Set((AgentRegistry.global().get(ctx.agent.id)?.session?.getEvalBridgeToolNames() ?? pi.getActiveTools())
		.filter(name => !HIDDEN.has(name) && (!restricted || restricted.has(name))));
}

function commands(pi: ExtensionAPI, ctx: ExtensionContext): Array<[string, ToolInfo]> {
	builtins ??= new Set(Bun.spawnSync(["bash", "-c", "compgen -b -k"]).stdout.toString().split("\n"));
	const active = enabled(pi, ctx);
	return pi.getAllTools().filter(tool => active.has(tool.name) && !Object.hasOwn(DIRECT, tool.name) && /^[\w-]+$/.test(tool.name))
		.sort((a, b) => a.name.localeCompare(b.name)).map(tool => {
			const name = tool.name.replaceAll("_", "-");
			return [Object.hasOwn(COVERED, tool.name) || Bun.which(name) || builtins?.has(name) ? `omp-${name}` : name, tool];
		});
}

function bashCells(pi: ExtensionAPI, ctx: ExtensionContext): string {
	if (!enabled(pi, ctx).has("bash")) return "";
	return ` A cell can instead be bash: {"language": "bash", "code": "..."} runs the code as a bash script in this session's cwd with stdin closed, using the shell's own cat, rg, sed, git, jq and the rest. OMP tools are executables on its PATH, prefixed omp- where the shell has its own: ${commands(pi, ctx).map(([name]) => name).join(", ")}. NAME --help lists its flags: --kebab-case options, positional arguments fill the required ones first, - or a left-out required text argument reads stdin (edit <<'EOF' takes the patch, whose [PATH#TAG] comes from omp-read or omp-grep), --json prints {"text", "details"}; a failing tool exits 1 with its error on stderr. The cell fails with the script's nonzero exit status and ends when the script does, killing whatever it left running, so long work still uses the bash tool with async.`;
}

function declarations(pi: ExtensionAPI, ctx: ExtensionContext): string {
	const z = pi.zod;
	const node = z.object({
		$ref: z.string().optional(), description: z.string().optional(),
		type: z.union([z.string(), z.array(z.string())]).optional(),
		enum: z.array(z.unknown()).optional(), anyOf: z.array(z.unknown()).optional(),
		oneOf: z.array(z.unknown()).optional(), allOf: z.array(z.unknown()).optional(),
		prefixItems: z.array(z.unknown()).optional(), items: z.unknown().optional(),
		required: z.array(z.string()).optional(), properties: z.record(z.unknown()).optional(),
		additionalProperties: z.unknown().optional(),
	}).passthrough();
	const record = z.record(z.unknown());
	function schemaType(input: unknown, root: unknown = input, seen = new Set<unknown>()): string {
		if (input === false) return "never";
		if (input === true || !input || seen.has(input)) return "unknown";
		const parsed = node.safeParse(input);
		if (!parsed.success) return "unknown";
		const schema = parsed.data;
		const path = new Set(seen).add(input);
		const render = (value: unknown) => schemaType(value, root, path);
		if (schema.$ref) {
			if (!schema.$ref.startsWith("#/")) return "unknown";
			let target: unknown = root;
			for (const part of schema.$ref.slice(2).split("/")) {
				const parent = record.safeParse(target);
				if (!parent.success) return "unknown";
				target = parent.data[part.replaceAll("~1", "/").replaceAll("~0", "~")];
			}
			return render(target);
		}
		if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const) ?? "unknown";
		if (schema.enum) return schema.enum.map(value => JSON.stringify(value) ?? "unknown").join(" | ") || "never";
		const variants = schema.anyOf ?? schema.oneOf;
		if (variants) return variants.map(render).join(" | ");
		if (schema.allOf) return schema.allOf.map(value => `(${render(value)})`).join(" & ");
		if (Array.isArray(schema.type)) return schema.type.map(type => render({ ...schema, type })).join(" | ");
		switch (schema.type) {
			case "null": return "null";
			case "string": return "string";
			case "integer":
			case "number": return "number";
			case "boolean": return "boolean";
			case "array": return schema.prefixItems ? `[${schema.prefixItems.map(render).join(", ")}]` : `Array<${render(schema.items)}>`;
			default: {
				if (schema.type !== "object" && !schema.properties) return "unknown";
				const fields = Object.entries(schema.properties ?? {}).map(([name, value]) => {
					const property = node.safeParse(value);
					return `${description(property.success ? property.data.description : undefined)}${IDENTIFIER.test(name) ? name : JSON.stringify(name)}${schema.required?.includes(name) ? "" : "?"}: ${render(value)}`;
				});
				if (schema.additionalProperties) fields.push(`[key: string]: ${schema.additionalProperties === true ? "unknown" : render(schema.additionalProperties)}`);
				return fields.length ? `{ ${fields.join("; ")} }` : "Record<string, unknown>";
			}
		}
	}
	const active = enabled(pi, ctx);
	const lines = pi.getAllTools().filter(tool => active.has(tool.name) && !Object.hasOwn(DIRECT, tool.name))
		.sort((a, b) => a.name.localeCompare(b.name)).map((tool: ToolInfo) => {
			const schema = "toJsonSchema" in tool.parameters && typeof tool.parameters.toJsonSchema === "function" ? tool.parameters.toJsonSchema() : tool.parameters;
			return `  ${description(tool.description)}${IDENTIFIER.test(tool.name) ? tool.name : JSON.stringify(tool.name)}(args: ${schemaType(schema)}): Promise<{ text: string; details?: unknown }>;`;
		});
	return `declare const tool: {\n${lines.join("\n")}\n};`;
}

function section(pi: ExtensionAPI, ctx: ExtensionContext): string {
	return `${START}Cells are Python, not JavaScript. Use r = await tool.read({"path": "file"}) and print(r["text"]); tool results are dictionaries with text and optional details. Persistent top-level state survives between cells; timeout/cancellation can restart Python, so reload missing helpers. Top-level await works; asyncio.run does not. Batch independent calls with asyncio.gather. Give cells a 2–5-word title. Long shell work uses bash {"async": True}, not an eval argument. Results arrive automatically: never poll or wait for jobs you did not start. Read proc://JOB_ID only to inspect a known job. The declarations describe arguments, not the cell language. All nested calls retain normal approval hooks and this session's tool restrictions. checkpoint and rewind require direct calls.${bashCells(pi, ctx)}\n\n\`\`\`ts\n${declarations(pi, ctx)}\n\`\`\`\n${END}`;
}

function rewrite(text: string, block: string): string {
	const start = text.indexOf(START);
	if (start >= 0) {
		const end = text.indexOf(END, start);
		if (end >= 0) return text.slice(0, start) + block + text.slice(end + END.length);
	}
	const inventory = text.indexOf("\n# Tool Inventory\n");
	if (inventory < 0) return text;
	const next = text.indexOf("\n# ", inventory + 18);
	return text.slice(0, inventory) + block + (next < 0 ? "" : text.slice(next));
}

function isDirect(name: string | undefined): boolean {
	return !!name && (Object.hasOwn(DIRECT, name) || name.startsWith("_") && Object.hasOwn(DIRECT, name.slice(1)));
}

export default function codeMode(pi: ExtensionAPI) {
	const z = pi.zod;
	const namedTool = z.object({ name: z.string().optional(), function: z.object({ name: z.string().optional() }).passthrough().optional() }).passthrough();
	const contentPart = z.object({ type: z.string().optional(), text: z.string().optional(), tool: namedTool.optional() }).passthrough();
	const payloadSchema = z.object({
		tools: z.array(namedTool),
		messages: z.array(z.object({
			role: z.string().optional(),
			content: z.union([z.string(), z.array(contentPart), z.null()]).optional(),
		}).passthrough()).optional(),
		system: z.union([z.string(), z.array(contentPart)]).optional(),
		instructions: z.string().optional(),
		tool_choice: z.union([z.string(), namedTool]).optional(),
	}).passthrough();
	const automaticChoices: Readonly<Record<string, true>> = { auto: true, none: true, required: true, any: true };
	const cellDetails = z.object({ cells: z.array(z.object({}).passthrough()) }).passthrough();
	pi.setLabel("Code mode");
	pi.registerTool({
		name: "eval", label: "Eval", loadMode: "essential",
		description: "Execute Python or bash in a persistent kernel. Call live session tools with await tool.NAME(args); print dictionary results with r[\"text\"]. Top-level await works. language is py or bash; bash cells run the code as a bash script with OMP tools as executables on PATH. Each call is one cell; state persists until reset or kernel loss.",
		parameters: z.object({ language: z.enum(["py", "bash"]), code: z.string(), title: z.string().optional(), timeout: z.number().optional(), reset: z.boolean().optional() }),
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!ctx.invokeTool) throw new Error("Code mode requires omp's native persistent eval runtime");
			if (params.language === "py") return ctx.invokeTool(params, { signal, onUpdate });
			if (!enabled(pi, ctx).has("bash")) throw new Error("bash cells need the bash tool, which this session's tool allowlist lacks");
			const dir = mkdtempSync(join(process.env.XDG_RUNTIME_DIR || tmpdir(), "omp-cell-"));
			try {
				const list = commands(pi, ctx);
				mkdirSync(join(dir, "bin"));
				for (const [name] of list) symlinkSync("../shim", join(dir, "bin", name));
				writeFileSync(join(dir, "shim.py"), SHIM);
				writeFileSync(join(dir, "cell.sh"), params.code);
				writeFileSync(join(dir, "env.json"), JSON.stringify({ ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH ?? ""}` }), { mode: 0o600 });
				writeFileSync(join(dir, "spec.json"), JSON.stringify({
					cwd: ctx.cwd, tools: list.map(([, tool]) => tool.name),
					commands: Object.fromEntries(list.map(([name, tool]) => [name, { tool: tool.name, description: tool.description, schema: "toJsonSchema" in tool.parameters && typeof tool.parameters.toJsonSchema === "function" ? tool.parameters.toJsonSchema() : tool.parameters }])),
				}));
				const code = `${DRIVER}\n_omp_status = await _omp_bash(${JSON.stringify(dir)})\nif _omp_status:\n    raise SystemExit(_omp_status)\n`;
				const relabel = (details: unknown) => {
					const parsed = cellDetails.safeParse(details);
					return parsed.success ? { ...parsed.data, language: "bash", languages: ["bash"], cells: parsed.data.cells.map(cell => ({ ...cell, language: "bash", code: params.code })) } : details;
				};
				const result = await ctx.invokeTool({ ...params, language: "py", code }, { signal, onUpdate: onUpdate && (update => onUpdate({ ...update, details: relabel(update.details) })) });
				return { ...result, details: relabel(result.details) };
			} finally {
				try {
					process.kill(-Number(readFileSync(join(dir, "pid"), "utf8")), "SIGKILL");
				} catch {}
				rmSync(dir, { recursive: true, force: true });
			}
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		await pi.setActiveTools([...enabled(pi, ctx)]);
	});
	pi.on("tool_call", (event, ctx) => {
		if (HIDDEN.has(event.toolName) || restricted && !restricted.has(event.toolName)) {
			return { block: true, reason: "This tool is disabled for this session's tool allowlist." };
		}
		if (event.toolName !== "eval" && event.toolCallId?.startsWith(`js-${event.toolName}-`) && !enabled(pi, ctx).has(event.toolName)) {
			return { block: true, reason: "This tool is not enabled in this session." };
		}
	});
	pi.on("tool_result", event => {
		if (!event.isError && event.toolCallId.startsWith(`js-${event.toolName}-`) && event.details === undefined) return { details: {} };
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (!enabled(pi, ctx).has("eval")) return;
		const block = section(pi, ctx);
		let replaced = false;
		const systemPrompt = event.systemPrompt.map(part => {
			const next = rewrite(part, block);
			replaced ||= next !== part;
			return next;
		});
		if (!replaced) systemPrompt.push(block);
		return { systemPrompt };
	});
	pi.on("before_provider_request", (event, ctx) => {
		const parsed = payloadSchema.safeParse(event.payload);
		if (!parsed.success) return event.payload;
		const payload = parsed.data;
		if (!payload.tools.some(tool => (tool.function?.name ?? tool.name) === "eval" || (tool.function?.name ?? tool.name) === "_eval")) return event.payload;
		const block = section(pi, ctx);
		const tools = payload.tools.filter(tool => isDirect(tool.function?.name ?? tool.name));
		const names = new Set(tools.map(tool => tool.function?.name ?? tool.name));
		const messages = payload.messages?.flatMap(message => {
			if (typeof message.content === "string" && (message.role === "system" || message.role === "developer")) return [{ ...message, content: rewrite(message.content, block) }];
			if (!Array.isArray(message.content)) return [message];
			const content = message.content.filter(part => part.type !== "tool_addition" && part.type !== "tool_removal" || names.has(part.tool?.name))
				.map(part => (message.role === "system" || message.role === "developer") && part.type === "text" && typeof part.text === "string" ? { ...part, text: rewrite(part.text, block) } : part);
			return content.length ? [{ ...message, content }] : [];
		});
		const system = typeof payload.system === "string" ? rewrite(payload.system, block) : payload.system?.map(part => part.type === "text" && typeof part.text === "string" ? { ...part, text: rewrite(part.text, block) } : part);
		const instructions = typeof payload.instructions === "string" ? rewrite(payload.instructions, block) : payload.instructions;
		const next = { ...payload, tools, ...(messages ? { messages } : {}), ...(system ? { system } : {}), ...(instructions ? { instructions } : {}) };
		const choice = payload.tool_choice;
		const forced = typeof choice === "string" ? choice : choice?.name ?? choice?.function?.name;
		if (forced && !Object.hasOwn(automaticChoices, forced) && !isDirect(forced)) delete next.tool_choice;
		return next;
	});
}
