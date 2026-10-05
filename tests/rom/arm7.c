/* DSLink input/audio/wifi test homebrew (ARM7): reads touch + X/Y buttons, plays a tone, and exercises the DS wireless hardware:
 * it powers the Wi-Fi block, selects channel 1, broadcasts an 802.11 data frame every ~200 ms and counts frames received from another
 * console. Everything is published to ARM9 through SHARED[] (see arm9.c). Original code, GPLv3. */
typedef unsigned short u16; typedef unsigned int u32; typedef unsigned char u8;
#define R16(a) (*(volatile u16 *)(a))
#define R32(a) (*(volatile u32 *)(a))
#ifndef TONE_HZ
#define TONE_HZ 440
#endif
#define SHARED ((volatile u32 *)0x023FE000)
#ifndef TEST_ID
#define TEST_ID 1
#endif
/* ---- DS Wi-Fi (registers at 0x04808000, 8 KiB of wifi RAM at 0x04804000) ---- */
#define WR(o) R16(0x04808000 + (o))
#define WRAM16(o) R16(0x04804000 + (o))
#define W_MODE_RST 0x004
#define W_IF 0x010
#define W_MAC 0x018
#define W_BSSID 0x020
#define W_RXCNT 0x030
#define W_POWER_US 0x036
#define W_POWER_STATE 0x03C
#define W_POWER_FORCE 0x040
#define W_RXBUF_BEGIN 0x050
#define W_RXBUF_END 0x052
#define W_RXBUF_WRCSR 0x054
#define W_RXBUF_RDCSR 0x05A
#define W_TXSLOT_LOC1 0x0A0
#define W_TXREQ_SET 0x0AE
#define W_TXBUSY 0x0B6
#define W_RFDATA2 0x17C
#define W_RFDATA1 0x17E
#define TXOFF 0x1000
static u32 rdpos, txseq, rxcount, txcount;

static void wdelay(u32 n) { for (volatile u32 d = 0; d < n; d++) {} }
static void rf_write(u16 id, u16 data) { WR(W_RFDATA1) = (u16)((id << 8) | data); WR(W_RFDATA2) = 5; }

static int wifi_init(void) {
    R16(0x04000304) |= 2;                 /* POWCNT2: wifi on */
    WR(W_POWER_US) = 0;                   /* power the block */
    WR(W_MODE_RST) = 0x6001;              /* reset + defaults (RX buffer 0x4000..0x4800, filters) + enable */
    WR(W_POWER_FORCE) = 0x8000;           /* force the transceiver on */
    for (int i = 0; i < 200000 && (WR(W_POWER_STATE) & 0x200); i++) {}
    if (WR(W_POWER_STATE) & 0x200) return 0;
    for (int i = 0; i < 3; i++) WR(W_MAC + i * 2) = (u16)(i == 2 ? (0x4400 | TEST_ID) : 0x1100 + i * 0x2222);
    for (int i = 0; i < 3; i++) WR(W_BSSID + i * 2) = (u16)(0x02 + i * 0x0101 + 0xAA00);
    WR(W_RXBUF_BEGIN) = 0x4000; WR(W_RXBUF_END) = 0x4800;
    WR(W_RXCNT) = 0x0001;                 /* write cursor := write address (0) */
    WR(W_RXBUF_RDCSR) = 0; rdpos = 0;
    rf_write(0x01, 0x4B); rf_write(0x02, 0x6C);   /* RF registers 1/2 select channel 1 (generated firmware's channel table) */
    WR(W_RXCNT) = 0x8000;                 /* enable the TX/RX engine */
    return 1;
}

static void wifi_tx(void) {
    u16 *f = (u16 *)(0x04804000 + TXOFF);
    for (int i = 0; i < 28; i++) f[i] = 0;
    f[4] = 0x000A;                        /* +8: 1 Mbit/s */
    f[5] = 44;                            /* +0xA: frame length = 24 header + 16 payload + 4 FCS */
    f[6] = 0x0008;                        /* data frame, no ToDS/FromDS */
    f[8] = f[9] = f[10] = 0xFFFF;         /* addr1 = broadcast */
    f[11] = 0x1100; f[12] = 0x3300; f[13] = (u16)(0x4400 | TEST_ID);   /* addr2 = our MAC */
    for (int i = 0; i < 3; i++) f[14 + i] = (u16)(0x02 + i * 0x0101 + 0xAA00);   /* addr3 = BSSID */
    f[18] = 0x4C44; f[19] = 0x4B53;       /* payload: "DLSK" magic, sender id, sequence */
    f[20] = TEST_ID; f[21] = 0; f[22] = (u16)txseq; f[23] = (u16)(txseq >> 16);
    txseq++;
    WR(W_TXSLOT_LOC1) = 0x8000 | (TXOFF >> 1);
    WR(W_TXREQ_SET) = 1;
    for (int i = 0; i < 400000 && (WR(W_TXBUSY) & 1); i++) {}
    txcount++;
}

static void wifi_poll(void) {
    if (!(WR(W_IF) & 1)) return;
    WR(W_IF) = 1;                         /* acknowledge "frame received" */
    u32 base = rdpos + 12 + 24;           /* 12-byte RX header + 802.11 header, then the payload */
    u16 magic0 = WRAM16((base) & 0x7FE), magic1 = WRAM16((base + 2) & 0x7FE), from = WRAM16((base + 4) & 0x7FE);
    if (magic0 == 0x4C44 && magic1 == 0x4B53 && from != TEST_ID) {
        rxcount++;
        SHARED[11] = from;
        SHARED[12] = WRAM16((base + 8) & 0x7FE);
    }
    rdpos = (u32)(WR(W_RXBUF_WRCSR) & 0x7FF) << 1;   /* next frame starts at the write cursor */
    WR(W_RXBUF_RDCSR) = (u16)(rdpos >> 1);
}

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
    SHARED[8] = wifi_init();
    for (;;) {
        if (SHARED[8]) {
            if (!(frame & 0xFF)) wifi_tx();
            wifi_poll();
            SHARED[9] = txcount; SHARED[10] = rxcount;
        }
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
