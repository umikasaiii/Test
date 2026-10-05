#!/usr/bin/env python3
"""Fails if the repository tracks (or, with --staged, is about to commit) anything that looks like a ROM, BIOS or firmware:
banned names/extensions, exact BIOS/firmware sizes with those names, or any file whose first 0x200 bytes form a valid NDS header."""
import os, struct, subprocess, sys

BAN_EXT = (".nds", ".srl", ".dsi", ".gba", ".chd", ".cue", ".srm", ".sav", ".dsv", ".ppm")
BAN_NAME = ("bios7.bin", "bios9.bin", "firmware.bin", "bios.bin", "scph")
def crc16(b):
    c = 0xFFFF
    for x in b:
        c ^= x
        for _ in range(8): c = (c >> 1) ^ 0xA001 if c & 1 else c >> 1
    return c

staged = "--staged" in sys.argv
cmd = ["git", "diff", "--cached", "--name-only", "--diff-filter=AM"] if staged else ["git", "ls-files"]
files = subprocess.check_output(cmd, text=True).split("\\n" if False else "\n")
bad = []
for f in filter(None, files):
    low = os.path.basename(f).lower()
    if low.endswith(BAN_EXT) or any(low.startswith(n) for n in BAN_NAME) or f.startswith("private/") or "/private/" in f:
        bad.append((f, "banned name/extension")); continue
    try:
        if os.path.getsize(f) >= 0x200:
            with open(f, "rb") as fh: h = fh.read(0x200)
            if struct.unpack_from("<H", h, 0x15C)[0] == 0xCF56 and crc16(h[:0x15E]) == struct.unpack_from("<H", h, 0x15E)[0]:
                bad.append((f, "contains a valid Nintendo DS ROM header"))
    except OSError:
        pass
for f, why in bad: print(f"PRIVATE-CONTENT GUARD: {f}: {why}")
print("guard: clean" if not bad else f"guard: {len(bad)} problem(s)")
sys.exit(1 if bad else 0)
