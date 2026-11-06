import json, os, re, signal, socket, sys
signal.signal(signal.SIGPIPE, signal.SIG_DFL)
d = os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[0])))
name = os.path.basename(sys.argv[0])
spec = json.load(open(f"{d}/spec.json"))["commands"][name]
root = spec["schema"] if isinstance(spec["schema"], dict) else {}
KIND = {bool: "boolean", int: "number", float: "number", str: "string", type(None): "null", list: "array", dict: "object"}


def fail(message, code=2):
    print(f"{name}: {message}", file=sys.stderr)
    sys.exit(code)


def resolve(s):
    for _ in range(32):
        if not (isinstance(s, dict) and str(s.get("$ref", "")).startswith("#/")):
            break
        target = root
        for part in s["$ref"][2:].split("/"):
            target = target.get(part.replace("~1", "/").replace("~0", "~")) if isinstance(target, dict) else None
        s = target
    return s if isinstance(s, dict) else {}


def kinds(s):
    s = resolve(s)
    out = {KIND.get(type(v), "any") for v in ([s["const"]] if "const" in s else []) + s.get("enum", [])}
    for v in s.get("anyOf", []) + s.get("oneOf", []):
        out |= kinds(v)
    t = s.get("type", [])
    out |= {"number" if x == "integer" else x for x in (t if isinstance(t, list) else [t])}
    if "properties" in s:
        out.add("object")
    return out or {"any"}


def items(s):
    s = resolve(s)
    if "array" in (s.get("type") or ""):
        return s.get("items", {})
    return next((items(v) for v in s.get("anyOf", []) + s.get("oneOf", []) if "array" in kinds(v)), {})


def boolean(s):
    return kinds(s) - {"null"} == {"boolean"}


def label(s):
    s = resolve(s)
    values = ([s["const"]] if "const" in s else []) + s.get("enum", [])
    if values:
        return "|".join(v if isinstance(v, str) else json.dumps(v) for v in values)
    k = kinds(s) - {"null"}
    if k == {"array"}:
        return label(items(s)) + "..."
    return "TEXT" if "string" in k else "N" if k == {"number"} else "JSON"


props = resolve(root).get("properties", {})
required = [k for k in resolve(root).get("required", []) if k in props]
order = required + [k for k in props if k not in required and not boolean(props[k])]
flag = {k: re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "-", k).replace("_", "-").lower() for k in props}
by_flag = {v: k for k, v in flag.items()} | {k: k for k in props}


def usage():
    lines = [" ".join([f"usage: {name} [options]"] + [k.upper() if k in required else f"[{k.upper()}]" for k in order]), "", spec["description"] or "", "", "options:"]
    for k, s in props.items():
        lines.append(f"  --{flag[k]}" + ("" if boolean(s) else f" {label(s)}"))
        text = ("required. " if k in required else "") + str(resolve(s).get("description", ""))
        if text.strip():
            lines.append(f"      {text.strip()}")
    lines += ["  --json", '      print the result as JSON: {"text": ..., "details": ...}', "  -h, --help", "",
              "Positional arguments fill the arguments in the usage line, in order. A value of - reads stdin; a required text argument left out is read from stdin.",
              "Booleans take --flag or --no-flag; arrays repeat the flag or take a JSON array; objects take JSON.",
              "Exit status: 0 on success, 1 when the tool fails, 2 on bad usage."]
    return "\n".join(lines)


def convert(k, value, s):
    t = kinds(s)
    if "string" in t:
        return value
    if "number" in t and re.fullmatch(r"-?\d+", value):
        return int(value)
    if "number" in t:
        try:
            return float(value)
        except ValueError:
            pass
    if "boolean" in t and value in ("true", "false"):
        return value == "true"
    if "null" in t and value == "null":
        return None
    try:
        return json.loads(value)
    except ValueError:
        if "any" in t:
            return value
        fail(f"--{flag[k]} takes {label(s)}, not {value!r}")


def build(k, raws):
    s, t = props[k], kinds(props[k])
    if "array" in t and (len(raws) > 1 or not t - {"array", "null"}):
        out = []
        for raw in raws:
            try:
                parsed = json.loads(raw) if raw.startswith("[") else None
            except ValueError:
                parsed = None
            out += parsed if isinstance(parsed, list) else [convert(k, raw, items(s))]
        return out
    if len(raws) > 1:
        fail(f"--{flag[k]} given more than once")
    return convert(k, raws[0], s)


stdin = None


def read_stdin():
    global stdin
    if stdin is None:
        stdin = "" if sys.stdin.isatty() else sys.stdin.read()
    return stdin


values, positional, as_json, args = {}, [], False, sys.argv[1:]
while args:
    arg = args.pop(0)
    if arg == "--":
        positional += args
        break
    if arg in ("-h", "--help"):
        print(usage())
        sys.exit(0)
    if arg == "--json" and "json" not in props:
        as_json = True
        continue
    if not arg.startswith("--"):
        positional.append(arg)
        continue
    key, eq, value = arg[2:].partition("=")
    negate = key not in by_flag and key.startswith("no-") and key[3:] in by_flag and boolean(props[by_flag[key[3:]]])
    prop = by_flag.get(key[3:] if negate else key)
    if prop is None:
        fail(f"unknown option --{key}; see {name} --help")
    if boolean(props[prop]) and not eq:
        value = "false" if negate else "true"
    elif not eq:
        if not args:
            fail(f"--{key} needs a value")
        value = args.pop(0)
    values.setdefault(prop, []).append(value)
targets = [k for k in order if k not in values]
while positional:
    if not targets:
        fail(f"unexpected argument {positional[0]!r}; see {name} --help")
    k = targets.pop(0)
    if "array" in kinds(props[k]):
        values[k], positional = positional, []
    else:
        values[k] = [positional.pop(0)]
values = {k: [read_stdin() if raw == "-" else raw for raw in raws] for k, raws in values.items()}
for k in required:
    if k not in values and "string" in kinds(props[k]) and stdin is None and read_stdin():
        values[k] = [stdin]
missing = [f"--{flag[k]}" for k in required if k not in values]
if missing:
    fail(f"missing {', '.join(missing)}; see {name} --help")
request = {"tool": spec["tool"], "args": {k: build(k, raws) for k, raws in values.items()}}
try:
    with socket.socket(socket.AF_UNIX) as sock:
        sock.connect(f"{d}/socket")
        sock.sendall(json.dumps(request).encode() + b"\n")
        reply = json.loads(b"".join(iter(lambda: sock.recv(1 << 16), b"")))
except (OSError, ValueError) as error:
    fail(f"lost the eval cell: {error}", 1)
if "error" in reply:
    fail(reply["error"], 1)
result = reply["result"]
if as_json:
    print(json.dumps(result))
else:
    text = result.get("text", "") if isinstance(result, dict) else str(result)
    sys.stdout.write(text if not text or text.endswith("\n") else text + "\n")
