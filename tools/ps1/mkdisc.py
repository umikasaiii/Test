#!/usr/bin/env python3
"""Builds PlaySphere's redistributable PlayStation test discs from tools/ps1/testgame (own code, no Sony software, no BIOS).

  mkdisc.py --out DIR [--name NAME] [--discs N] [--pal] [--chd]

Writes   NAME.bin + NAME.cue                 single disc (MODE2/2352, raw sectors with EDC/ECC)
         NAME (Disc k).bin/.cue, NAME.m3u    with --discs N (N >= 2): a multi-disc game, every disc carries its own number in DISCID.DAT (LBA 100)
         NAME.chd                            with --chd (needs `chdman`): CHD copy of the single disc
The program on the disc is a PS-X EXE named PSPH_000.01 (serial PSPH00001). The boot is HLE-BIOS friendly (SYSTEM.CNF + executable); it carries no Sony license data.
"""
import argparse, os, shutil, struct, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SERIAL_FILE = "PSPH_000.01"

# ---------------------------------------------------------------- the program
def build_exe(pal: bool) -> bytes:
    src = os.path.join(HERE, "testgame")
    tmp = tempfile.mkdtemp(prefix="psph")
    flags = ["--target=mipsel-none-elf", "-march=mips1", "-msoft-float", "-mno-abicalls", "-fno-pic", "-mno-gpopt", "-ffreestanding", "-fno-builtin", "-fno-stack-protector", "-nostdlib"]
    def tool(n):   # distro packages ship unversioned names or only versioned ones (/usr/lib/llvm-18/bin)
        import glob
        p = shutil.which(n) or next(iter(sorted(glob.glob(f"/usr/lib/llvm-*/bin/{n}"), reverse=True)), None)
        return p or sys.exit(f"{n} is required (apt: clang lld llvm)")
    cc = shutil.which("clang") or sys.exit("clang with the MIPS target is required")
    def run(cmd): subprocess.run(cmd, check=True, stderr=subprocess.DEVNULL if cmd[0] == cc else None)
    run([cc, *flags, "-O2", f"-DPAL={1 if pal else 0}", "-c", f"{src}/main.c", "-o", f"{tmp}/main.o"])
    run([cc, *flags, "-c", f"{src}/crt0.S", "-o", f"{tmp}/crt0.o"])
    run([tool("ld.lld"), "-m", "elf32ltsmip", "-T", f"{src}/link.ld", "-o", f"{tmp}/g.elf", f"{tmp}/crt0.o", f"{tmp}/main.o"])
    run([tool("llvm-objcopy"), "-O", "binary", f"{tmp}/g.elf", f"{tmp}/g.bin"])
    body = open(f"{tmp}/g.bin", "rb").read()
    shutil.rmtree(tmp, ignore_errors=True)
    body += b"\0" * (-len(body) % 2048)
    hdr = bytearray(2048)
    hdr[0:8] = b"PS-X EXE"
    struct.pack_into("<IIIIIIIIII", hdr, 0x10, 0x80010000, 0, 0x80010000, len(body), 0, 0, 0, 0, 0x801FFF00, 0)   # pc gp dest size data.. bss.. sp
    hdr[0x4C:0x4C + 55] = b"Sony Computer Entertainment Inc. for North America area"[:55]
    return bytes(hdr) + body

# ---------------------------------------------------------------- CD-ROM sectors (MODE2 FORM1, raw 2352 bytes)
def _tables():
    edc = []
    for i in range(256):
        v = i
        for _ in range(8): v = (v >> 1) ^ (0xD8018001 if v & 1 else 0)
        edc.append(v)
    f = [0] * 256; b = [0] * 256
    for i in range(256):
        j = (i << 1) ^ (0x11D if i & 0x80 else 0)
        f[i] = j & 255; b[i ^ (j & 255)] = i
    return edc, f, b
EDC, ECC_F, ECC_B = _tables()

def edc_calc(data: bytes) -> int:
    v = 0
    for x in data: v = (v >> 8) ^ EDC[(v ^ x) & 255]
    return v

def ecc_gen(sector: bytearray, major_count, minor_count, major_mult, minor_inc, dest):
    size = major_count * minor_count
    for major in range(major_count):
        index = (major >> 1) * major_mult + (major & 1)
        a = 0; bb = 0
        for _ in range(minor_count):
            t = sector[12 + index]
            index += minor_inc
            if index >= size: index -= size
            a ^= t; bb ^= t
            a = ECC_F[a]
        a = ECC_B[ECC_F[a] ^ bb]
        sector[dest + major] = a
        sector[dest + major + major_count] = a ^ bb

