/* DSLink input/video test homebrew (ARM9). Original code, redistributable (GPLv3).
 * Top screen (main engine, direct VRAM mode): 12 squares light up for A B X Y L R Start Select and the D-pad,
 * a crosshair follows the touch position reported by the ARM7, and the background colour encodes TEST_ID. */
typedef unsigned short u16; typedef unsigned int u32; typedef unsigned char u8;
#define R16(a) (*(volatile u16 *)(a))
#define R32(a) (*(volatile u32 *)(a))
#define R8(a)  (*(volatile u8 *)(a))
#ifndef TEST_ID
#define TEST_ID 1
#endif
#define SHARED ((volatile u32 *)0x023FE000) /* ARM7 -> ARM9: [0]=magic [1]=x raw [2]=y raw [3]=pen [4]=X btn [5]=Y btn [6]=frame */
#define VRAM ((volatile u16 *)0x06800000)
static u16 FB[256 * 192]; /* back buffer in main RAM, copied during vblank (no tearing in captures) */
#define RGB(r,g,b) ((u16)((r) | ((g) << 5) | ((b) << 10) | 0x8000))

static void rect(int x, int y, int w, int h, u16 c) {
    for (int j = 0; j < h; j++) for (int i = 0; i < w; i++) {
        int px = x + i, py = y + j;
        if (px >= 0 && px < 256 && py >= 0 && py < 192) FB[py * 256 + px] = c;
    }
}

int main(void) {
    R32(0x04000304) = 0x8003;          /* POWCNT1: LCDs on, engine A on, A -> top screen */
    R8(0x04000240) = 0x80;             /* VRAMCNT_A: enable, LCDC mapping at 0x06800000 */
    R32(0x04000000) = 0x00020000;      /* DISPCNT: display mode 2 (VRAM direct) */
    u16 bg = TEST_ID == 1 ? RGB(2, 2, 12) : RGB(12, 2, 2);
    for (;;) {
        for (int i = 0; i < 256 * 192; i++) FB[i] = bg;
        u16 keys = ~R16(0x04000130);
        u32 xbtn = SHARED[4], ybtn = SHARED[5];
        struct { int x, y, on; u16 c; } b[12] = {
            {200, 60, keys & 1, RGB(31, 8, 8)},        /* A */
            {176, 84, keys & 2, RGB(31, 24, 4)},       /* B */
            {176, 36, xbtn, RGB(8, 31, 8)},            /* X */
            {152, 60, ybtn, RGB(8, 20, 31)},           /* Y */
            {8, 12, keys & 0x200, RGB(31, 31, 31)},    /* L */
            {208, 12, keys & 0x100, RGB(31, 31, 31)},  /* R */
            {140, 150, keys & 8, RGB(31, 31, 8)},      /* Start */
            {100, 150, keys & 4, RGB(8, 31, 31)},      /* Select */
            {40, 36, keys & 0x40, RGB(31, 8, 31)},     /* Up */
            {40, 84, keys & 0x80, RGB(31, 8, 31)},     /* Down */
            {16, 60, keys & 0x20, RGB(31, 8, 31)},     /* Left */
            {64, 60, keys & 0x10, RGB(31, 8, 31)},     /* Right */
        };
        for (int i = 0; i < 12; i++) {
            rect(b[i].x, b[i].y, 28, 28, RGB(6, 6, 6));
            if (b[i].on) rect(b[i].x + 3, b[i].y + 3, 22, 22, b[i].c);
        }
        if (SHARED[3]) { /* pen down: crosshair at the touched position (raw 12-bit -> screen px, approximate) */
            int px = (int)(SHARED[1] >> 4), py = (int)((SHARED[2] * 192) >> 12);
            rect(px - 10, py, 21, 1, RGB(31, 31, 31));
            rect(px, py - 10, 1, 21, RGB(31, 31, 31));
        }
        rect(0, 188, (SHARED[6] & 63) * 4, 4, RGB(8, 31, 8)); /* ARM7 heartbeat bar */
        while (R16(0x04000006) < 192) {}   /* wait for vblank */
        for (int i = 0; i < 256 * 192; i++) VRAM[i] = FB[i];
        while (R16(0x04000006) >= 192) {}
    }
}
