#include "libretro_host.hpp"

#ifndef DSLINK_WASM
#include <dlfcn.h>
#endif

#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>

namespace dsrt {
namespace {
LibretroHost* g_host = nullptr;  // libretro callbacks carry no user pointer

bool RETRO_CALLCONV cb_env(unsigned cmd, void* d) { return g_host && g_host->environment(cmd, d); }
void RETRO_CALLCONV cb_video(const void* d, unsigned w, unsigned h, size_t p) { if (g_host) g_host->videoRefresh(d, w, h, p); }
void RETRO_CALLCONV cb_audio_sample(int16_t l, int16_t r) { int16_t s[2] = {l, r}; if (g_host) g_host->audioBatch(s, 1); }
size_t RETRO_CALLCONV cb_audio_batch(const int16_t* d, size_t n) { return g_host ? g_host->audioBatch(d, n) : n; }
void RETRO_CALLCONV cb_input_poll() {}
int16_t RETRO_CALLCONV cb_input_state(unsigned p, unsigned dev, unsigned i, unsigned id) {
    return g_host ? g_host->inputState(p, dev, i, id) : 0;
}
void RETRO_CALLCONV cb_log(enum retro_log_level level, const char* fmt, ...) {
    char buf[2048];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    std::string s(buf);
    while (!s.empty() && (s.back() == '\n' || s.back() == '\r')) s.pop_back();
    if (g_host && g_host->onLog) g_host->onLog(int(level), s);
}
}  // namespace

LibretroHost::LibretroHost() { g_host = this; }
LibretroHost::~LibretroHost() { stop(); if (g_host == this) g_host = nullptr; }

#ifdef DSLINK_WASM
// WebAssembly: the melonDS DS core is linked into this module, there is no dlopen; the libretro entry points are bound directly.
extern "C" {
void retro_set_environment(retro_environment_t); void retro_set_video_refresh(retro_video_refresh_t); void retro_set_audio_sample(retro_audio_sample_t);
void retro_set_audio_sample_batch(retro_audio_sample_batch_t); void retro_set_input_poll(retro_input_poll_t); void retro_set_input_state(retro_input_state_t);
void retro_init(void); void retro_deinit(void); unsigned retro_api_version(void); void retro_get_system_info(struct retro_system_info*);
void retro_get_system_av_info(struct retro_system_av_info*); bool retro_load_game(const struct retro_game_info*); void retro_unload_game(void); void retro_run(void);
void* retro_get_memory_data(unsigned); size_t retro_get_memory_size(unsigned);
}
bool LibretroHost::loadCore(const std::string&, std::string& err) {
    p_set_environment = retro_set_environment; p_set_video_refresh = retro_set_video_refresh; p_set_audio_sample = retro_set_audio_sample;
    p_set_audio_batch = retro_set_audio_sample_batch; p_set_input_poll = retro_set_input_poll; p_set_input_state = retro_set_input_state;
    p_init = retro_init; p_deinit = retro_deinit; p_api_version = retro_api_version; p_get_system_info = retro_get_system_info; p_get_av_info = retro_get_system_av_info;
    p_load_game = retro_load_game; p_unload_game = retro_unload_game; p_run = retro_run; p_mem_data = retro_get_memory_data; p_mem_size = retro_get_memory_size;
    if (p_api_version() != RETRO_API_VERSION) { err = "unsupported libretro API version " + std::to_string(p_api_version()); return false; }
    return true;
}
#else
template <typename T> static bool sym(void* lib, const char* n, T& out) {
    out = reinterpret_cast<T>(dlsym(lib, n));
    return out != nullptr;
}

bool LibretroHost::loadCore(const std::string& path, std::string& err) {
    lib_ = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
    if (!lib_) { err = std::string("dlopen: ") + dlerror(); return false; }
    bool ok = sym(lib_, "retro_set_environment", p_set_environment) && sym(lib_, "retro_set_video_refresh", p_set_video_refresh) &&
              sym(lib_, "retro_set_audio_sample", p_set_audio_sample) && sym(lib_, "retro_set_audio_sample_batch", p_set_audio_batch) &&
              sym(lib_, "retro_set_input_poll", p_set_input_poll) && sym(lib_, "retro_set_input_state", p_set_input_state) &&
              sym(lib_, "retro_init", p_init) && sym(lib_, "retro_deinit", p_deinit) && sym(lib_, "retro_api_version", p_api_version) &&
              sym(lib_, "retro_get_system_info", p_get_system_info) && sym(lib_, "retro_get_system_av_info", p_get_av_info) &&
              sym(lib_, "retro_load_game", p_load_game) && sym(lib_, "retro_unload_game", p_unload_game) && sym(lib_, "retro_run", p_run);
    sym(lib_, "retro_get_memory_data", p_mem_data);
    sym(lib_, "retro_get_memory_size", p_mem_size);
    if (!ok) { err = "core is missing mandatory libretro symbols"; dlclose(lib_); lib_ = nullptr; return false; }
    if (p_api_version() != RETRO_API_VERSION) { err = "unsupported libretro API version " + std::to_string(p_api_version()); return false; }
    return true;
}
#endif

void LibretroHost::loadOptionsFile() {
    std::lock_guard<std::mutex> l(optMu_);
    fileOptions_.clear();
    std::ifstream f(cfg_.optionsFile);
    std::istringstream text(cfg_.optionsText);
    std::istream& in = cfg_.optionsFile.empty() ? static_cast<std::istream&>(text) : static_cast<std::istream&>(f);
    std::string line;
    while (std::getline(in, line)) {
        if (line.empty() || line[0] == '#') continue;
        auto eq = line.find(" = ");
        if (eq == std::string::npos) continue;
        std::string k = line.substr(0, eq), v = line.substr(eq + 3);
        if (v.size() >= 2 && v.front() == '"' && v.back() == '"') v = v.substr(1, v.size() - 2);
        fileOptions_[k] = v;
    }
}

std::string LibretroHost::optionValue(const std::string& key) const {
    auto it = fileOptions_.find(key);
    if (it != fileOptions_.end()) return it->second;
    auto d = defaults_.find(key);
    return d == defaults_.end() ? std::string() : d->second;
}

bool LibretroHost::start(const HostConfig& cfg, std::string& err) {
    cfg_ = cfg;
    if (!cfg_.optionsFile.empty() || !cfg_.optionsText.empty()) loadOptionsFile();
    p_get_system_info(&sysinfo);  // library name/version, extensions, need_fullpath
    p_set_environment(cb_env);
    p_init();
    p_set_video_refresh(cb_video);
    p_set_audio_sample(cb_audio_sample);
    p_set_audio_batch(cb_audio_batch);
    p_set_input_poll(cb_input_poll);
    p_set_input_state(cb_input_state);
    started_ = true;

    retro_game_info gi{};
    retro_game_info* gp = nullptr;
    if (!cfg_.contentPath.empty()) {
        gi.path = cfg_.contentPath.c_str();
        if (cfg_.contentPtr && cfg_.contentSize) {
            gi.data = cfg_.contentPtr;
            gi.size = cfg_.contentSize;
        } else if (!sysinfo.need_fullpath) {
            std::ifstream f(cfg_.contentPath, std::ios::binary);
            if (!f) { err = "cannot read content " + cfg_.contentPath; return false; }
            contentData_.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
            gi.data = contentData_.data();
            gi.size = contentData_.size();
        }
        gp = &gi;
    } else if (!supportNoGame_) {
        err = "this core cannot start without content";
        return false;
    }
    if (!p_load_game(gp)) { err = "retro_load_game failed (see core log)"; return false; }
    gameLoaded_ = true;
    p_get_av_info(&av);
    metrics.width = av.geometry.base_width;
    metrics.height = av.geometry.base_height;
    metrics.fps = av.timing.fps;
    metrics.sampleRate = av.timing.sample_rate;

    // SRAM: <saveDir>/<content basename>.srm (or "no-content.srm")
    std::string base = "no-content";
    if (!cfg_.contentPath.empty()) {
        base = cfg_.contentPath.substr(cfg_.contentPath.find_last_of('/') + 1);
        auto dot = base.find_last_of('.');
        if (dot != std::string::npos) base = base.substr(0, dot);
    }
    // Same layout RetroArch uses for this core: <saves>/<core name>/<content>.srm
    std::string coreDir = cfg_.saveDir + "/" + (sysinfo.library_name ? sysinfo.library_name : "core");
    std::string mk = "mkdir -p '" + coreDir + "'";
    if (std::system(mk.c_str()) != 0) log(RETRO_LOG_WARN, "cannot create " + coreDir);
    saveFile_ = coreDir + "/" + base + ".srm";
    if (p_mem_data && p_mem_size) {
        size_t n = p_mem_size(RETRO_MEMORY_SAVE_RAM);
        void* m = p_mem_data(RETRO_MEMORY_SAVE_RAM);
        std::ifstream f(saveFile_, std::ios::binary);
        if (n && m && f) f.read(static_cast<char*>(m), std::streamsize(n));
    }
    return true;
}

size_t LibretroHost::sramSize() const { return p_mem_size ? p_mem_size(RETRO_MEMORY_SAVE_RAM) : 0; }

void LibretroHost::saveSram() {
    if (!gameLoaded_ || !p_mem_data || !p_mem_size) return;
    size_t n = p_mem_size(RETRO_MEMORY_SAVE_RAM);
    void* m = p_mem_data(RETRO_MEMORY_SAVE_RAM);
    if (!n || !m) return;
    std::string tmp = saveFile_ + ".tmp";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        f.write(static_cast<const char*>(m), std::streamsize(n));
        if (!f) return;
    }
    std::rename(tmp.c_str(), saveFile_.c_str());  // atomic: a kill during save cannot corrupt the previous save
}

