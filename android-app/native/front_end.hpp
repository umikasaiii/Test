// Platform-neutral front-end half of the Android app: reads what the DSLink Runtime publishes in shared memory (raw frames, audio ring, status) and
// writes what the user does (buttons, touch, pause, quit). No Android API in here, so it is unit-tested on the desktop (tests/fe_test.cpp) against a
// real Runtime; renderer.cpp / audio_out.cpp / jni_bridge.cpp add EGL, AAudio and JNI on top.
#pragma once
#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

#include "shm_layout.hpp"

namespace dsfe {

struct AudioStats {
    uint64_t underruns = 0;   // callbacks that had to be padded with silence after playback had started
    uint64_t skips = 0;       // times the reader fell too far behind and jumped ahead (no runaway latency)
    uint64_t pulled = 0;      // frames delivered
};

struct RuntimeStatus {
    double fps = 0, frameMs = 0, slowestMs = 0;
    unsigned peers = 0;
    uint64_t frames = 0;
    bool alive = false;
};

class ShmReader {
public:
    ShmReader() = default;
    ~ShmReader() { close(); }
    ShmReader(const ShmReader&) = delete;
    ShmReader& operator=(const ShmReader&) = delete;

    // maps an existing file (the Runtime creates it); false while it does not exist or has no valid header yet
    bool open(const std::string& path);
    void close();
    bool isOpen() const { return H() != nullptr; }
    bool valid() const;          // magic + version
    uint32_t session() const;    // changes when a new Runtime re-creates the channel: callers re-sync their cursors
    bool alive() const;

    // video: copies the newest complete frame if it is newer than the last one returned (seqlock; false = nothing new or torn read)
    bool copyLatest(std::vector<uint8_t>& xrgb, uint32_t& w, uint32_t& h);
    uint64_t framesPublished() const;

    // audio: fills 'frames' stereo frames (zero padded). Keeps a small cushion before it starts (priming) and jumps ahead instead of drifting.
    static constexpr uint32_t kPrefill = 1024, kTarget = 2048, kMaxLag = 9000;
    size_t pullAudio(int16_t* out, size_t frames);
    uint32_t sampleRate() const;
    AudioStats audioStats() const { return stats_; }
    void resetAudio();

    // input / control (any thread)
    void setButton(int retroId, bool down);
    void setTouch(float x, float y, bool down);
    void setPaused(bool paused);
    void requestQuit();
    uint32_t buttons() const;

    RuntimeStatus status() const;

private:
    dsrt::shm::Header* H() const { return hdr_.load(std::memory_order_acquire); }
    std::atomic<dsrt::shm::Header*> hdr_{nullptr};   // set last by open(): input/status calls from other threads see a fully mapped channel or none
    uint8_t* base_ = nullptr;
    int fd_ = -1;
    uint64_t lastFrame_ = 0;
    uint32_t vSession_ = 0, aSession_ = 0;   // video (render thread) and audio (AAudio thread) each track the session on their own
    bool primed_ = false;
    AudioStats stats_;
};

// RetroPad name used by the touch controls ("a", "up", "l2" ...) -> libretro joypad id, -1 if unknown (same table as the gateway's padID)
int padId(const std::string& name);

}  // namespace dsfe
