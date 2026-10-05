#!/usr/bin/env python3
"""Packs ARM9/ARM7 binaries into a homebrew .nds (header with valid CRCs). usage: pack_nds.py a9.bin a7.bin out.nds TITLE"""
import struct, sys

def crc16(d):
    c = 0xFFFF
    for b in d:
        c ^= b
        for _ in range(8):
            c = (c >> 1) ^ 0xA001 if c & 1 else c >> 1
    return c

a9, a7 = open(sys.argv[1], "rb").read(), open(sys.argv[2], "rb").read()
a9_off, a7_off = 0x4000, max(0x8000, 0x4000 + ((len(a9) + 0x1FF) & ~0x1FF))  # 0x4000..0x7FFF is the ARM9 secure area (decrypted in place by the core)
size = 1 << (max(a7_off + len(a7), 0x20000) - 1).bit_length()
rom = bytearray(size)
t = sys.argv[4].encode()[:12]
rom[0:len(t)] = t
rom[0x0C:0x10] = b"DLTT"; rom[0x10:0x12] = b"00"
struct.pack_into("<IIII", rom, 0x20, a9_off, 0x02000008, 0x02000000, len(a9))
struct.pack_into("<IIII", rom, 0x30, a7_off, 0x02380000, 0x02380000, len(a7))
struct.pack_into("<I", rom, 0x80, a7_off + len(a7)); struct.pack_into("<I", rom, 0x84, 0x200)
rom[0x15C:0x15E] = struct.pack("<H", 0xCF56)
rom[0x15E:0x160] = struct.pack("<H", crc16(bytes(rom[:0x15E])))
rom[a9_off:a9_off + len(a9)] = a9
rom[a7_off:a7_off + len(a7)] = a7
open(sys.argv[3], "wb").write(rom)
print("wrote", sys.argv[3], len(rom))
