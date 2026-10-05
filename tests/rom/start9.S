    .section .init
    .arm
    .word 0xE7FFDEFF            @ "decrypted secure area" marker (keeps the core from asking for native BIOS)
    .word 0xE7FFDEFF
    .global _start
_start:
    ldr sp, =0x023F0000
    bl main
1:  b 1b