void LibretroHost::runFrame() {
    p_run();
    ++metrics.frames;
}

void LibretroHost::stop() {
    if (gameLoaded_) { saveSram(); p_unload_game(); gameLoaded_ = false; }
    if (started_) { p_deinit(); started_ = false; }
#ifndef DSLINK_WASM
    if (lib_) { dlclose(lib_); lib_ = nullptr; }
#endif
}

void LibretroHost::videoRefresh(const void* data, unsigned w, unsigned h, size_t pitch) {
    if (!data) return;  // frame duplicated
    metrics.width = w;
    metrics.height = h;
    if (pixfmt_ == RETRO_PIXEL_FORMAT_XRGB8888 && onVideo) onVideo(static_cast<const uint8_t*>(data), w, h, pitch);
}

size_t LibretroHost::audioBatch(const int16_t* d, size_t frames) {
    metrics.audioSamples += frames;
    if (onAudio) onAudio(d, frames);
    return frames;
}

int16_t LibretroHost::inputState(unsigned port, unsigned device, unsigned index, unsigned id) {
    if (port >= unsigned(kPorts)) return 0;
    const InputState& in = input[port];
    switch (device & RETRO_DEVICE_MASK) {
        case RETRO_DEVICE_JOYPAD: {
            uint32_t b = in.buttons.load() | in.extraButtons.load();
            if (id == RETRO_DEVICE_ID_JOYPAD_MASK) return int16_t(b & 0xFFFF);
            return id < 16 ? int16_t((b >> id) & 1) : 0;
        }
        case RETRO_DEVICE_POINTER:
            if (index != 0) return 0;
            switch (id) {
                case RETRO_DEVICE_ID_POINTER_X: return int16_t(in.pointerX.load());
                case RETRO_DEVICE_ID_POINTER_Y: return int16_t(in.pointerY.load());
                case RETRO_DEVICE_ID_POINTER_PRESSED: return in.pointerDown.load() ? 1 : 0;
                default: return 0;
            }
        default: return 0;
    }
}

