// PlaySphere PS1 test program. Own code (same licence as the repository), redistributable: it is what the CI boots, never a commercial game.
// It exercises, directly on the console hardware registers, everything PlaySphere has to provide and paints what it sees so a test can read it back from the picture:
//   video    GPU fills and rectangles, 320x240, NTSC or PAL (-DPAL=1)
//   input    pad buffers from the BIOS (digital 0x41 / analog 0x73): 16 button squares, pad type square, four analog bars (LX LY RX RY)
//   audio    SPU voice 0 plays a looping ADPCM square wave (about 1.6 kHz) at full level
//   memcard  memory card 1 frame 64 holds "PSPH" + a counter; every boot increments it, writes it back and reads it again (counter squares + status square)
//   disc     CD-ROM controller reads the sector at LBA 100 (DISCID.DAT): the first byte is the disc number (multi-disc / disc swap); R3 reads it again
// Layout of the picture (x, y, size) is fixed: tests/ps1_layout.mjs documents it.
typedef unsigned int u32; typedef unsigned short u16; typedef unsigned char u8;
#define R32(a) (*(volatile u32*)(a))
#define R16(a) (*(volatile u16*)(a))
#define R8(a) (*(volatile u8*)(a))

// BIOS entry points: the function number goes to $t1 in the delay slot, arguments stay in $a0..$a3 and the BIOS returns straight to the caller
#define BIOS_FN(name, tbl, num) __asm__(".set noreorder\n.globl " #name "\n" #name ":\n li $10," #tbl "\n jr $10\n li $9," #num "\n.set reorder\n");
BIOS_FN(InitPAD, 0xB0, 0x12)
BIOS_FN(StartPAD, 0xB0, 0x13)
BIOS_FN(OpenEvent, 0xB0, 0x08)
BIOS_FN(EnableEvent, 0xB0, 0x0C)
BIOS_FN(TestEvent, 0xB0, 0x0B)
void InitPAD(void* buf1, int len1, void* buf2, int len2);
int StartPAD(void);
int OpenEvent(u32 cls, u32 spec, u32 mode, void* fn);
int EnableEvent(int ev);
int TestEvent(int ev);

#define GP0 R32(0x1F801810)
#define GP1 R32(0x1F801814)
#define ISTAT R32(0x1F801070)
static void gpu_ready(void) { int t = 1000000; while (!(GP1 & 0x04000000) && --t) {} }
static void gp0(u32 v) { gpu_ready(); GP0 = v; }
static void gp1(u32 v) { GP1 = v; }
#define RGB(r, g, b) (((u32)(b) << 16) | ((u32)(g) << 8) | (u32)(r))
static void rect(int x, int y, int w, int h, u32 col) { gp0(0x60000000 | col); gp0(((u32)y << 16) | (u32)(x & 0xFFFF)); gp0(((u32)h << 16) | (u32)w); }
static void fill(u32 col) { gp0(0x02000000 | col); gp0(0); gp0((240u << 16) | 320u); }

static void gpu_init(void) {
    gp1(0x00000000);                      // reset
    gp1(0x01000000);                      // reset command buffer
    gp1(0x05000000);                      // display area start (0,0)
    gp1(0x06C60260);                      // horizontal range
#if PAL
    gp1(0x07048C23); gp1(0x08000009);     // vertical range, 320x240 PAL
#else
    gp1(0x07040010); gp1(0x08000001);     // vertical range, 320x240 NTSC
#endif
    gp1(0x03000000);                      // display on
    gp0(0xE1000400); gp0(0xE3000000); gp0(0xE403BD3F); gp0(0xE5000000);
}

// ---- SPU: one looping ADPCM block, a 28 sample square wave, voice 0 at 44.1 kHz
#define SPU(o) R16(0x1F801C00 + (o))
static void spu_init(void) {
    SPU(0x1AA) = 0x0000; for (volatile int i = 0; i < 2000; i++) {}
    SPU(0x180) = 0x3FFF; SPU(0x182) = 0x3FFF;            // main volume
    SPU(0x1A6) = 0x1000 >> 3;                            // transfer address (8 byte units): SPU RAM 0x1000
    SPU(0x1AC) = 0x0004;                                 // normal increment
    SPU(0x1AA) = 0x8010;                                 // enable, manual write
    static const u16 blk[8] = { 0x0700, 0x7777, 0x7777, 0x7777, 0x9999, 0x9999, 0x9999, 0x9999 };   // shift 0 filter 0, flags loop start+repeat+end, +7 x14 then -7 x14
    for (int i = 0; i < 8; i++) SPU(0x1A8) = blk[i];
    for (volatile int i = 0; i < 2000; i++) {}
    SPU(0x1AA) = 0xC000;                                 // enable, unmute, normal operation
    SPU(0x000) = 0x3FFF; SPU(0x002) = 0x3FFF;            // voice 0 volume
    SPU(0x004) = 0x1000;                                 // pitch: 44.1 kHz
    SPU(0x006) = 0x1000 >> 3;                            // start address
    SPU(0x008) = 0x80FF; SPU(0x00A) = 0x1FC0;            // ADSR: instant attack, full sustain
    SPU(0x188) = 0x0001;                                 // key on voice 0
}

