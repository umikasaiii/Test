// A tiny libretro core that exercises ONLY the NETPACKET interface, used to compare DSLink's Multiplayer Bridge with RetroArch's
// Netplay packet semantics (same core, two frontends). Logs every start/receive/connect/disconnect/stop through the libretro
// log interface. Own code, GPLv3.
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <string>
#include <ctime>
#include <cstdlib>

#include "libretro.h"

static retro_environment_t env;
static retro_video_refresh_t video;
static retro_audio_sample_batch_t audio;
static retro_log_printf_t logf;
static retro_netpacket_send_t send_fn;
static retro_netpacket_poll_receive_t poll_fn;
static int my_id = -1;
static unsigned frame_no;
static uint32_t fb[64 * 64];

static void L(const char* fmt, ...) {
    char b[512];
    va_list ap; va_start(ap, fmt); vsnprintf(b, sizeof b, fmt, ap); va_end(ap);
    if (logf) logf(RETRO_LOG_INFO, "NPT %s\n", b);
}

static void np_start(uint16_t id, retro_netpacket_send_t s, retro_netpacket_poll_receive_t p) { my_id = id; send_fn = s; poll_fn = p; L("START id=%u", id); }
static void np_receive(const void* buf, size_t len, uint16_t src) { L("RECV src=%u len=%zu data=%.*s", src, len, int(len), static_cast<const char*>(buf)); }
static void np_stop() { L("STOP"); send_fn = nullptr; poll_fn = nullptr; my_id = -1; }
static void np_poll() {}
static bool np_connected(uint16_t id) { L("CONNECTED id=%u", id); return true; }
static void np_disconnected(uint16_t id) { L("DISCONNECTED id=%u", id); }

extern "C" {
RETRO_API unsigned retro_api_version(void) { return RETRO_API_VERSION; }
RETRO_API void retro_set_environment(retro_environment_t e) {
    env = e;
    retro_log_callback lc;
    if (env(RETRO_ENVIRONMENT_GET_LOG_INTERFACE, &lc)) logf = lc.log;
    bool yes = true;
    env(RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME, &yes);
    static retro_netpacket_callback cb = {np_start, np_receive, np_stop, np_poll, np_connected, np_disconnected, "dslink-npt-1"};
    env(RETRO_ENVIRONMENT_SET_NETPACKET_INTERFACE, &cb);
}
RETRO_API void retro_set_video_refresh(retro_video_refresh_t v) { video = v; }
RETRO_API void retro_set_audio_sample(retro_audio_sample_t) {}
RETRO_API void retro_set_audio_sample_batch(retro_audio_sample_batch_t a) { audio = a; }
RETRO_API void retro_set_input_poll(retro_input_poll_t) {}
RETRO_API void retro_set_input_state(retro_input_state_t) {}
RETRO_API void retro_init(void) {}
RETRO_API void retro_deinit(void) {}
RETRO_API void retro_get_system_info(struct retro_system_info* i) {
    std::memset(i, 0, sizeof *i);
    i->library_name = "dslink-npt"; i->library_version = "1"; i->valid_extensions = "npt"; i->need_fullpath = false;
}
RETRO_API void retro_get_system_av_info(struct retro_system_av_info* i) {
    std::memset(i, 0, sizeof *i);
    i->geometry.base_width = i->geometry.max_width = 64; i->geometry.base_height = i->geometry.max_height = 64;
    i->geometry.aspect_ratio = 1.0f; i->timing.fps = 60.0; i->timing.sample_rate = 32000.0;
}
RETRO_API void retro_set_controller_port_device(unsigned, unsigned) {}
RETRO_API void retro_reset(void) {}
RETRO_API void retro_run(void) {
    ++frame_no;
    // NPT_BLOCK=1 reproduces how melonDS DS waits for MP replies (MpState::NextPacketBlock): a 25 ms busy loop that calls send(flush hint) and poll_receive
    // through its CURRENT function pointers, which np_stop() nulls. A frontend that calls stop() from inside poll_receive makes the next iteration crash.
    static const bool block = std::getenv("NPT_BLOCK") != nullptr;
    if (block && send_fn && poll_fn) {
        for (std::clock_t t0 = std::clock(); std::clock() < t0 + 25 * CLOCKS_PER_SEC / 1000;) {
            send_fn(RETRO_NETPACKET_FLUSH_HINT, nullptr, 0, RETRO_NETPACKET_BROADCAST);
            poll_fn();
        }
    }
    if (send_fn && my_id >= 0 && frame_no % 20 == 0) {
        char m[64];
        int n = snprintf(m, sizeof m, "id=%d:seq=%u", my_id, frame_no / 20);
        if (my_id != 0) send_fn(RETRO_NETPACKET_RELIABLE, m, size_t(n), 0);                  // client -> host only
        else send_fn(RETRO_NETPACKET_RELIABLE | RETRO_NETPACKET_FLUSH_HINT, m, size_t(n), RETRO_NETPACKET_BROADCAST);  // host -> all
        if (my_id != 0 && frame_no % 40 == 0) send_fn(RETRO_NETPACKET_RELIABLE, "bcast", 5, RETRO_NETPACKET_BROADCAST);
    }
    for (auto& p : fb) p = 0x00202020u + frame_no;
    video(fb, 64, 64, 64 * 4);
    static int16_t silence[2 * 533];
    audio(silence, 533);
}
RETRO_API bool retro_load_game(const struct retro_game_info*) {
    retro_pixel_format f = RETRO_PIXEL_FORMAT_XRGB8888;
    env(RETRO_ENVIRONMENT_SET_PIXEL_FORMAT, &f);
    return true;
}
RETRO_API bool retro_load_game_special(unsigned, const struct retro_game_info*, size_t) { return false; }
RETRO_API void retro_unload_game(void) {}
RETRO_API unsigned retro_get_region(void) { return RETRO_REGION_NTSC; }
RETRO_API size_t retro_serialize_size(void) { return 0; }
RETRO_API bool retro_serialize(void*, size_t) { return false; }
RETRO_API bool retro_unserialize(const void*, size_t) { return false; }
RETRO_API void* retro_get_memory_data(unsigned) { return nullptr; }
RETRO_API size_t retro_get_memory_size(unsigned) { return 0; }
RETRO_API void retro_cheat_reset(void) {}
RETRO_API void retro_cheat_set(unsigned, bool, const char*) {}
}
