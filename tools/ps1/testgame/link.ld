ENTRY(_start)
SECTIONS {
  . = 0x80010000;
  .text : { *(.text.start) *(.text*) }
  .rodata : { *(.rodata*) }
  .data : { *(.data*) *(.sdata*) }
  . = ALIGN(4);
  __bss_start = .;
  .bss : { *(.bss*) *(.sbss*) *(COMMON) }
  __bss_end = .;
  /DISCARD/ : { *(.MIPS.abiflags) *(.reginfo) *(.gnu.attributes) *(.pdr) *(.comment) *(.eh_frame) *(.mdebug*) }
}
