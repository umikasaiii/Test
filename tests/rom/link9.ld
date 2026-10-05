ENTRY(_start)
SECTIONS { . = 0x02000000; .text : { *(.init) *(.text*) *(.rodata*) } .data : { *(.data*) } .bss : { *(.bss*) *(COMMON) } }
