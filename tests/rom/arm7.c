/* DSLink input/audio test homebrew (ARM7): reads touch + X/Y buttons, publishes them to ARM9, plays a tone. */
typedef unsigned short u16; typedef unsigned int u32; typedef unsigned char u8;
#define R16(a) (*(volatile u16 *)(a))
#define R32(a) (*(volatile u32 *)(a))
#ifndef TONE_HZ
#define TONE_HZ 440
#endif
#define SHARED ((volatile u32 *)0x023FE000)

static u16 tsc(u8 cmd) {
    while (R16(0x040001C0) & 0x80) {}
    R16(0x040001C0) = 0x8000 | 1 | (2 << 8) | 0x800; /* enable, 2 MHz, touch device, hold CS */
    R16(0x040001C2) = cmd;
    while (R16(0x040001C0) & 0x80) {}
    R16(0x040001C2) = 0;
    while (R16(0x040001C0) & 0x80) {}
    u16 hi = R16(0x040001C2);
    R16(0x040001C0) = 0x8000 | 1 | (2 << 8);
    R16(0x040001C2) = 0;
    while (R16(0x040001C0) & 0x80) {}
    u16 lo = R16(0x040001C2);
    return (u16)(((hi & 0x7F) << 5) | (lo >> 3));
}

int main(void) {
    R16(0x04000304) = 1;
    R16(0x04000500) = 0x8000 | 127;      /* SOUNDCNT: master enable, volume */
    /* channel 8 = PSG/square: enable | volume 100 | duty 50 % | PSG format | centre pan */
    R32(0x04000480) = (1u << 31) | (3u << 29) | (3u << 24) | (64u << 16) | 100;
    R16(0x04000488) = (u16)(0x10000 - (16777216u / (TONE_HZ * 8u)));
    u32 frame = 0;
    for (;;) {
        u16 ext = R16(0x04000136);       /* bit0 X, bit1 Y, bit6 pen (active low) */
        SHARED[4] = !(ext & 1);
        SHARED[5] = !(ext & 2);
        if (!(ext & 0x40)) {
            SHARED[1] = tsc(0xD1);
            SHARED[2] = tsc(0x91);
            SHARED[3] = 1;
        } else {
            SHARED[3] = 0;
        }
        SHARED[6] = ++frame >> 4;
        for (volatile int d = 0; d < 4000; d++) {}
    }
}
