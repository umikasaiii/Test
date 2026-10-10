// DSLink Runtime - minimal libretro host. Implements exactly what the melonDS DS core (and similar cores) needs:
// environment callbacks, video/audio/input callbacks, core options, system/save dirs, SRAM, netpacket interface.
// Deliberately NOT RetroArch: no menu, playlists, shaders, achievements, rewind, recording UI...
#pragma once
#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <vector>

#include "libretro.h"

namespace dsrt {

struct HostConfig {
    std::string corePath;
    std::string contentPath;  // empty = boot without content (when the core supports it)
    std::string systemDir, saveDir;
    std::string optionsFile;  // "key = \"value\"" lines (same format DSLink already generates for RetroArch)
    std::string optionsText;  // the same lines given directly (WebAssembly build: no file system detour); used when optionsFile is empty
    const uint8_t* contentPtr = nullptr;  // content already in memory (WebAssembly build): used instead of reading contentPath, no copy is kept
    size_t contentSize = 0;
    std::string username;     // RETRO_ENVIRONMENT_GET_USERNAME -> melonDS derives the DS MAC from it
    unsigned language = RETRO_LANGUAGE_ENGLISH;
    // PlaySphere multi-core: cores other than melonDS DS (PlayStation) need more of the libretro environment. Off by default: the melonDS DS paths (Android, desktop, WebAssembly NDS)
    // behave exactly as before. On: RGB565/0RGB1555 frames are converted to XRGB8888, V1 core options give their first value as default, and disk control, rumble, analog input and
    // save states are available.
    bool extendedEnv = false;
};

// RetroPad + touch state written by the control link and read by the core during retro_run.
struct InputState {
    std::atomic<uint32_t> buttons{0};  // bit i = RETRO_DEVICE_ID_JOYPAD_i (per port)
    std::atomic<uint32_t> extraButtons{0};  // same bits from a second source (the local front end's shared memory): OR-ed in, never clobbers the control link's presses
    std::atomic<bool> pointerDown{false};
    std::atomic<int> pointerX{0}, pointerY{0};  // libretro range -32767..32767 over the full video frame
    std::atomic<int> analog[4]{{0}, {0}, {0}, {0}};  // left X, left Y, right X, right Y: -32768..32767 (extendedEnv cores: RETRO_DEVICE_ANALOG)
};

struct Metrics {
    std::atomic<uint64_t> frames{0}, audioSamples{0}, envUnhandled{0};
    std::atomic<uint32_t> width{0}, height{0};
    std::atomic<double> fps{0}, sampleRate{0};
};

class LibretroHost {
public:
    static constexpr int kPorts = 4;
    LibretroHost();
    ~LibretroHost();

    bool loadCore(const std::string& path, std::string& err);
    // Runs retro_init, loads the content (or none) and reads the AV info. Fills 'err' on failure.
    bool start(const HostConfig& cfg, std::string& err);
    void runFrame();  // input poll + retro_run
    void stop();      // save SRAM, unload game, deinit, dlclose

    // sinks
    std::function<void(const uint8_t*, unsigned w, unsigned h, size_t pitch)> onVideo;  // XRGB8888
    std::function<void(const int16_t*, size_t frames)> onAudio;                          // interleaved stereo
    std::function<void(int level, const std::string&)> onLog;

