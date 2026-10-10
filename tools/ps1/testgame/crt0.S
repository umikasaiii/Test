    .set noreorder
    .section .text.start, "ax"
    .globl _start
_start:
    lui   $sp, 0x801F
    ori   $sp, $sp, 0xFF00
    jal   main
    nop
1:  b     1b
    nop