// ---- memory card on SIO0 (port 1)
#define SIO_DATA R8(0x1F801040)
#define SIO_STAT R16(0x1F801044)
#define SIO_MODE R16(0x1F801048)
#define SIO_CTRL R16(0x1F80104A)
#define SIO_BAUD R16(0x1F80104E)
static void sio_begin(void) { SIO_CTRL = 0x0040; SIO_MODE = 0x000D; SIO_BAUD = 0x0088; SIO_CTRL = 0x0003; }
static void sio_end(void) { SIO_CTRL = 0x0000; }
static u8 sio_x(u8 v) {
    SIO_DATA = v;
    int t = 200000; while (!(SIO_STAT & 2) && --t) {}
    u8 r = SIO_DATA;
    for (volatile int i = 0; i < 40; i++) {}
    return r;
}
static int mc_read(int frame, u8* out) {
    u8 r, chk;
    sio_begin(); sio_x(0x81);
    sio_x(0x52); r = sio_x(0); if (r != 0x5A) { sio_end(); return 0; }
    r = sio_x(0); if (r != 0x5D) { sio_end(); return 0; }
    sio_x(frame >> 8); sio_x(frame & 255);
    r = sio_x(0); if (r != 0x5C) { sio_end(); return 0; }
    r = sio_x(0); if (r != 0x5D) { sio_end(); return 0; }
    sio_x(0); sio_x(0);
    chk = (u8)((frame >> 8) ^ (frame & 255));
    for (int i = 0; i < 128; i++) { out[i] = sio_x(0); chk ^= out[i]; }
    u8 got = sio_x(0); r = sio_x(0); sio_end();
    return got == chk && r == 0x47;
}
static int mc_write(int frame, const u8* in) {
    u8 chk = (u8)((frame >> 8) ^ (frame & 255));
    sio_begin(); sio_x(0x81);
    sio_x(0x57); sio_x(0); sio_x(0);
    sio_x(frame >> 8); sio_x(frame & 255);
    for (int i = 0; i < 128; i++) { sio_x(in[i]); chk ^= in[i]; }
    sio_x(chk); sio_x(0); sio_x(0);
    u8 r = sio_x(0); sio_end();
    return r == 0x47;
}

// ---- CD-ROM controller: read one 2048 byte sector
#define CD0 R8(0x1F801800)
#define CD1 R8(0x1F801801)
#define CD2 R8(0x1F801802)
#define CD3 R8(0x1F801803)
static int cd_wait(void) { for (int t = 0; t < 3000000; t++) { CD0 = 1; u8 f = CD3 & 7; if (f) return f; } return 0; }
static void cd_ack(void) { CD0 = 1; CD3 = 0x1F; }
static void cd_flush_resp(void) { CD0 = 1; for (int i = 0; i < 16 && (R8(0x1F801800) & 0x20); i++) (void)CD1; }
static void cd_cmd(u8 cmd, const u8* p, int n) { CD0 = 0; for (int i = 0; i < n; i++) CD2 = p[i]; CD1 = cmd; }
static u8 bcd(int v) { return (u8)(((v / 10) << 4) | (v % 10)); }
static int cd_sector(int lba, u8* out) {          // LBA relative to the start of the data track (MSF 00:02:00 is LBA 0)
    int f, got = 0;
    CD0 = 1; CD2 = 0x1F; cd_ack();
    cd_cmd(0x0A, 0, 0);                           // Init
    f = cd_wait(); cd_ack(); cd_flush_resp(); if (f == 3) { f = cd_wait(); cd_ack(); cd_flush_resp(); }
    u8 mode = 0x00; cd_cmd(0x0E, &mode, 1);       // Setmode: 2048 byte sectors
    f = cd_wait(); cd_ack(); cd_flush_resp();
    int a = lba + 150; u8 loc[3] = { bcd(a / 4500), bcd((a / 75) % 60), bcd(a % 75) };
    cd_cmd(0x02, loc, 3);                         // Setloc
    f = cd_wait(); cd_ack(); cd_flush_resp();
    cd_cmd(0x06, 0, 0);                           // ReadN
    for (int tries = 0; tries < 6; tries++) {
        f = cd_wait(); if (!f) break;
        if (f == 1) {                              // a sector is ready
            CD0 = 0; CD3 = 0x80;                   // want data
            for (int i = 0; i < 2048; i++) { CD0 = 0; out[i] = CD2; }
            got = 1; cd_ack(); cd_flush_resp(); break;
        }
        cd_ack(); cd_flush_resp();
        if (f == 5) break;
    }
    cd_cmd(0x09, 0, 0);                           // Pause
    for (int i = 0; i < 3; i++) { f = cd_wait(); if (!f) break; cd_ack(); cd_flush_resp(); }
    return got;
}

