ENTRY(_start)
SECTIONS { . = 0x02380000; .text : { *(.init) *(.text*) *(.rodata*) } .data : { *(.data*) } .bss : { *(.bss*) *(COMMON) } }
