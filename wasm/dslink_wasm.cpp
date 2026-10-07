// DSLink Runtime for WebAssembly: the same minimal libretro host the Android/desktop Runtime uses (runtime/src/libretro_host.*), with the melonDS DS core linked in.
// One DS, no network, no encoder. The JavaScript side (wasm/web/emulator.worker.js) owns the clock: it calls dsl_run_frame() at the DS frame rate and takes the
// picture / audio out of the buffers below. All entry points are plain C so they are trivially callable from JS.
#include <emscripten/emscripten.h>

#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "libretro_host.hpp"
#include "mp_bridge.hpp"
#include "webrtc_link.hpp"

using dsrt::HostConfig;
using dsrt::LibretroHost;

namespace {
std::unique_ptr<LibretroHost> g_host;
std::unique_ptr<dsrt::MpBridge> g_bridge;
dsrt::DlDiag g_diag;                 // Download Play diagnostics: passive classifier of the radio frames (same state machine as the native Runtime)
std::string g_dlJson;
double g_dlTickAt = 0;   // Distributed: the Multiplayer Bridge over a WebRTC DataChannel (null in Single Player)
std::string g_log, g_err, g_sramPath, g_system, g_save, g_content;
std::vector<uint8_t> g_frame;           // latest frame as the core delivers it: XRGB8888, i.e. B,G,R,X bytes
unsigned g_w = 0, g_h = 0;
uint64_t g_frameSeq = 0;
std::vector<int16_t> g_audio;          // interleaved stereo produced since the last dsl_take_audio()
double g_lastFrameMs = 0, g_maxFrameMs = 0;
const uint8_t* g_rom = nullptr;
size_t g_romSize = 0;

void appendLog(const std::string& s) {
    if (g_log.size() < 16384) { g_log += s; g_log += '\n'; }
}
}  // namespace

