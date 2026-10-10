// PlaySphere PS1 Runtime for WebAssembly: the same minimal libretro host the Nintendo DS runtime uses (runtime/src/libretro_host.*), with the PCSX-ReARMed core linked in
// (see docs/PLAYSPHERE_PS1_CORE_DECISION.md). One PlayStation, no network. The JavaScript side (ps1.worker.js) owns the clock: it calls dsl_run_frame() at the console's
// frame rate (50 Hz PAL / 60 Hz NTSC, read from the core) and takes the picture / audio out of the buffers below. Entry points are plain C.
// The names shared with the DS runtime (dsl_*) mean the same thing, so the page's video / audio plumbing is the same; ps1_* are the PlayStation extras
// (analog pads, disc swap, save states, rumble, disc probe).
#include <emscripten/emscripten.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "libchdr/chd.h"
#include "libretro_host.hpp"

using dsrt::HostConfig;
using dsrt::LibretroHost;

namespace {
std::unique_ptr<LibretroHost> g_host;
std::string g_log, g_err, g_sramPath, g_json;
std::vector<uint8_t> g_frame;           // latest frame, XRGB8888 as B,G,R,X bytes (the host converts the core's 16 bit pictures)
unsigned g_w = 0, g_h = 0;
uint64_t g_frameSeq = 0;
std::vector<int16_t> g_audio;          // interleaved stereo produced since the last dsl_audio_clear()
double g_lastFrameMs = 0, g_maxFrameMs = 0;
void appendLog(const std::string& s) { if (g_log.size() < 16384) { g_log += s; g_log += '\n'; } }

// ---------------------------------------------------------------------------------------------------------------- disc probe
// Reads just enough of a disc image to say "this is a PlayStation disc, its boot executable is SLUS_006.62": ISO 9660 primary volume descriptor, root directory, SYSTEM.CNF.
// Formats: .cue (+ .bin), .chd (via the core's own libchdr), .iso / .img. Nothing is written, nothing is logged but the verdict.
struct Disc {
    virtual ~Disc() {}
    virtual bool sector(uint32_t lba, uint8_t* out2048) = 0;     // user data of sector 'lba' of the first data track (index 01 = 0)
    std::string format, trackType;
    uint64_t sectors = 0;
};
struct FileDisc : Disc {
    FILE* f = nullptr; uint32_t unit = 2048, off = 0; uint64_t base = 0;
    ~FileDisc() override { if (f) fclose(f); }
    bool sector(uint32_t lba, uint8_t* out) override {
        if (!f) return false;
        if (fseeko(f, off_t(base + uint64_t(lba) * unit + off), SEEK_SET) != 0) return false;
        return fread(out, 1, 2048, f) == 2048;
    }
};
struct ChdDisc : Disc {
    chd_file* c = nullptr; uint32_t unit = 2448, off = 0, hunkBytes = 0; std::vector<uint8_t> buf; int64_t cur = -1;
    ~ChdDisc() override { if (c) chd_close(c); }
    bool sector(uint32_t lba, uint8_t* out) override {
        const uint64_t pos = uint64_t(lba) * unit, hunk = pos / hunkBytes, inH = pos % hunkBytes;
        if (int64_t(hunk) != cur) { if (chd_read(c, uint32_t(hunk), buf.data()) != CHDERR_NONE) return false; cur = int64_t(hunk); }
        if (inH + off + 2048 > hunkBytes) return false;
        std::memcpy(out, buf.data() + inH + off, 2048);
        return true;
    }
};
void trackGeometry(const std::string& type, uint32_t& unit, uint32_t& off, bool& data) {
    data = true;
    if (type == "MODE1" || type == "MODE1/2048" || type == "MODE2_FORM1") { unit = 2048; off = 0; }
    else if (type == "MODE1_RAW" || type == "MODE1/2352") { unit = 2352; off = 16; }
    else if (type == "MODE2_RAW" || type == "MODE2/2352") { unit = 2352; off = 24; }
    else if (type == "MODE2" || type == "MODE2_FORM_MIX" || type == "MODE2/2336") { unit = 2336; off = 8; }
    else data = false;                                           // AUDIO and anything unknown
}
std::string dirOf(const std::string& p) { auto s = p.find_last_of("/\\"); return s == std::string::npos ? std::string(".") : p.substr(0, s); }
std::unique_ptr<Disc> openDisc(const std::string& path, std::string& err) {
    auto low = path; for (auto& ch : low) ch = char(tolower((unsigned char)ch));
    auto ends = [&](const char* e) { size_t n = strlen(e); return low.size() >= n && low.compare(low.size() - n, n, e) == 0; };
    if (ends(".chd")) {
        auto d = std::make_unique<ChdDisc>(); d->format = "chd";
        if (chd_open(path.c_str(), CHD_OPEN_READ, nullptr, &d->c) != CHDERR_NONE) { err = "chd_open"; return nullptr; }
        const chd_header* h = chd_get_header(d->c);
        d->hunkBytes = h->hunkbytes; d->unit = h->unitbytes ? h->unitbytes : 2448; d->buf.resize(d->hunkBytes);
        char meta[256]; uint32_t len = 0; std::string type;
        if (chd_get_metadata(d->c, 0x43485432 /*CHT2*/, 0, meta, sizeof meta, &len, nullptr, nullptr) == CHDERR_NONE || chd_get_metadata(d->c, 0x43485452 /*CHTR*/, 0, meta, sizeof meta, &len, nullptr, nullptr) == CHDERR_NONE) {
            std::string m(meta, len); auto p = m.find("TYPE:"); if (p != std::string::npos) { p += 5; auto e = m.find(' ', p); type = m.substr(p, e == std::string::npos ? std::string::npos : e - p); }
        } else { err = "no_track_metadata"; return nullptr; }
        bool data; uint32_t cooked = 0; trackGeometry(type, cooked, d->off, data);          // the stride of a CHD frame is its own unit size (2448); only the data offset comes from the track type
        if (!data) { err = "audio_only"; return nullptr; }
        d->trackType = type; d->sectors = h->logicalbytes / d->unit;
        return d;
    }
    if (ends(".cue")) {
        FILE* cf = fopen(path.c_str(), "rb"); if (!cf) { err = "cue_open"; return nullptr; }
        std::string text(64 * 1024, '\0'); text.resize(fread(&text[0], 1, text.size(), cf)); fclose(cf);
        std::string binName, type; uint64_t index01 = 0; bool inFirst = false, haveFile = false, haveTrack = false;
        size_t pos = 0;
        while (pos < text.size()) {
            size_t e = text.find('\n', pos); std::string line = text.substr(pos, e == std::string::npos ? std::string::npos : e - pos); pos = e == std::string::npos ? text.size() : e + 1;
            while (!line.empty() && (line.back() == '\r' || line.back() == ' ')) line.pop_back();
            size_t a = line.find_first_not_of(" \t"); if (a == std::string::npos) continue; line = line.substr(a);
            if (line.rfind("FILE", 0) == 0 && !haveFile) {
                size_t q1 = line.find('"'), q2 = q1 == std::string::npos ? q1 : line.find('"', q1 + 1);
                if (q1 != std::string::npos && q2 != std::string::npos) binName = line.substr(q1 + 1, q2 - q1 - 1);
                else { size_t s = line.find(' '); size_t t = line.find(' ', s + 1); binName = line.substr(s + 1, t - s - 1); }
                auto sl = binName.find_last_of("/\\"); if (sl != std::string::npos) binName = binName.substr(sl + 1);
                haveFile = true;
            } else if (line.rfind("TRACK", 0) == 0 && haveFile && !haveTrack) {
                size_t s = line.find(' '), t = line.find(' ', s + 1); type = line.substr(t + 1); haveTrack = true; inFirst = true;
            } else if (line.rfind("INDEX 01", 0) == 0 && inFirst) {
                unsigned mm = 0, ss = 0, ff = 0; sscanf(line.c_str() + 8, "%u:%u:%u", &mm, &ss, &ff); index01 = (uint64_t(mm) * 60 + ss) * 75 + ff; inFirst = false;
            }
        }
        if (!haveFile || !haveTrack) { err = "cue_syntax"; return nullptr; }
        auto d = std::make_unique<FileDisc>(); d->format = "cue"; bool data;
        trackGeometry(type, d->unit, d->off, data);
        if (!data) { err = "audio_only"; return nullptr; }
        d->trackType = type; std::string bp = dirOf(path) + "/" + binName; d->f = fopen(bp.c_str(), "rb"); if (!d->f) { err = "bin_missing"; return nullptr; }
        d->base = index01 * d->unit; fseeko(d->f, 0, SEEK_END); d->sectors = uint64_t(ftello(d->f)) / d->unit;
        return d;
    }
    if (ends(".iso") || ends(".img") || ends(".bin")) {
        auto d = std::make_unique<FileDisc>(); d->format = ends(".bin") ? "bin" : "iso"; d->f = fopen(path.c_str(), "rb"); if (!d->f) { err = "open"; return nullptr; }
        fseeko(d->f, 0, SEEK_END); uint64_t sz = uint64_t(ftello(d->f));
        uint8_t sync[12] = {0}; fseeko(d->f, 0, SEEK_SET); fread(sync, 1, 12, d->f);
        const bool raw = sync[0] == 0 && sync[1] == 0xFF && sync[11] == 0;
        if (raw && sz % 2352 == 0) { d->unit = 2352; d->off = 24; d->trackType = "MODE2/2352"; } else if (sz % 2048 == 0) { d->unit = 2048; d->off = 0; d->trackType = "MODE1/2048"; } else { err = "unknown_layout"; return nullptr; }
        d->sectors = sz / d->unit; return d;
    }
    err = "unsupported_format"; return nullptr;
}
std::string trim(std::string s) { size_t a = s.find_first_not_of(" \t\r\n\0"); if (a == std::string::npos) return ""; size_t b = s.find_last_not_of(" \t\r\n\0"); return s.substr(a, b - a + 1); }
std::string jesc(const std::string& s) { std::string o; for (unsigned char c : s) { if (c == '"' || c == '\\') { o += '\\'; o += char(c); } else if (c < 32 || c > 126) o += '?'; else o += char(c); } return o; }

std::string probe(const std::string& path) {
    std::string err; auto d = openDisc(path, err);
    auto fail = [&](const std::string& e) { return "{\"ok\":false,\"error\":\"" + e + "\"}"; };
    if (!d) return fail(err);
    uint8_t pvd[2048]; if (!d->sector(16, pvd)) return fail("unreadable");
    if (memcmp(pvd + 1, "CD001", 5) != 0 || pvd[0] != 1) return fail("not_iso9660");
    const std::string sys = trim(std::string(reinterpret_cast<char*>(pvd + 8), 32)), vol = trim(std::string(reinterpret_cast<char*>(pvd + 40), 32));
    if (sys != "PLAYSTATION") return fail("not_playstation");
    auto le32 = [](const uint8_t* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; };
    const uint32_t rootLba = le32(pvd + 156 + 2), rootLen = le32(pvd + 156 + 10);
    auto findIn = [&](const char* want, uint32_t& lba, uint32_t& len) {
        for (uint32_t s = 0; s * 2048 < rootLen && s < 16; ++s) {
            uint8_t sec[2048]; if (!d->sector(rootLba + s, sec)) return false;
            for (uint32_t p = 0; p < 2048;) {
                const uint8_t rl = sec[p]; if (!rl) break;
                const uint8_t nl = sec[p + 32]; std::string nm(reinterpret_cast<char*>(sec + p + 33), nl);
                if (nm == want) { lba = le32(sec + p + 2); len = le32(sec + p + 10); return true; }
                p += rl;
            }
        }
        return false;
    };
    uint32_t lba = 0, len = 0; std::string boot, bootFile;
    if (findIn("SYSTEM.CNF;1", lba, len)) {
        uint8_t sec[2048]; if (d->sector(lba, sec)) {
            std::string t(reinterpret_cast<char*>(sec), len > 2048 ? 2048 : len); size_t pos = 0;
            while (pos < t.size()) {
                size_t e = t.find('\n', pos); std::string line = t.substr(pos, e == std::string::npos ? std::string::npos : e - pos); pos = e == std::string::npos ? t.size() : e + 1;
                for (auto& ch : line) ch = char(toupper((unsigned char)ch));
                if (line.rfind("BOOT2", 0) == 0) return fail("playstation2");
                if (line.rfind("BOOT", 0) == 0) {
                    size_t eq = line.find('='); if (eq == std::string::npos) continue;
                    std::string v = trim(line.substr(eq + 1)); size_t c = v.find(':'); if (c != std::string::npos) v = v.substr(c + 1);
                    size_t sl = v.find_last_of("\\/"); if (sl != std::string::npos) v = v.substr(sl + 1);
                    size_t sc = v.find(';'); if (sc != std::string::npos) v = v.substr(0, sc);
                    bootFile = trim(v);
                }
            }
        }
    } else if (findIn("PSX.EXE;1", lba, len)) bootFile = "PSX.EXE"; else return fail("no_boot_file");
    // serial: letters + digits of the boot file name (SLUS_006.62 -> SLUS00662); homebrew executables keep an empty serial
    std::string serial; for (char c : bootFile) if (c != '_' && c != '.' && c != '-') serial += c;
    const bool looksSerial = serial.size() == 9 && isalpha((unsigned char)serial[0]) && isalpha((unsigned char)serial[3]) && isdigit((unsigned char)serial[4]);
    if (!looksSerial) serial.clear();
    return "{\"ok\":true,\"format\":\"" + d->format + "\",\"trackType\":\"" + jesc(d->trackType) + "\",\"sectors\":" + std::to_string(d->sectors) + ",\"volume\":\"" + jesc(vol) + "\",\"boot\":\"" + jesc(bootFile) + "\",\"serial\":\"" + jesc(serial) + "\"}";
}
}  // namespace