def bcd(n): return ((n // 10) << 4) | (n % 10)

def sector_m2f1(lba: int, data: bytes) -> bytes:
    s = bytearray(2352)
    s[0] = 0; s[1:11] = b"\xff" * 10; s[11] = 0
    a = lba + 150
    s[12] = bcd(a // 4500); s[13] = bcd((a // 75) % 60); s[14] = bcd(a % 75); s[15] = 2
    s[16:24] = bytes([0, 0, 8, 0, 0, 0, 8, 0])
    s[24:24 + len(data)] = data
    struct.pack_into("<I", s, 2072, edc_calc(bytes(s[16:2072])))
    addr = bytes(s[12:16]); s[12:16] = b"\0\0\0\0"                    # the address is not part of the ECC of a form 1 sector
    ecc_gen(s, 86, 24, 2, 86, 2076)
    ecc_gen(s, 52, 43, 86, 88, 2076 + 172)
    s[12:16] = addr
    return bytes(s)

# ---------------------------------------------------------------- ISO 9660
def both32(v): return struct.pack("<I", v) + struct.pack(">I", v)
def both16(v): return struct.pack("<H", v) + struct.pack(">H", v)
def dirrec(name: bytes, lba: int, size: int, flags: int) -> bytes:
    n = len(name); l = 33 + n + (0 if n % 2 else 1)
    return bytes([l, 0]) + both32(lba) + both32(size) + bytes([126, 1, 1, 0, 0, 0, 0]) + bytes([flags, 0, 0]) + both16(1) + bytes([n]) + name + (b"" if n % 2 else b"\0")
def pad(b, n, ch=b" "): return (b + ch * n)[:n]

def build_disc(exe: bytes, disc_no: int, total: int, label: str) -> bytes:
    system_cnf = b"BOOT = cdrom:\\" + SERIAL_FILE.encode() + b";1\r\nTCB = 4\r\nEVENT = 10\r\nSTACK = 801FFF00\r\n"
    discid = bytes([disc_no, 0xA5, total, 0]) + bytes((i * 3 + disc_no) & 255 for i in range(2044))
    files = {  # name -> (lba, bytes); fixed positions keep the layout stable across builds
        "SYSTEM.CNF;1": (22, system_cnf),
        SERIAL_FILE + ";1": (24, exe),
        "DISCID.DAT;1": (100, discid),
    }
    nsec = 128
    img = [bytes(2048) for _ in range(nsec)]
    # primary volume descriptor
    pvd = bytearray(2048)
    pvd[0] = 1; pvd[1:6] = b"CD001"; pvd[6] = 1
    pvd[8:40] = pad(b"PLAYSTATION", 32); pvd[40:72] = pad(label.upper().encode(), 32)
    pvd[80:88] = both32(nsec); pvd[120:124] = both16(1); pvd[124:128] = both16(1); pvd[128:132] = both16(2048)
    pvd[132:140] = both32(10)
    pvd[140:144] = struct.pack("<I", 18); pvd[144:148] = struct.pack("<I", 0); pvd[148:152] = struct.pack(">I", 19); pvd[152:156] = struct.pack(">I", 0)
    pvd[156:190] = dirrec(b"\0", 20, 2048, 2)
    for off, ln in ((190, 128), (318, 128), (446, 128), (574, 128)): pvd[off:off + ln] = b" " * ln
    for off in (702, 739, 776): pvd[off:off + 37] = b" " * 37
    for off in (813, 830): pvd[off:off + 17] = b"20260101000000\0\0\0"[:17]
    pvd[847:864] = b"0000000000000000\0"; pvd[864:881] = b"0000000000000000\0"
    pvd[881] = 1
    img[16] = bytes(pvd)
    term = bytearray(2048); term[0] = 255; term[1:6] = b"CD001"; term[6] = 1; img[17] = bytes(term)
    ptab = bytes([1, 0]) + struct.pack("<I", 20) + struct.pack("<H", 1) + b"\0\0"
    img[18] = pad(ptab, 2048, b"\0")
    img[19] = pad(bytes([1, 0]) + struct.pack(">I", 20) + struct.pack(">H", 1) + b"\0\0", 2048, b"\0")
    root = dirrec(b"\0", 20, 2048, 2) + dirrec(b"\1", 20, 2048, 2)
    for name in sorted(files): lba, data = files[name]; root += dirrec(name.encode(), lba, len(data), 0)
    img[20] = pad(root, 2048, b"\0")
    for name, (lba, data) in files.items():
        for i in range(0, len(data), 2048):
            blk = data[i:i + 2048]; img[lba + i // 2048] = pad(blk, 2048, b"\0")
    return b"".join(sector_m2f1(i, s) for i, s in enumerate(img))

def cue_text(binname: str) -> str:
    return f'FILE "{binname}" BINARY\r\n  TRACK 01 MODE2/2352\r\n    INDEX 01 00:00:00\r\n'

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True); ap.add_argument("--name", default="PlaySphere Test"); ap.add_argument("--discs", type=int, default=1)
    ap.add_argument("--pal", action="store_true"); ap.add_argument("--chd", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    exe = build_exe(a.pal)
    label = "PLAYSPHERE_TEST"
    if a.discs <= 1:
        bn = f"{a.name}.bin"; open(os.path.join(a.out, bn), "wb").write(build_disc(exe, 1, 1, label)); open(os.path.join(a.out, f"{a.name}.cue"), "w", newline="").write(cue_text(bn))
        if a.chd:
            chdman = shutil.which("chdman") or sys.exit("chdman (mame-tools) is required for --chd")
            out = os.path.join(a.out, f"{a.name}.chd")
            if os.path.exists(out): os.remove(out)
            subprocess.run([chdman, "createcd", "-i", os.path.join(a.out, f"{a.name}.cue"), "-o", out], check=True, stdout=subprocess.DEVNULL)
    else:
        lines = []
        for k in range(1, a.discs + 1):
            bn = f"{a.name} (Disc {k}).bin"; cn = f"{a.name} (Disc {k}).cue"
            open(os.path.join(a.out, bn), "wb").write(build_disc(exe, k, a.discs, label)); open(os.path.join(a.out, cn), "w", newline="").write(cue_text(bn)); lines.append(cn)
        open(os.path.join(a.out, f"{a.name}.m3u"), "w", newline="").write("\r\n".join(lines) + "\r\n")
    print("ok", a.out)

if __name__ == "__main__":
    main()