extern "C" {

// libretro-common's task queue and the core call retro_sleep(); a browser worker has no blocking sleep, a short busy wait is enough (it is only used on error paths).
void retro_sleep(unsigned msec) {
    auto end = std::chrono::steady_clock::now() + std::chrono::milliseconds(msec);
    while (std::chrono::steady_clock::now() < end) {}
}

// Builds the host and binds the (statically linked) core.
EMSCRIPTEN_KEEPALIVE int dsl_init(const char* systemDir, const char* saveDir) {
    g_host.reset(new LibretroHost());
    g_system = systemDir ? systemDir : "/system";
    g_save = saveDir ? saveDir : "/saves";
    g_log.clear(); g_err.clear();
    g_host->onLog = [](int level, const std::string& s) { if (level >= 1) appendLog(s); };  // INFO and above, never contains file contents
    g_host->onVideo = [](const uint8_t* d, unsigned w, unsigned h, size_t pitch) {
        // One plain copy of the core's XRGB8888 picture (B,G,R,X in memory). The page uploads it as RGBA and the GPU swaps the channels: no per-pixel loop on the emulation thread.
        g_w = w; g_h = h;
        g_frame.resize(size_t(w) * h * 4);
        if (pitch == size_t(w) * 4) std::memcpy(g_frame.data(), d, g_frame.size());
        else for (unsigned y = 0; y < h; ++y) std::memcpy(g_frame.data() + size_t(y) * w * 4, d + y * pitch, size_t(w) * 4);
        ++g_frameSeq;
    };
    g_host->onAudio = [](const int16_t* d, size_t frames) {
        if (g_audio.size() < 48000 * 2) g_audio.insert(g_audio.end(), d, d + frames * 2);
    };
    std::string err;
    if (!g_host->loadCore("", err)) { g_err = err; return 0; }
    return 1;
}

// The ROM bytes live in the module's heap (the page copied them there with dsl_alloc): the core reads them in place.
EMSCRIPTEN_KEEPALIVE uint8_t* dsl_alloc(size_t n) { return static_cast<uint8_t*>(std::malloc(n)); }
EMSCRIPTEN_KEEPALIVE void dsl_free(uint8_t* p) { std::free(p); }

// 'options' = melonDS DS core options, one `key = "value"` per line.
// radioRole: 0 = Single Player, 1 = Distributed host (player 1), 2 = Distributed guest (player 2); the transport is the page's RTCDataChannel (webrtc_link.hpp)
EMSCRIPTEN_KEEPALIVE int dsl_start(const char* options, const char* systemDir, const char* saveDir, const char* contentName, uint8_t* rom, size_t romSize, int radioRole) {
    g_err.clear();
    if (!g_host) { g_err = "not initialised"; return 0; }
    g_rom = rom; g_romSize = romSize;
    HostConfig cfg;
    cfg.systemDir = systemDir; cfg.saveDir = saveDir; cfg.optionsText = options ? options : "";
    cfg.username = radioRole == 1 ? "DSLinkP1" : radioRole == 2 ? "DSLinkP2" : "DSLinkWeb";   // the DS Wi-Fi MAC derives from the user name: the two consoles of a session must differ
    if (rom && romSize) {                             // romSize 0 = NO cartridge: the core boots the firmware menu itself (the Download Play guest)
        g_content = std::string("/rom/") + contentName;   // the core derives the save name from this
        cfg.contentPath = g_content;
        cfg.contentPtr = rom; cfg.contentSize = romSize;
    } else g_content.clear();
    std::string err;
    if (!g_host->start(cfg, err)) { g_err = err; return 0; }
    if (radioRole == 1 || radioRole == 2) {
        g_diag = dsrt::DlDiag(); g_diag.logFn = [](const std::string& l) { if (g_log.size() < 65536) g_log += l + "\n"; };
        g_bridge.reset(new dsrt::MpBridge());
        g_bridge->setDiag(&g_diag);
        std::unique_ptr<dsrt::RadioLink> link(new dsrt::WebRtcLink(radioRole == 1));
        const bool ok = radioRole == 1 ? g_bridge->attachHost(*g_host, std::move(link), err) : g_bridge->attachGuest(*g_host, std::move(link), 1, err);
        if (!ok) { g_err = err; g_bridge.reset(); return 0; }
    }
    // SRAM: <saves>/<core name>/<content basename>.srm (same layout as the desktop Runtime)
    std::string base = contentName;
    auto dot = base.find_last_of('.');
    if (dot != std::string::npos) base = base.substr(0, dot);
    g_sramPath = g_save + "/" + (g_host->sysinfo.library_name ? g_host->sysinfo.library_name : "core") + "/" + base + ".srm";
    return 1;
}

EMSCRIPTEN_KEEPALIVE int dsl_run_frame() {
    if (!g_host) return 0;
    auto t0 = std::chrono::steady_clock::now();
    if (g_bridge) {
        const double now = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count();
        if (now - g_dlTickAt >= 1000) { g_dlTickAt = now; g_diag.tick(now); }
    }
    if (g_bridge) g_bridge->pump();            // as the native Runtime: deliver the radio frames that arrived, BEFORE the core runs its frame
    g_host->runFrame();
    double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    g_lastFrameMs = ms;
    if (ms > g_maxFrameMs) g_maxFrameMs = ms;
    return g_host->shutdownRequested() ? 0 : 1;
}

EMSCRIPTEN_KEEPALIVE const uint8_t* dsl_video_ptr() { return g_frame.data(); }
EMSCRIPTEN_KEEPALIVE int dsl_video_w() { return int(g_w); }
EMSCRIPTEN_KEEPALIVE int dsl_video_h() { return int(g_h); }
EMSCRIPTEN_KEEPALIVE double dsl_video_seq() { return double(g_frameSeq); }

// Audio produced since the last call: returns the number of stereo frames, the samples are at dsl_audio_ptr().
EMSCRIPTEN_KEEPALIVE int dsl_audio_frames() { return int(g_audio.size() / 2); }
EMSCRIPTEN_KEEPALIVE const int16_t* dsl_audio_ptr() { return g_audio.data(); }
EMSCRIPTEN_KEEPALIVE void dsl_audio_clear() { g_audio.clear(); }
EMSCRIPTEN_KEEPALIVE double dsl_sample_rate() { return g_host ? g_host->av.timing.sample_rate : 0; }
EMSCRIPTEN_KEEPALIVE double dsl_fps() { return g_host ? g_host->av.timing.fps : 0; }

// libretro RetroPad bit mask (bit i = RETRO_DEVICE_ID_JOYPAD_i) and the pointer over the whole picture, both normalised 0..1.
EMSCRIPTEN_KEEPALIVE void dsl_set_buttons(uint32_t mask) { if (g_host) g_host->input[0].buttons = mask; }
EMSCRIPTEN_KEEPALIVE void dsl_set_touch(int down, float x, float y) {
    if (!g_host) return;
    auto cl = [](float v) { return v < 0 ? 0.f : (v > 1 ? 1.f : v); };
    g_host->input[0].pointerX = int((cl(x) * 2 - 1) * 32767);
    g_host->input[0].pointerY = int((cl(y) * 2 - 1) * 32767);
    g_host->input[0].pointerDown = down != 0;
}

EMSCRIPTEN_KEEPALIVE int dsl_sram_size() { return g_host ? int(g_host->sramSize()) : 0; }
EMSCRIPTEN_KEEPALIVE int dsl_save_sram() { if (!g_host) return 0; g_host->saveSram(); return 1; }
EMSCRIPTEN_KEEPALIVE const char* dsl_sram_path() { return g_sramPath.c_str(); }
EMSCRIPTEN_KEEPALIVE double dsl_radio_in() { return g_bridge ? double(g_bridge->packetsIn()) : 0; }
EMSCRIPTEN_KEEPALIVE double dsl_radio_out() { return g_bridge ? double(g_bridge->packetsOut()) : 0; }
EMSCRIPTEN_KEEPALIVE int dsl_radio_active() { return g_bridge && g_bridge->sessionActive() ? 1 : 0; }
EMSCRIPTEN_KEEPALIVE int dsl_radio_peers() { return g_bridge ? int(g_bridge->peers()) : 0; }
// Download Play diagnostics as JSON: {"dl_state":...,"dl_counters":{...},"dl_hist":[...]}  (frame classification only: counters and timings, never payload)
EMSCRIPTEN_KEEPALIVE const char* dsl_dl_json() { g_dlJson = "{" + g_diag.json() + "}"; return g_dlJson.c_str(); }
EMSCRIPTEN_KEEPALIVE void dsl_dl_mark(const char* state, const char* why) { dsrt::DlState st; if (dsrt::DlDiag::parse(state ? state : "", &st)) g_diag.mark(st, why ? why : "page", std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count() - g_diag.baseMs()); }
EMSCRIPTEN_KEEPALIVE void dsl_stop() { if (g_bridge) { g_bridge->stop(); g_bridge.reset(); } if (g_host) { g_host->stop(); g_host.reset(); } g_rom = nullptr; g_romSize = 0; }

EMSCRIPTEN_KEEPALIVE const char* dsl_error() { return g_err.c_str(); }
EMSCRIPTEN_KEEPALIVE const char* dsl_log() { return g_log.c_str(); }
EMSCRIPTEN_KEEPALIVE void dsl_log_clear() { g_log.clear(); }
EMSCRIPTEN_KEEPALIVE double dsl_last_frame_ms() { return g_lastFrameMs; }
EMSCRIPTEN_KEEPALIVE double dsl_max_frame_ms() { double m = g_maxFrameMs; g_maxFrameMs = 0; return m; }
EMSCRIPTEN_KEEPALIVE double dsl_frames() { return g_host ? double(g_host->metrics.frames.load()) : 0; }

}  // extern "C"
