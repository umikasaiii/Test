// AAudio output of the Runtime's audio ring (Android only). Low-latency shared stream; the DS' native sample rate (~32.7 kHz) is handed to AAudio,
// which resamples if the device needs it. The data callback only copies from the ring (ShmReader::pullAudio): no allocation, no locks.
#pragma once
#include <aaudio/AAudio.h>

#include <atomic>
#include <cstdint>

#include "front_end.hpp"

namespace dsfe {

struct AudioMetrics {
    bool running = false;
    uint32_t rate = 0;
    uint64_t underruns = 0, skips = 0, xruns = 0, restarts = 0;
    double latencyMs = 0;
};

class AudioOut {
public:
    explicit AudioOut(ShmReader& r) : reader_(r) {}
    ~AudioOut() { stop(); }
    bool start(uint32_t sampleRate);
    void stop();
    bool running() const { return stream_ != nullptr; }
    uint32_t rate() const { return rate_; }
    void setPaused(bool p);        // app in the background / audio focus lost
    AudioMetrics metrics() const;
    // called from the stream callbacks
    aaudio_data_callback_result_t onData(void* data, int32_t frames);
    void onError(aaudio_result_t err);

private:
    ShmReader& reader_;
    AAudioStream* stream_ = nullptr;
    uint32_t rate_ = 0;
    std::atomic<bool> paused_{false};
    std::atomic<uint64_t> restarts_{0};
};

}  // namespace dsfe