static u8 pad0[34], pad1[34];
static void stage(int i) { rect(8 + i * 12, 226, 8, 8, RGB(0, 255, 120)); }          // boot progress squares (y 226): GPU, SPU, memory card, disc, pad, loop
static u8 sector[2048], card[128], card2[128];
static int mc_status, mc_counter, disc_ok, disc_num, disc_mark;

static void read_disc(void) {
    disc_ok = cd_sector(100, sector);
    disc_num = disc_ok ? sector[0] : 0; disc_mark = disc_ok ? sector[1] : 0;
}

void main(void) {
    gpu_init(); fill(RGB(32, 32, 64)); stage(0);
    spu_init(); stage(1);
    // memory card: count boots
    mc_status = 0; mc_counter = 0;
    if (mc_read(64, card) && card[0] == 'P' && card[1] == 'S' && card[2] == 'P' && card[3] == 'H') mc_counter = card[4];
    mc_counter = (mc_counter + 1) & 255;
    for (int i = 0; i < 128; i++) card[i] = (u8)(i * 7 + mc_counter);
    card[0] = 'P'; card[1] = 'S'; card[2] = 'P'; card[3] = 'H'; card[4] = (u8)mc_counter;
    if (mc_write(64, card)) { mc_status = 1; if (mc_read(64, card2)) { mc_status = 2; int same = 1; for (int i = 0; i < 128; i++) if (card[i] != card2[i]) same = 0; if (same) mc_status = 3; } }
    stage(2);
    read_disc(); stage(3);
    InitPAD(pad0, 34, pad1, 34);
    StartPAD();                                   // the BIOS pad driver polls the pads at every vblank and acknowledges that interrupt itself
    stage(4);
    unsigned frame = 0; int r3_was = 0, l3_was = 0, narrow = 0;
    int vbl_ev = OpenEvent(0xF2000003u, 0x0002, 0x2000, 0); stage(5); EnableEvent(vbl_ev); stage(6);
    for (;;) {
        // pace: one picture per vblank. The BIOS pad driver acknowledges the vblank interrupt itself, so the program waits for the BIOS vblank event (root counter 3);
        // the poll is bounded: on a BIOS that never delivers it the program still runs, just unpaced
        for (int g = 0; g < 600000; g++) if (TestEvent(vbl_ev)) break;
        frame++; if (frame == 1) stage(7);
        u32 btn = (pad0[0] == 0) ? (u32)(~(pad0[2] | (pad0[3] << 8)) & 0xFFFF) : 0;   // 1 = pressed
        if (btn & 4) { if (!r3_was) read_disc(); r3_was = 1; } else r3_was = 0;       // R3 (bit 2): read the disc id again
        if (btn & 2) { if (!l3_was) { narrow ^= 1;                                   // L3 (bit 1): switch the display width 320 <-> 256 (the picture size the core reports changes)
#if PAL
            gp1(0x08000009 ^ (narrow ? 1 : 0));
#else
            gp1(0x08000001 ^ (narrow ? 1 : 0));
#endif
            } l3_was = 1; } else l3_was = 0;
        fill(RGB(32, 32, 64));
        rect(0, 0, 320, 16, RGB(0, 120, 60));                                       // header bar
        rect(296, 8, 16, 16, RGB(((frame >> 2) & 1) * 255, ((frame >> 3) & 1) * 255, ((frame >> 4) & 1) * 255));   // frame counter square
        for (int i = 0; i < 16; i++) rect(8 + i * 19, 32, 16, 16, (btn >> i) & 1 ? RGB(255, 255, 255) : RGB(60, 60, 60));
        u8 type = pad0[0] == 0 ? pad0[1] : 0xFF;
        rect(8, 56, 16, 16, type == 0x73 ? RGB(0, 255, 0) : type == 0x41 ? RGB(255, 255, 0) : RGB(255, 0, 0));
        for (int i = 0; i < 4; i++) {                                               // RX RY LX LY
            int v = (type == 0x73) ? pad0[4 + i] : 0;
            rect(8, 80 + i * 18, v ? v : 1, 12, RGB(0, 200, 255));
            rect(8 + 128, 80 + i * 18 - 2, 1, 16, RGB(255, 0, 255));
        }
        rect(8, 150, 16, 16, mc_status == 3 ? RGB(0, 255, 0) : mc_status == 2 ? RGB(255, 0, 255) : mc_status == 1 ? RGB(255, 128, 0) : RGB(255, 0, 0));
        for (int i = 0; i < (mc_counter & 15); i++) rect(8 + i * 16, 170, 14, 14, RGB(255, 140, 0));
        for (int i = 0; i < disc_num; i++) rect(8 + i * 16, 200, 14, 14, RGB(80, 120, 255));
        rect(200, 200, 14, 14, disc_ok ? RGB((disc_mark & 1) * 255, 255, (disc_mark & 2) * 127) : RGB(255, 0, 0));
    }
}
