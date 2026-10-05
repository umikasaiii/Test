#!/usr/bin/env python3
"""Generates a tiny SYNTHETIC homebrew .nds (an ARM9/ARM7 infinite loop) used only to smoke-test the emulator
plumbing. It contains no Nintendo code or data. Usage: make_test_rom.py out.nds"""
import struct
import sys


def crc16(data: bytes) -> int:
    crc = 0xFFFF
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0xA001 if crc & 1 else crc >> 1
    return crc


def build() -> bytes:
    size = 0x20000
    rom = bytearray(size)
    rom[0x00:0x0C] = b"DSLINKTEST\0\0"
    rom[0x0C:0x10] = b"DLTT"
    rom[0x10:0x12] = b"00"
    rom[0x12] = 0  # unit code: NDS
    struct.pack_into("<IIII", rom, 0x20, 0x4000, 0x02000008, 0x02000000, 0x4800)  # ARM9 offset/entry/ram/size
    struct.pack_into("<IIII", rom, 0x30, 0x8000, 0x02380000, 0x02380000, 0x200)  # ARM7 offset/entry/ram/size
    struct.pack_into("<I", rom, 0x80, size)  # used ROM size
    struct.pack_into("<I", rom, 0x84, 0x200)  # header size
    rom[0x15C:0x15E] = struct.pack("<H", 0xCF56)
    rom[0x15E:0x160] = struct.pack("<H", crc16(bytes(rom[:0x15E])))
    loop = struct.pack("<I", 0xEAFFFFFE) * 0x80  # b .  (fills 0x200 bytes)
    # ARM9 starts with the "decrypted secure area" marker so the core does not ask for native BIOS files.
    rom[0x4000:0x4008] = struct.pack("<II", 0xE7FFDEFF, 0xE7FFDEFF)
    rom[0x4008:0x4008 + len(loop)] = loop
    rom[0x8000:0x8000 + len(loop)] = loop
    return bytes(rom)


if __name__ == "__main__":
    open(sys.argv[1], "wb").write(build())
