#include "mc_encoder.hpp"

#include <chrono>
#include <cstring>

namespace dsrt {

McVideoEncoder::McVideoEncoder(std::unique_ptr<H264Codec> codec) : codec_(std::move(codec)) {}
McVideoEncoder::~McVideoEncoder() { close(); }

int64_t McVideoEncoder::nowUs() const {
    return std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count() - t0_;
}

bool McVideoEncoder::open(unsigned outW, unsigned outH, int fps, int kbps, int keyintSec, std::string& err) {
    if (!codec_) { err = "no H.264 codec on this platform"; return false; }
    if (outW < 16 || outH < 16 || (outW & 1) || (outH & 1)) { err = "bad output size"; return false; }
    if (!codec_->open(int(outW), int(outH), fps, kbps, keyintSec, err)) return false;
    w_ = outW; h_ = outH;
    t0_ = std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
    forceKey_ = true;  // the very first picture is a keyframe (some codecs only start one on request)
    quit_ = false;
    opened_ = true;
    th_ = std::thread([this] { loop(); });
    return true;
}

void McVideoEncoder::close() {
    if (!opened_.exchange(false)) return;
    { std::lock_guard<std::mutex> l(mu_); quit_ = true; }
    cv_.notify_all();
    if (th_.joinable()) th_.join();
    codec_->close();
}

void McVideoEncoder::push(const uint8_t* xrgb, unsigned w, unsigned h, size_t pitch) {
    if (!opened_ || !xrgb || !w || !h) return;
    std::lock_guard<std::mutex> l(mu_);
    if (has_) ++dropped_;  // the encoder did not take the previous picture yet: it is replaced by the newer one
    box_.resize(size_t(w) * h * 4);
    for (unsigned y = 0; y < h; ++y) std::memcpy(box_.data() + size_t(y) * w * 4, xrgb + size_t(y) * pitch, size_t(w) * 4);
    boxW_ = w; boxH_ = h; boxPts_ = nowUs();
    has_ = true;
    ++inN_;
    cv_.notify_one();
}

void McVideoEncoder::loop() {
    while (true) {
        bool got = false;
        unsigned w = 0, h = 0;
        int64_t pts = 0;
        {
            std::unique_lock<std::mutex> l(mu_);
            cv_.wait_for(l, std::chrono::milliseconds(4), [&] { return has_ || quit_; });
            if (quit_) break;
            if (has_) { work_.swap(box_); w = boxW_; h = boxH_; pts = boxPts_; has_ = false; got = true; }
        }
        if (got) feed(work_, w, h, pts);
        drain(got ? 5000 : 2000);
    }
}

void McVideoEncoder::feed(const std::vector<uint8_t>& frame, unsigned w, unsigned h, int64_t ptsUs) {
    const int idx = codec_->dequeueInput(8000);
    if (idx < 0) { ++dropped_; return; }  // the codec is behind: this picture is lost, the stream goes on with the next one
    if (forceKey_.exchange(false)) codec_->requestSync();
    size_t cap = 0;
    uint8_t* buf = codec_->inputBuffer(idx, cap);
    YuvDst d;
    d.base = buf; d.stride = codec_->stride(); d.sliceHeight = codec_->sliceHeight(); d.layout = codec_->layout(); d.w = int(w_); d.h = int(h_);
    const size_t need = yuvBufferSize(d);
    if (!buf || need > cap) { ++dropped_; return; }
    const auto t = std::chrono::steady_clock::now();
    xrgbToYuv(frame.data(), w, h, size_t(w) * 4, d);
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t).count();
    { std::lock_guard<std::mutex> l(statMu_); win_.convert(ms); }
    codec_->queueInput(idx, need, ptsUs);
}

void McVideoEncoder::drain(int firstTimeoutUs) {
    for (int i = 0; i < 8; ++i) {
        CodecOutput o;
        const int r = codec_->dequeueOutput(o, i == 0 ? firstTimeoutUs : 0);
        if (r <= 0) break;
        if (o.data.empty()) continue;
        if (o.config) {
            auto ps = annexbParamSets(o.data.data(), o.data.size());
            csd_ = ps.empty() ? o.data : ps;
            continue;
        }
        const bool hasSps = annexbHasType(o.data.data(), o.data.size(), 7);
        const bool key = o.key || annexbHasType(o.data.data(), o.data.size(), 5);
        if (hasSps && csd_.empty()) csd_ = annexbParamSets(o.data.data(), o.data.size());
        std::vector<uint8_t> au;
        const std::vector<uint8_t>* out = &o.data;
        if (key && !hasSps && !csd_.empty()) {  // a keyframe a browser can start from must carry its own SPS/PPS
            au = csd_;
            au.insert(au.end(), o.data.begin(), o.data.end());
            out = &au;
        }
        const double lat = double(nowUs() - o.ptsUs) / 1000.0;
        ++outN_; bytes_ += out->size(); if (key) ++keys_;
        { std::lock_guard<std::mutex> l(statMu_); win_.frame(double(nowUs()) / 1e6, out->size(), lat < 0 ? 0 : lat); }
        if (onVideo) onVideo(out->data(), out->size(), key, uint64_t(o.ptsUs));
    }
}

EncStats McVideoEncoder::stats() const {
    EncStats s;
    { std::lock_guard<std::mutex> l(statMu_); s = win_.snapshot(); }
    s.in = inN_; s.out = outN_; s.dropped = dropped_; s.bytes = bytes_; s.keyframes = keys_;
    return s;
}

}  // namespace dsrt
