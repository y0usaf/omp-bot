async def _omp_bash(d):
    import asyncio, codecs, json, os, signal, sys
    globals().pop("_omp_bash", None)
    spec = json.load(open(f"{d}/spec.json"))
    with open(f"{d}/shim", "w") as f:
        f.write(f"#!{sys.executable} -IS\n" + open(f"{d}/shim.py").read())
    os.chmod(f"{d}/shim", 0o755)

    async def serve(reader, writer):
        try:
            request = json.loads(await reader.readline())
            if request["tool"] not in spec["tools"]:
                raise RuntimeError(f"{request['tool']} is not a tool of this session")
            reply = {"result": await getattr(tool, request["tool"])(request["args"])}
        except Exception as error:
            reply = {"error": str(error) or type(error).__name__}
        writer.write(json.dumps(reply, default=str).encode() + b"\n")
        await writer.drain()
        writer.close()

    server = await asyncio.start_unix_server(serve, f"{d}/socket", limit=1 << 30)
    proc = await asyncio.create_subprocess_exec("bash", "-o", "pipefail", f"{d}/cell.sh", stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=json.load(open(f"{d}/env.json")), cwd=spec["cwd"], start_new_session=True)
    with open(f"{d}/pid", "w") as f:
        f.write(str(proc.pid))

    async def pump(stream, out):
        decode = codecs.getincrementaldecoder("utf-8")("replace").decode
        while chunk := await stream.read(1 << 16):
            out.write(decode(chunk))
            out.flush()
        out.write(decode(b"", True))

    pumps = asyncio.gather(pump(proc.stdout, sys.stdout), pump(proc.stderr, sys.stderr))
    try:
        return await proc.wait()
    finally:
        server.close()
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        await pumps
