#!/usr/bin/env python3
import pathlib
import struct
import sys
import zlib

root = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else pathlib.Path(__file__).parent
failed = False
paths = sorted(root.glob("*.png"))
if not paths:
    sys.exit(f"No avatar atlases in {root}")
for path in paths:
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        sys.exit(f"{path}: not PNG")
    offset = 8
    compressed = bytearray()
    while offset < len(raw):
        size = struct.unpack_from(">I", raw, offset)[0]
        kind = raw[offset + 4:offset + 8]
        body = raw[offset + 8:offset + 8 + size]
        if kind == b"IHDR":
            width, height, depth, color, compression, filtering, interlace = struct.unpack(">IIBBBBB", body)
            if depth != 8 or color != 6 or compression or filtering or interlace or width % 128 or height % 128:
                sys.exit(f"{path}: expected a noninterlaced 8-bit RGBA atlas of 128px cells")
        elif kind == b"IDAT":
            compressed.extend(body)
        offset += size + 12
    pixels = zlib.decompress(compressed)
    stride = width * 4
    if len(pixels) != height * (stride + 1):
        sys.exit(f"{path}: incorrect decompressed size")
    previous = bytearray(stride)
    touched = set()
    for y in range(height):
        start = y * (stride + 1)
        mode = pixels[start]
        row = bytearray(pixels[start + 1:start + stride + 1])
        for i in range(stride):
            left = row[i - 4] if i >= 4 else 0
            above = previous[i]
            upper_left = previous[i - 4] if i >= 4 else 0
            if mode == 1:
                predict = left
            elif mode == 2:
                predict = above
            elif mode == 3:
                predict = (left + above) // 2
            elif mode == 4:
                p = left + above - upper_left
                distances = (abs(p - left), abs(p - above), abs(p - upper_left))
                predict = (left, above, upper_left)[distances.index(min(distances))]
            elif mode == 0:
                predict = 0
            else:
                sys.exit(f"{path}: unknown PNG filter {mode}")
            row[i] = (row[i] + predict) & 255
        for x in range(width):
            if row[x * 4 + 3] and (x % 128 in (0, 127) or y % 128 in (0, 127)):
                touched.add((x // 128, y // 128))
        previous = row
    failed |= bool(touched)
    print(f"{path.name}: {'FAIL' if touched else 'PASS'}; {len(touched)} cells touch an edge")
sys.exit(1 if failed else 0)
