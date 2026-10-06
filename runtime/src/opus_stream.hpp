// Opus encoder for the Android Runtime's stream (libopus built from the pinned submodule; FFmpeg is not part of the Android build).
// The core's audio (its own rate, interleaved stereo int16) is resampled to 48 kHz and cut into 20 ms packets, like the FFmpeg path does on the desktop.
#pragma once
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "enc_common.hpp"

struct OpusEncoder;

namespace dsrt {

class OpusStream {
public:
    using Sink = std::function<void(const uint8_t* packet, size_t n, uint64_t ptsUs)>;
    ~OpusStream();
    bool open(double coreRate, int kbps, std::string& err);
    void push(const int16_t* stereo, size_t frames);
    Sink onPacket;
    uint64_t packets() const { return packets_; }

private:
    OpusEncoder* enc_ = nullptr;
    std::unique_ptr<StereoResampler> rs_;
    std::vector<int16_t> pending_;  // resampled, waiting for a full 960-frame packet
    uint64_t packets_ = 0;
    int64_t t0_ = 0;
};

}  // namespace dsrt
