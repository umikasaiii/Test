// H.264 stream encoder for the Android Runtime. The codec itself (Android MediaCodec through the NDK, hardware when the device has it) sits behind
// H264Codec; this class owns the rest: a one-slot mailbox so the emulation thread never waits for the encoder, the colour conversion into whatever
// layout the codec asked for, SPS/PPS repeated on every keyframe (a browser that joins late or asks for a refresh must be able to start decoding),
// keyframe requests, and the numbers the developer overlay shows (encoder fps, latency, bitrate, dropped frames).
#pragma once
#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "enc_common.hpp"

namespace dsrt {

struct CodecOutput {
    std::vector<uint8_t> data;  // Annex-B
    int64_t ptsUs = 0;
    bool key = false;     // the codec flagged a sync frame
    bool config = false;  // codec-specific data (SPS/PPS), not a picture
};

class H264Codec {
public:
    virtual ~H264Codec() = default;
    virtual bool open(int w, int h, int fps, int kbps, int keyintSec, std::string& err) = 0;
    virtual YuvLayout layout() const = 0;
    virtual int stride() const = 0;
    virtual int sliceHeight() const = 0;
    virtual std::string name() const = 0;
    virtual bool hardware() const = 0;  // false when the device only offers a software codec (or the name is unknown)
    virtual int dequeueInput(int timeoutUs) = 0;                          // buffer index, -1 = none free in time, -2 = error
    virtual uint8_t* inputBuffer(int idx, size_t& capacity) = 0;
    virtual bool queueInput(int idx, size_t size, int64_t ptsUs) = 0;
    virtual int dequeueOutput(CodecOutput& out, int timeoutUs) = 0;       // 1 = got one, 0 = nothing yet, -1 = error
    virtual void requestSync() = 0;                                       // the next frame becomes a keyframe
    virtual void close() = 0;
};

std::unique_ptr<H264Codec> makeMediaCodecH264();  // Android: the NDK MediaCodec; elsewhere nullptr
int runEncoderSelfTest(unsigned w, unsigned h, int streams);   // dslink-runtime --encoder-selftest [--streams N]: N encoders at once encode synthetic frames, each is decoded again, one JSON line (0 = pass)

class McVideoEncoder {
public:
    using Sink = std::function<void(const uint8_t* annexB, size_t n, bool key, uint64_t ptsUs)>;
    explicit McVideoEncoder(std::unique_ptr<H264Codec> codec);
    ~McVideoEncoder();

    bool open(unsigned outW, unsigned outH, int fps, int kbps, int keyintSec, std::string& err);
    void push(const uint8_t* xrgb, unsigned w, unsigned h, size_t pitch);  // copies the frame and returns at once; a frame still waiting is replaced (counted as dropped)
    void requestKey() { forceKey_ = true; }
    void close();

    Sink onVideo;
    EncStats stats() const;
    std::string codecName() const { return codec_ ? codec_->name() : ""; }
    bool hardware() const { return codec_ && codec_->hardware(); }
    unsigned width() const { return w_; }
    unsigned height() const { return h_; }

private:
    void loop();
    void feed(const std::vector<uint8_t>& frame, unsigned w, unsigned h, int64_t ptsUs);
    void drain(int firstTimeoutUs);
    int64_t nowUs() const;

    std::unique_ptr<H264Codec> codec_;
    unsigned w_ = 0, h_ = 0;
    std::thread th_;
    std::atomic_bool quit_{false}, forceKey_{false}, opened_{false};
    std::mutex mu_;
    std::condition_variable cv_;
    std::vector<uint8_t> box_, work_;
    unsigned boxW_ = 0, boxH_ = 0;
    int64_t boxPts_ = 0;
    bool has_ = false;
    std::vector<uint8_t> csd_;  // SPS+PPS as the codec delivered them
    int64_t t0_ = 0;
    mutable std::mutex statMu_;
    std::atomic<uint64_t> inN_{0}, outN_{0}, dropped_{0}, bytes_{0}, keys_{0};
    RateWindow win_;
};

}  // namespace dsrt
