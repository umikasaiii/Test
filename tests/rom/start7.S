    .section .init
    .arm
    .global _start
_start:
    ldr sp, =0x0380FF00
    bl main
1:  b 1b