    InputState input[kPorts];
    Metrics metrics;
    retro_system_av_info av{};
    retro_system_info sysinfo{};
    bool supportsNoGame() const { return supportNoGame_; }
    bool shutdownRequested() const { return shutdown_.load(); }
    bool hasNetpacket() const { return netpacket_.start != nullptr; }
    const retro_netpacket_callback& netpacket() const { return netpacket_; }
    void saveSram();
    size_t sramSize() const;
    // ---- extendedEnv only (PlayStation): disc images, rumble, save states
    bool hasDiskControl() const { return disk_.set_eject_state != nullptr; }
    unsigned diskCount() const { return disk_.get_num_images ? disk_.get_num_images() : 0; }
    unsigned diskIndex() const { return disk_.get_image_index ? disk_.get_image_index() : 0; }
    bool diskEjected() const { return disk_.get_eject_state ? disk_.get_eject_state() : false; }
    bool diskSetEject(bool e) { return disk_.set_eject_state ? disk_.set_eject_state(e) : false; }
    bool diskSetIndex(unsigned i) { return disk_.set_image_index ? disk_.set_image_index(i) : false; }
    bool diskAdd() { return disk_.add_image_index ? disk_.add_image_index() : false; }
    bool diskReplace(unsigned i, const std::string& path);
    std::atomic<int> rumble[kPorts][2]{};  // last strength (0..65535) of the strong / weak motor per port
    void setControllerDevice(unsigned port, unsigned device) { if (p_set_controller) p_set_controller(port, device); }
    size_t stateSize() const { return p_ser_size ? p_ser_size() : 0; }
    bool stateSave(void* dst, size_t n) { return p_ser && p_ser(dst, n); }
    bool stateLoad(const void* src, size_t n) { return p_unser && p_unser(src, n); }
    std::string optionValue(const std::string& key) const;

    // libretro callbacks (static trampolines -> instance)
    bool environment(unsigned cmd, void* data);
    void videoRefresh(const void* data, unsigned w, unsigned h, size_t pitch);
    size_t audioBatch(const int16_t* data, size_t frames);
    void inputPoll() {}
    int16_t inputState(unsigned port, unsigned device, unsigned index, unsigned id);

private:
    void loadOptionsFile();
    void log(int level, const std::string& s) { if (onLog) onLog(level, s); }

    void* lib_ = nullptr;
    HostConfig cfg_;
    bool started_ = false, gameLoaded_ = false, supportNoGame_ = false;
    std::atomic<bool> shutdown_{false};
    std::map<std::string, std::string> fileOptions_, defaults_;
    std::mutex optMu_;
    bool optionsDirty_ = true;
    retro_netpacket_callback netpacket_{};
    retro_pixel_format pixfmt_ = RETRO_PIXEL_FORMAT_0RGB1555;
    std::vector<uint8_t> contentData_;
    std::vector<uint8_t> convBuf_;                 // extendedEnv: RGB565 / 0RGB1555 -> XRGB8888
    retro_disk_control_callback disk_{};
    retro_disk_control_ext_callback diskExt_{};
    std::string saveFile_;
    std::map<std::string, std::string> valueStore_;

    // dlsym'ed entry points
    void (*p_set_environment)(retro_environment_t) = nullptr;
    void (*p_set_video_refresh)(retro_video_refresh_t) = nullptr;
    void (*p_set_audio_sample)(retro_audio_sample_t) = nullptr;
    void (*p_set_audio_batch)(retro_audio_sample_batch_t) = nullptr;
    void (*p_set_input_poll)(retro_input_poll_t) = nullptr;
    void (*p_set_input_state)(retro_input_state_t) = nullptr;
    void (*p_init)() = nullptr;
    void (*p_deinit)() = nullptr;
    unsigned (*p_api_version)() = nullptr;
    void (*p_get_system_info)(retro_system_info*) = nullptr;
    void (*p_get_av_info)(retro_system_av_info*) = nullptr;
    bool (*p_load_game)(const retro_game_info*) = nullptr;
    void (*p_unload_game)() = nullptr;
    void (*p_run)() = nullptr;
    void* (*p_mem_data)(unsigned) = nullptr;
    size_t (*p_mem_size)(unsigned) = nullptr;
    void (*p_set_controller)(unsigned, unsigned) = nullptr;
    size_t (*p_ser_size)() = nullptr;
    bool (*p_ser)(void*, size_t) = nullptr;
    bool (*p_unser)(const void*, size_t) = nullptr;
};

}  // namespace dsrt
