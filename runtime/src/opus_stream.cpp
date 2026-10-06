#include "opus_stream.hpp"

#include <opus.h>

#include <chrono>

namespace dsrt {

OpusStream::~OpusStream() { if (enc_) opus_encoder_destroy(enc_); }

bool OpusStream::open(double coreRate, int kbps, std::string& err) {
    int e = 0;
    enc_ = opus_encoder_create(48000, 2, OPUS_APPLICATION_RESTRICTED_LOWDELAY, &e);  // the same choice as the FFmpeg path ("lowdelay")
    if (!enc_ || e != OPUS_OK) { err = std::string("opus: ") + opus_strerror(e); enc_ = nullptr; return false; }
    opus_encoder_ctl(enc_, OPUS_SET_BITRATE(kbps * 1000));
    rs_ = std::make_unique<StereoResampler>(coreRate, 48000);
    t0_ = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
    return true;
}

void OpusStream::push(const int16_t* stereo, size_t frames) {
    if (!enc_ || !frames) return;
    rs_->process(stereo, frames, pending_);
    uint8_t out[1500];
    size_t used = 0;
    while (pending_.size() - used >= 960 * 2) {
        const int n = opus_encode(enc_, pending_.data() + used, 960, out, int(sizeof out));
        used += 960 * 2;
        if (n > 0) {
            ++packets_;
            const int64_t now = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
            if (onPacket) onPacket(out, size_t(n), uint64_t(now - t0_));
        }
    }
    pending_.erase(pending_.begin(), pending_.begin() + std::ptrdiff_t(used));
}

}  // namespace dsrt