bool LibretroHost::environment(unsigned cmd, void* data) {
    switch (cmd & ~RETRO_ENVIRONMENT_EXPERIMENTAL & ~RETRO_ENVIRONMENT_PRIVATE) {
        case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
            static_cast<retro_log_callback*>(data)->log = cb_log;
            return true;
        case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
            *static_cast<const char**>(data) = cfg_.systemDir.c_str();
            return true;
        case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
            *static_cast<const char**>(data) = cfg_.saveDir.c_str();
            return true;
        case RETRO_ENVIRONMENT_GET_USERNAME:
            if (cfg_.username.empty()) return false;
            *static_cast<const char**>(data) = cfg_.username.c_str();
            return true;
        case RETRO_ENVIRONMENT_GET_LANGUAGE:
            *static_cast<unsigned*>(data) = cfg_.language;
            return true;
        case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT: {
            auto f = *static_cast<retro_pixel_format*>(data);
            if (f != RETRO_PIXEL_FORMAT_XRGB8888) return false;  // only what the encoder consumes
            pixfmt_ = f;
            return true;
        }
        case RETRO_ENVIRONMENT_SET_SUPPORT_NO_GAME:
            supportNoGame_ = *static_cast<bool*>(data);
            return true;
        case RETRO_ENVIRONMENT_GET_CORE_OPTIONS_VERSION:
            *static_cast<unsigned*>(data) = 2;
            return true;
        case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2: {
            auto* o = static_cast<const retro_core_options_v2*>(data);
            std::lock_guard<std::mutex> l(optMu_);
            for (auto* d = o->definitions; d && d->key; ++d) defaults_[d->key] = d->default_value ? d->default_value : (d->values[0].value ? d->values[0].value : "");
            return true;
        }
        case RETRO_ENVIRONMENT_SET_CORE_OPTIONS:
        case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_INTL:
        case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2_INTL:
        case RETRO_ENVIRONMENT_SET_VARIABLES:
            return true;  // options come from the file/defaults of V2; nothing else needed
        case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_DISPLAY:
        case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_UPDATE_DISPLAY_CALLBACK:
            return true;
        case RETRO_ENVIRONMENT_GET_VARIABLE: {
            auto* v = static_cast<retro_variable*>(data);
            std::lock_guard<std::mutex> l(optMu_);
            std::string val = optionValue(v->key);
            auto it = fileOptions_.find(v->key);
            if (it == fileOptions_.end() && defaults_.find(v->key) == defaults_.end()) return false;
            std::string& slot = valueStore_[v->key];  // node-based map: the pointer stays valid until the next read of this key
            slot = val;
            v->value = slot.c_str();
            return true;
        }
        case RETRO_ENVIRONMENT_SET_VARIABLE: {
            auto* v = static_cast<const retro_variable*>(data);
            if (!v || !v->key) return true;
            std::lock_guard<std::mutex> l(optMu_);
            if (v->value) fileOptions_[v->key] = v->value;
            optionsDirty_ = true;
            return true;
        }
        case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE: {
            std::lock_guard<std::mutex> l(optMu_);
            *static_cast<bool*>(data) = optionsDirty_;
            optionsDirty_ = false;
            return true;
        }
        case RETRO_ENVIRONMENT_GET_INPUT_BITMASKS:
            return true;
        case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
        case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
        case RETRO_ENVIRONMENT_SET_CONTENT_INFO_OVERRIDE:
        case RETRO_ENVIRONMENT_SET_SUBSYSTEM_INFO:
        case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
        case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
        case RETRO_ENVIRONMENT_SET_PROC_ADDRESS_CALLBACK:
        case RETRO_ENVIRONMENT_SET_FRAME_TIME_CALLBACK:
        case RETRO_ENVIRONMENT_SET_ROTATION:
        case RETRO_ENVIRONMENT_SET_GEOMETRY:
        case RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO:
            if (cmd == RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO || cmd == RETRO_ENVIRONMENT_SET_GEOMETRY) {
                if (cmd == RETRO_ENVIRONMENT_SET_SYSTEM_AV_INFO) av = *static_cast<retro_system_av_info*>(data);
                else av.geometry = *static_cast<retro_game_geometry*>(data);
            }
            return true;
        case RETRO_ENVIRONMENT_SET_MESSAGE:
            if (auto* m = static_cast<const retro_message*>(data)) log(RETRO_LOG_INFO, std::string("[message] ") + (m->msg ? m->msg : ""));
            return true;
        case RETRO_ENVIRONMENT_GET_MESSAGE_INTERFACE_VERSION:
            *static_cast<unsigned*>(data) = 1;
            return true;
        case RETRO_ENVIRONMENT_SET_MESSAGE_EXT:
            if (auto* m = static_cast<const retro_message_ext*>(data)) log(RETRO_LOG_INFO, std::string("[message] ") + (m->msg ? m->msg : ""));
            return true;
        case RETRO_ENVIRONMENT_GET_DEVICE_POWER: {
            auto* p = static_cast<retro_device_power*>(data);
            p->state = RETRO_POWERSTATE_PLUGGED_IN;
            p->seconds = RETRO_POWERSTATE_NO_ESTIMATE;
            p->percent = 100;
            return true;
        }
        case RETRO_ENVIRONMENT_GET_TARGET_REFRESH_RATE:
            *static_cast<float*>(data) = 60.0f;
            return true;
        case RETRO_ENVIRONMENT_GET_FASTFORWARDING:
            *static_cast<bool*>(data) = false;
            return true;
        case RETRO_ENVIRONMENT_SET_FASTFORWARDING_OVERRIDE:
            return true;
        case RETRO_ENVIRONMENT_GET_THROTTLE_STATE: {
            auto* t = static_cast<retro_throttle_state*>(data);
            t->mode = RETRO_THROTTLE_NONE;
            t->rate = 0.0f;
            return true;
        }
        case RETRO_ENVIRONMENT_GET_INPUT_DEVICE_CAPABILITIES:
            *static_cast<uint64_t*>(data) = (1ull << RETRO_DEVICE_JOYPAD) | (1ull << RETRO_DEVICE_POINTER);
            return true;
        case RETRO_ENVIRONMENT_SET_NETPACKET_INTERFACE:
            netpacket_ = *static_cast<const retro_netpacket_callback*>(data);
            return true;
        case RETRO_ENVIRONMENT_SHUTDOWN:
            shutdown_ = true;
            return true;
        // Deliberately not provided (the core falls back, verified against RetroArch's identical log lines):
        // VFS (core uses libretro-common defaults), HW render (software renderer), rumble, sensors, microphone (silence),
        // software framebuffer, camera, location.
        default:
            ++metrics.envUnhandled;
            log(RETRO_LOG_DEBUG, "[env] unhandled command " + std::to_string(cmd));
            return false;
    }
}

}  // namespace dsrt
