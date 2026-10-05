#!/usr/bin/env python3
"""Validates user-provided private files WITHOUT modifying them and WITHOUT printing their contents.
usage: validate_private.py <dir-with-ROM-bios7-bios9-firmware> [--boot-test <dslink-runtime> <core.so> <outdir>]
Prints sizes, SHA-256, header facts and pass/fail flags only (title/gamecode are metadata, not content)."""
import hashlib, os, struct, subprocess, sys, tempfile, shutil, time

def crc16(b, init=0xFFFF):
    c = init
    for x in b:
        c ^= x
        for _ in range(8):
            c = (c >> 1) ^ 0xA001 if c & 1 else c >> 1
    return c

def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for ch in iter(lambda: f.read(1 << 20), b""): h.update(ch)
    return h.hexdigest()

ok_all = True
def check(name, ok, detail=""):
    global ok_all
    ok_all &= bool(ok)
    print(("PASS  " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail else ""))

def find(d, pred):
    return [os.path.join(d, f) for f in sorted(os.listdir(d)) if pred(f.lower())]

d = sys.argv[1]
roms = find(d, lambda f: f.endswith(".nds"))
check("exactly one .nds ROM present", len(roms) == 1, str(len(roms)))
if roms:
    p = roms[0]; sz = os.path.getsize(p)
    with open(p, "rb") as f: h = f.read(0x200)
    check("ROM header readable (>= 0x200 bytes)", len(h) == 0x200)
    title = h[0:12].rstrip(b"\0").decode("ascii", "replace")
    code = h[12:16].decode("ascii", "replace")
    a9o, a9sz = struct.unpack_from("<II", h, 0x20)[0], struct.unpack_from("<I", h, 0x2C)[0]
    a7o, a7sz = struct.unpack_from("<I", h, 0x30)[0], struct.unpack_from("<I", h, 0x3C)[0]
    total = struct.unpack_from("<I", h, 0x80)[0]
    unit = h[0x12]
    print(f"      title={title!r} gamecode={code} unitcode={unit:#04x} size={sz} sha256={sha(p)}")
    check("header CRC-16 (0x000-0x15D) matches 0x15E", crc16(h[:0x15E], 0xFFFF) == struct.unpack_from("<H", h, 0x15E)[0] or crc16(h[:0x15E], 0xFFFF) == struct.unpack_from("<H", h, 0x15E)[0])
    check("Nintendo logo CRC-16 field is 0xCF56 and the logo data matches it", struct.unpack_from("<H", h, 0x15C)[0] == 0xCF56 and crc16(h[0xC0:0x15C], 0xFFFF) == 0xCF56)
    check("ARM9/ARM7 binaries lie inside the file", a9o + a9sz <= sz and a7o + a7sz <= sz and a9sz > 0 and a7sz > 0, f"arm9 {a9o:#x}+{a9sz:#x} arm7 {a7o:#x}+{a7sz:#x}")
    check("declared ROM size <= file size", total <= sz, f"{total} / {sz}")
    check("NDS (not DSi-only) unit code", unit in (0x00, 0x02), f"{unit:#04x}")
bios7 = os.path.join(d, "bios7.bin"); bios9 = os.path.join(d, "bios9.bin"); fw = os.path.join(d, "firmware.bin")
for path, size, name in ((bios7, 16384, "bios7.bin"), (bios9, 4096, "bios9.bin")):
    check(f"{name} exists with the exact size {size}", os.path.exists(path) and os.path.getsize(path) == size, str(os.path.getsize(path)) if os.path.exists(path) else "missing")
    if os.path.exists(path):
        b = open(path, "rb").read(4)
        print(f"      {name} sha256={sha(path)}")
        check(f"{name} starts with an ARM instruction (condition AL)", b[3] in (0xEA, 0xE5, 0xEB, 0xE1, 0xE3), f"{b[3]:#04x}")
check("firmware.bin exists", os.path.exists(fw))
if os.path.exists(fw):
    data = open(fw, "rb").read(); n = len(data)
    print(f"      firmware.bin size={n} sha256={sha(fw)}")
    check("firmware size is 128/256/512 KiB", n in (131072, 262144, 524288))
    ctype = data[0x1D]
    names = {0xFF: "DS (phat)", 0x20: "DS Lite", 0x57: "iQue DS", 0x43: "iQue DS Lite", 0x63: "DSi"}
    print(f"      console type byte {ctype:#04x} = {names.get(ctype, 'unknown')}")
    check("console type is a DS/DS Lite firmware (not DSi)", ctype in (0xFF, 0x20, 0x57, 0x43), names.get(ctype, "unknown"))
    wl = struct.unpack_from("<H", data, 0x2C)[0]; wcrc = struct.unpack_from("<H", data, 0x2A)[0]
    check("Wi-Fi calibration block CRC-16 is valid", crc16(data[0x2C:0x2C + wl], 0) == wcrc, f"len={wl:#x}")
    check("RF chip type is 2 or 3", data[0x40] in (2, 3), str(data[0x40]))
    ud = [n - 0x200, n - 0x100]
    valid = [o for o in ud if crc16(data[o:o + 0x70], 0xFFFF) == struct.unpack_from("<H", data, o + 0x72)[0]]
    check("at least one user-settings block has a valid CRC-16", len(valid) >= 1, f"{len(valid)}/2")
    blank = lambda b: all(x == 0xFF for x in b) or all(x == 0 for x in b)
    check("boot code regions are present (ARM9/ARM7 GUI code blocks not blank)", not blank(data[0x100:0x200]) and not blank(data[0x200:0x1000]))

if len(sys.argv) > 2 and sys.argv[2] == "--boot-test":
    rt, core, out = sys.argv[3:6]
    os.makedirs(out, exist_ok=True)
    tmp = tempfile.mkdtemp(prefix="vp_")                     # COPIES: the originals are never touched
    w = os.path.join(tmp, "w"); sysd = os.path.join(w, "system", "melonDS DS"); os.makedirs(sysd)
    for f in ("bios7.bin", "bios9.bin", "firmware.bin"): shutil.copy(os.path.join(d, f), sysd)
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "runtime"))
    from rtlib import Runtime
    r = Runtime(rt, core, "", w, name="BOOT")
    time.sleep(20)
    im = r.snapshot("firmware_boot.ppm")
    snap = os.path.join(out, "firmware_boot.ppm"); shutil.copy(os.path.join(w, "firmware_boot.ppm"), snap)
    text = r.log()
    bad = [l for l in text.splitlines() if "can't be used to boot" in l or "firmware" in l.lower() and "ERROR" in l]
    check("core accepted the firmware (no firmware ERROR / 'can't be used to boot' line)", not bad, f"{len(bad)} lines")
    colors = len({im.px(x, y) for x in range(0, 256, 8) for y in range(0, 384, 8)})
    check("the framebuffer shows a real UI (many distinct colours: DS menu / setup screen)", colors > 6, f"{colors} distinct sampled colours")
    check("emulation running at ~60 fps", r.status.get("fps", 0) > 50, str(r.status.get("fps")))
    r.stop(); shutil.rmtree(tmp, ignore_errors=True)
    print(f"      snapshot written to {snap} (inspect it locally; never commit it)")
print("VALIDATION " + ("OK" if ok_all else "FAILED"))
sys.exit(0 if ok_all else 1)