extern "C" {

// libretro-common's task queue and the core call retro_sleep(); a browser worker has no blocking sleep, a short busy wait is enough (it is only used on error paths).
void retro_sleep(unsigned msec) {
    auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(msec);
    while (std::chrono::steady_clock::now() < end) {}
}

EMSCRIPTEN_KEEPALIVE int dsl_init(const char*, const char*) {
    g_host.reset(new LibretroHost());
    g_log.clear(); g_err.clear();
    g_host->onLog = [](int level, const std::string& s) { if (level >= 1) appendLog(s); };
    g_host->onVideo = [](const uint8_t* d, unsigned w, unsigned h, size_t pitch) {
        g_w = w; g_h = h; g_frame.resize(size_t(w) * h * 4);
        if (pitch == size_t(w) * 4) std::memcpy(g_frame.data(), d, g_frame.size());
        else for (unsigned y = 0; y < h; ++y) std::memcpy(g_frame.data() + size_t(y) * w * 4, d + y * pitch, size_t(w) * 4);
        ++g_frameSeq;
    };
    g_host->onAudio = [](const int16_t* d, size_t frames) { if (g_audio.size() < 48000 * 2) g_audio.insert(g_audio.end(), d, d + frames * 2); };
    std::string err;
    if (!g_host->loadCore("", err)) { g_err = err; return 0; }
    return 1;
}
EMSCRIPTEN_KEEPALIVE uint8_t* dsl_alloc(size_t n) { return static_cast<uint8_t*>(std::malloc(n)); }
EMSCRIPTEN_KEEPALIVE void dsl_free(uint8_t* p) { std::free(p); }

// 'options' = core options, one `key = "value"` per line. 'contentPath' = a .cue / .chd / .m3u / .iso inside the module's file system (the page mounts the user's files there).
EMSCRIPTEN_KEEPALIVE int ps1_start(const char* options, const char* systemDir, const char* saveDir, const char* contentPath) {
    g_err.clear();
    if (!g_host) { g_err = "not initialised"; return 0; }
    HostConfig cfg;
    cfg.systemDir = systemDir; cfg.saveDir = saveDir; cfg.optionsText = options ? options : ""; cfg.username = "PlaySphere"; cfg.contentPath = contentPath ? contentPath : ""; cfg.extendedEnv = true;
    std::string err;
    if (!g_host->start(cfg, err)) { g_err = err; return 0; }
    std::string base = cfg.contentPath.substr(cfg.contentPath.find_last_of('/') + 1); auto dot = base.find_last_of('.'); if (dot != std::string::npos) base = base.substr(0, dot);
    g_sramPath = std::string(saveDir) + "/" + (g_host->sysinfo.library_name ? g_host->sysinfo.library_name : "core") + "/" + base + ".srm";
    return 1;
}
EMSCRIPTEN_KEEPALIVE int dsl_run_frame() {
    if (!g_host) return 0;
    auto t0 = std::chrono::steady_clock::now();
    g_host->runFrame();
    double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    g_lastFrameMs = ms; if (ms > g_maxFrameMs) g_maxFrameMs = ms;
    return g_host->shutdownRequested() ? 0 : 1;
}
EMSCRIPTEN_KEEPALIVE const uint8_t* dsl_video_ptr() { return g_frame.data(); }
EMSCRIPTEN_KEEPALIVE int dsl_video_w() { return int(g_w); }
EMSCRIPTEN_KEEPALIVE int dsl_video_h() { return int(g_h); }
EMSCRIPTEN_KEEPALIVE double dsl_video_seq() { return double(g_frameSeq); }
// picture aspect ratio the core asks for (width / height); 0 when it does not say
EMSCRIPTEN_KEEPALIVE double ps1_aspect() { return g_host ? double(g_host->av.geometry.aspect_ratio) : 0; }
EMSCRIPTEN_KEEPALIVE int dsl_audio_frames() { return int(g_audio.size() / 2); }
EMSCRIPTEN_KEEPALIVE const int16_t* dsl_audio_ptr() { return g_audio.data(); }
EMSCRIPTEN_KEEPALIVE void dsl_audio_clear() { g_audio.clear(); }
EMSCRIPTEN_KEEPALIVE double dsl_sample_rate() { return g_host ? g_host->av.timing.sample_rate : 0; }
EMSCRIPTEN_KEEPALIVE double dsl_fps() { return g_host ? g_host->av.timing.fps : 0; }

// RetroPad bit mask (bit i = RETRO_DEVICE_ID_JOYPAD_i) for player 1; ps1_set_pad adds the second pad and the analog sticks (-32768..32767)
EMSCRIPTEN_KEEPALIVE void dsl_set_buttons(uint32_t mask) { if (g_host) g_host->input[0].buttons = mask; }
EMSCRIPTEN_KEEPALIVE void ps1_set_pad(int port, uint32_t mask, int lx, int ly, int rx, int ry) {
    if (!g_host || port < 0 || port >= LibretroHost::kPorts) return;
    auto& in = g_host->input[port]; in.buttons = mask; in.analog[0] = lx; in.analog[1] = ly; in.analog[2] = rx; in.analog[3] = ry;
}
// device: 1 = RETRO_DEVICE_JOYPAD (digital pad); the DualShock is RETRO_DEVICE_SUBCLASS(RETRO_DEVICE_ANALOG, 1) = ((1 + 1) << 8) | 5 = 517
EMSCRIPTEN_KEEPALIVE void ps1_set_device(int port, unsigned device) { if (g_host) g_host->setControllerDevice(unsigned(port), device); }
EMSCRIPTEN_KEEPALIVE int ps1_rumble(int port, int motor) { return g_host && port >= 0 && port < LibretroHost::kPorts && motor >= 0 && motor < 2 ? g_host->rumble[port][motor].load() : 0; }

// memory card 1 as the core exposes it (RETRO_MEMORY_SAVE_RAM): 128 KiB
EMSCRIPTEN_KEEPALIVE int dsl_sram_size() { return g_host ? int(g_host->sramSize()) : 0; }
EMSCRIPTEN_KEEPALIVE int dsl_save_sram() { if (!g_host) return 0; g_host->saveSram(); return 1; }
EMSCRIPTEN_KEEPALIVE const char* dsl_sram_path() { return g_sramPath.c_str(); }

// discs: multi-disc games come as an .m3u; the core builds the list and these drive its disk control interface
EMSCRIPTEN_KEEPALIVE int ps1_disc_supported() { return g_host && g_host->hasDiskControl() ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int ps1_disc_count() { return g_host ? int(g_host->diskCount()) : 0; }
EMSCRIPTEN_KEEPALIVE int ps1_disc_index() { return g_host ? int(g_host->diskIndex()) : 0; }
EMSCRIPTEN_KEEPALIVE int ps1_disc_ejected() { return g_host && g_host->diskEjected() ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int ps1_disc_set_eject(int e) { return g_host && g_host->diskSetEject(e != 0) ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int ps1_disc_set_index(int i) { return g_host && g_host->diskSetIndex(unsigned(i)) ? 1 : 0; }

// save states: the page allocates a buffer with dsl_alloc
EMSCRIPTEN_KEEPALIVE int ps1_state_size() { return g_host ? int(g_host->stateSize()) : 0; }
EMSCRIPTEN_KEEPALIVE int ps1_state_save(uint8_t* dst, int n) { return g_host && g_host->stateSave(dst, size_t(n)) ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int ps1_state_load(const uint8_t* src, int n) { return g_host && g_host->stateLoad(src, size_t(n)) ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE const char* ps1_core_version() { return g_host && g_host->sysinfo.library_version ? g_host->sysinfo.library_version : ""; }
EMSCRIPTEN_KEEPALIVE const char* ps1_core_name() { return g_host && g_host->sysinfo.library_name ? g_host->sysinfo.library_name : ""; }

// disc probe (no core needed): JSON {"ok":true,"format","trackType","sectors","volume","boot","serial"} or {"ok":false,"error":...}
EMSCRIPTEN_KEEPALIVE const char* ps1_probe(const char* path) { g_json = probe(path ? path : ""); return g_json.c_str(); }

EMSCRIPTEN_KEEPALIVE void dsl_stop() { if (g_host) { g_host->stop(); g_host.reset(); } g_frame.clear(); g_frame.shrink_to_fit(); g_audio.clear(); g_audio.shrink_to_fit(); }
EMSCRIPTEN_KEEPALIVE const char* dsl_error() { return g_err.c_str(); }
EMSCRIPTEN_KEEPALIVE const char* dsl_log() { return g_log.c_str(); }
EMSCRIPTEN_KEEPALIVE void dsl_log_clear() { g_log.clear(); }
EMSCRIPTEN_KEEPALIVE double dsl_last_frame_ms() { return g_lastFrameMs; }
EMSCRIPTEN_KEEPALIVE double dsl_max_frame_ms() { double m = g_maxFrameMs; g_maxFrameMs = 0; return m; }
EMSCRIPTEN_KEEPALIVE double dsl_frames() { return g_host ? double(g_host->metrics.frames.load()) : 0; }

}  // extern "C"
