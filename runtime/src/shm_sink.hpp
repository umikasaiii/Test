// Runtime side of the shared-memory front-end channel (see shm_layout.hpp).
#pragma once
#include <string>

#include "shm_layout.hpp"

namespace dsrt {

class ShmSink {
public:
    ShmSink() = default;
    ~ShmSink();
    ShmSink(const ShmSink&) = delete;
    ShmSink& operator=(const ShmSink&) = delete;

    bool open(const std::string& path, std::string& err);  // creates/truncates the file, maps it, initialises the header
    void close();                                          // marks the Runtime as stopped and unmaps
    bool isOpen() const { return hdr_ != nullptr; }

    void pushVideo(const uint8_t* xrgb, unsigned w, unsigned h, size_t pitch);
    void pushAudio(const int16_t* stereo, size_t frames, unsigned sampleRate);

    // front end -> Runtime
    uint32_t buttons() const { return hdr_ ? hdr_->buttons.load(std::memory_order_relaxed) : 0; }
    // returns true when the touch state changed since the last call
    bool takeTouch(bool& down, float& x, float& y);
    bool paused() const { return hdr_ && hdr_->paused.load(std::memory_order_relaxed) != 0; }
    bool quitRequested() const { return hdr_ && hdr_->quit.load(std::memory_order_relaxed) != 0; }

    void publishStatus(double fps, double avgFrameMs, double slowestMs, unsigned mpPeers, uint64_t frames);

private:
    shm::Header* hdr_ = nullptr;
    uint8_t* base_ = nullptr;
    int fd_ = -1;
    uint32_t lastTouchSeq_ = 0;
};

}  // namespace dsrt
