import { forget, list, meta, NAME, names, pending, reveal, store, bots, type Request } from "./secrets";

const USAGE = `usage: omp-bot-secret [COMMAND]
  (nothing)                          secrets bots asked for and haven't got, and the ones set
  NAME [--bot BOT] [--ttl TTL]       enter NAME's value, masked, for the bot that asked (TTL: 30m, 12h, 7d or never; default the bot's ask, else 24h)
  list [--bot BOT]                   set secrets: bot, name, when set, when they expire; never values
  forget NAME [--bot BOT]            delete a secret now
  run                                run the command on stdin with its $SECRET_ names set and their values redacted (the bot's bash hook uses it)`;

function fail(message: string): never {
	console.error(`omp-bot-secret: ${message}`);
	process.exit(1);
}

function flags(args: string[]): { rest: string[]; opts: Record<string, string> } {
	const rest: string[] = [];
	const opts: Record<string, string> = {};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--bot" || args[i] === "--ttl") {
			if (i + 1 >= args.length) fail(`${args[i]} needs a value`);
			opts[args[i].slice(2)] = args[++i];
		} else rest.push(args[i]);
	}
	return { rest, opts };
}

function when(ms: number | null): string {
	if (ms === null) return "never";
	const d = new Date(ms);
	const two = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

function show(bot?: string) {
	const rows = (bot ? [bot] : bots()).flatMap(b => list(b).map(found => ({ bot: b, ...found })));
	if (rows.length === 0) return console.log("No secrets set.");
	for (const row of rows) console.log(`${row.bot}\t${row.name}\tset ${when(row.set)}\texpires ${when(row.expires)}${row.reason ? `\t${row.reason}` : ""}`);
}

function asked(): Request[] {
	return pending().filter(entry => !meta(entry.bot, entry.name));
}

async function masked(prompt: string): Promise<string> {
	const stdin = process.stdin;
	if (!stdin.isTTY) {
		const text = await new Response(Bun.stdin.stream()).text();
		return text.replace(/\r?\n$/, "");
	}
	process.stderr.write(prompt);
	stdin.setRawMode(true);
	stdin.resume();
	return new Promise((resolve, reject) => {
		let value = "";
		const done = (error?: Error) => {
			stdin.setRawMode(false);
			stdin.pause();
			stdin.off("data", onData);
			process.stderr.write("\n");
			error ? reject(error) : resolve(value);
		};
		const onData = (chunk: Buffer) => {
			for (const char of chunk.toString("utf8")) {
				if (char === "\r" || char === "\n") return done();
				if (char === "\u0003" || char === "\u0004") return done(new Error("cancelled"));
				if (char === "\u007f" || char === "\b") {
					if (value.length > 0) {
						value = [...value].slice(0, -1).join("");
						process.stderr.write("\b \b");
					}
					continue;
				}
				if (char === "\u0015") {
					process.stderr.write("\b \b".repeat([...value].length));
					value = "";
					continue;
				}
				if (char < " ") continue;
				value += char;
				process.stderr.write("*");
			}
		};
		stdin.on("data", onData);
	});
}

function pick(name: string, bot: string | undefined, candidates: string[], what: string): string {
	if (bot) return bot;
	if (candidates.length === 1) return candidates[0];
	if (candidates.length === 0) fail(`no bot ${what} ${name}; pass --bot BOT`);
	fail(`${candidates.join(", ")} ${what} ${name}; pass --bot BOT`);
}

function redactor(values: [string, Buffer][], out: NodeJS.WriteStream) {
	let held = Buffer.alloc(0);
	const partial = (rest: Buffer) => {
		let best = 0;
		for (const [, value] of values) {
			for (let k = Math.min(value.length - 1, rest.length); k > best; k--) {
				if (rest.subarray(rest.length - k).equals(value.subarray(0, k))) {
					best = k;
					break;
				}
			}
		}
		return best;
	};
	const scan = (buffer: Buffer, final: boolean) => {
		const parts: Buffer[] = [];
		let at = 0;
		for (;;) {
			let best = -1;
			let hit: [string, Buffer] | undefined;
			for (const entry of values) {
				const index = buffer.indexOf(entry[1], at);
				if (index >= 0 && (best < 0 || index < best || (index === best && entry[1].length > hit![1].length))) {
					best = index;
					hit = entry;
				}
			}
			if (!hit) break;
			parts.push(buffer.subarray(at, best), Buffer.from(`[SECRET_${hit[0]}]`));
			at = best + hit[1].length;
		}
		const keep = final ? 0 : partial(buffer.subarray(at));
		parts.push(buffer.subarray(at, buffer.length - keep));
		held = Buffer.from(buffer.subarray(buffer.length - keep));
		const text = Buffer.concat(parts);
		if (text.length > 0) out.write(text);
	};
	return {
		write: (chunk: Uint8Array) => scan(Buffer.concat([held, chunk]), false),
		end: () => scan(held, true),
	};
}

async function pipe(stream: ReadableStream<Uint8Array>, sink: ReturnType<typeof redactor>) {
	for await (const chunk of stream) sink.write(chunk);
	sink.end();
}

async function run() {
	const bot = process.env.OMP_BOT_NAME;
	if (!bot) fail("run needs OMP_BOT_NAME");
	const command = (await new Response(Bun.stdin.stream()).text()).replace(/\n$/, "");
	const env: Record<string, string | undefined> = { ...process.env };
	const values: [string, Buffer][] = [];
	for (const name of names(command)) {
		const value = await reveal(bot, name);
		if (value === undefined) fail(`${bot} has no secret ${name}, or it expired; ask for it with the secret tool`);
		env[`SECRET_${name}`] = value;
		if (value.length > 0) values.push([name, Buffer.from(value)]);
	}
	const child = Bun.spawn(["bash", "-c", command], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
	const out = values.length ? redactor(values, process.stdout) : undefined;
	const err = values.length ? redactor(values, process.stderr) : undefined;
	await Promise.all([
		out ? pipe(child.stdout, out) : (async () => { for await (const chunk of child.stdout) process.stdout.write(chunk); })(),
		err ? pipe(child.stderr, err) : (async () => { for await (const chunk of child.stderr) process.stderr.write(chunk); })(),
	]);
	process.exit(await child.exited);
}

const [command, ...args] = process.argv.slice(2);
const { rest, opts } = flags(args);
switch (command) {
	case undefined: {
		const open = asked();
		if (open.length === 0) console.log("No bot is waiting for a secret.");
		for (const entry of open) console.log(`${entry.bot} asks for ${entry.name} (${when(entry.at)}): ${entry.reason}\n  omp-bot-secret ${entry.name}${open.filter(other => other.name === entry.name).length > 1 ? ` --bot ${JSON.stringify(entry.bot)}` : ""}`);
		console.log("");
		show();
		break;
	}
	case "list":
		show(opts.bot);
		break;
	case "forget": {
		const name = rest[0];
		if (!name || !NAME.test(name)) fail(USAGE);
		const bot = pick(name, opts.bot, bots().filter(b => meta(b, name)), "holds");
		if (!forget(bot, name)) fail(`${bot} has no secret ${name}`);
		console.log(`Forgot ${bot}'s ${name}.`);
		break;
	}
	case "run":
		await run();
		break;
	case "-h":
	case "--help":
		console.log(USAGE);
		break;
	default: {
		if (!NAME.test(command)) fail(`'${command}' is not a secret name (capitals, digits and _, starting with a capital)\n${USAGE}`);
		const asking = asked().filter(entry => entry.name === command);
		const bot = pick(command, opts.bot, [...new Set(asking.map(entry => entry.bot))], "asked for");
		const ask = asking.find(entry => entry.bot === bot);
		if (ask) console.error(`${bot} asks for ${command}: ${ask.reason}`);
		const value = await masked(`${command} for ${bot} (hidden): `).catch(() => fail("cancelled"));
		if (value === "") fail("empty value, nothing stored");
		const found = await store(bot, command, value, opts.ttl ?? ask?.ttl, ask?.reason).catch(error => fail(error.message));
		console.error(`Stored ${command} for ${bot}, expires ${when(found.expires)}.`);
	}
}
