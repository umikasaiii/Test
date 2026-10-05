// DSLink Runtime A/V pipeline: core framebuffer (XRGB8888) -> swscale -> H.264 (libx264 via libavcodec),
// core audio (interleaved s16) -> swresample -> Opus 48 kHz. No screen capture, no extra process: frames go from the core's
// video callback straight into the encoder; encoded access units / packets are handed to a sink (the gateway link).
#pragma once
#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

struct AVCodecContext;
struct AVFrame;
struct AVPacket;
struct SwsContext;
struct SwrContext;

namespace dsrt {

struct AvConfig {
    unsigned outW = 512, outH = 768;  // fixed output size (DS: 2x the two stacked screens); any core frame size is scaled to it
    int fps = 60;
    int videoKbps = 2500;
    int keyintFrames = 60;
};

class AvPipeline {
public:
    using VideoSink = std::function<void(const uint8_t* annexB, size_t n, bool key, uint64_t ptsUs)>;
    using AudioSink = std::function<void(const uint8_t* opus, size_t n, uint64_t ptsUs)>;
    AvPipeline();
    ~AvPipeline();

    bool open(const AvConfig& cfg, double coreSampleRate, std::string& err);
    void pushVideo(const uint8_t* xrgb, unsigned w, unsigned h, size_t pitch);
    void pushAudio(const int16_t* stereo, size_t frames);
    void requestKeyframe() { forceKey_ = true; }
    void flush();

    VideoSink onVideo;
    AudioSink onAudio;
    // latest raw frame (RGB24) for diagnostics / parity tests; copy-on-read
    bool latestRgb(std::vector<uint8_t>& out, unsigned& w, unsigned& h);
    uint64_t videoFrames() const { return vFrames_; }
    uint64_t videoBytes() const { return vBytes_; }
    uint64_t audioPackets() const { return aPackets_; }

private:
    AvConfig cfg_;
    AVCodecContext* venc_ = nullptr;
    AVCodecContext* aenc_ = nullptr;
    AVFrame* vframe_ = nullptr;
    AVFrame* aframe_ = nullptr;
    AVPacket* pkt_ = nullptr;
    SwsContext* sws_ = nullptr;
    SwrContext* swr_ = nullptr;
    unsigned srcW_ = 0, srcH_ = 0;
    std::vector<int16_t> aq_;  // resampled 48 kHz stereo, waiting for 960-sample frames
    int64_t vpts_ = 0, apts_ = 0;
    std::atomic_bool forceKey_{false};
    uint64_t vFrames_ = 0, vBytes_ = 0, aPackets_ = 0;
    std::mutex rawMu_;
    std::vector<uint8_t> raw_;
    unsigned rawW_ = 0, rawH_ = 0;
    int64_t t0Us_ = 0;
    void encodeVideo(AVFrame* f);
    void drainAudio();
};

}  // namespace dsrt
