#include "enc_common.hpp"

#include <algorithm>
#include <cstring>

namespace dsrt {

size_t yuvBufferSize(const YuvDst& d) { return size_t(d.stride) * size_t(d.sliceHeight) * 3 / 2; }

namespace {
inline uint8_t clamp8(int v) { return uint8_t(v < 0 ? 0 : (v > 255 ? 255 : v)); }
}  // namespace

void xrgbToYuv(const uint8_t* src, unsigned srcW, unsigned srcH, size_t pitch, const YuvDst& d) {
    if (!src || !d.base || srcW == 0 || srcH == 0 || d.w < 2 || d.h < 2) return;
    std::vector<uint32_t> xoff(size_t(d.w));  // byte offset of the source pixel of every output column (point sampling)
    for (int x = 0; x < d.w; ++x) xoff[size_t(x)] = uint32_t((uint64_t(x) * srcW / uint64_t(d.w)) * 4);
    uint8_t* yPlane = d.base;
    uint8_t* chroma = d.base + size_t(d.stride) * size_t(d.sliceHeight);
    const int cStride = d.layout == YuvLayout::NV12 ? d.stride : d.stride / 2;
    uint8_t* uPlane = chroma;
    uint8_t* vPlane = chroma + size_t(cStride) * size_t(d.sliceHeight / 2);
    for (int y = 0; y < d.h; y += 2) {
        const uint8_t* s0 = src + size_t(uint64_t(y) * srcH / uint64_t(d.h)) * pitch;
        const uint8_t* s1 = src + size_t(uint64_t(y + 1) * srcH / uint64_t(d.h)) * pitch;
        uint8_t* y0 = yPlane + size_t(y) * size_t(d.stride);
        uint8_t* y1 = y0 + d.stride;
        uint8_t* cRow = (d.layout == YuvLayout::NV12 ? chroma : uPlane) + size_t(y / 2) * size_t(cStride);
        uint8_t* vRow = vPlane + size_t(y / 2) * size_t(cStride);
        for (int x = 0; x < d.w; x += 2) {
            const uint8_t* p[4] = {s0 + xoff[size_t(x)], s0 + xoff[size_t(x + 1)], s1 + xoff[size_t(x)], s1 + xoff[size_t(x + 1)]};
            int rs = 0, gs = 0, bs = 0;
            for (int k = 0; k < 4; ++k) {
                const int b = p[k][0], g = p[k][1], r = p[k][2];
                const int yy = ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
                (k < 2 ? y0 : y1)[x + (k & 1)] = clamp8(yy);
                rs += r; gs += g; bs += b;
            }
            const int r = (rs + 2) >> 2, g = (gs + 2) >> 2, b = (bs + 2) >> 2;
            const uint8_t u = clamp8(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
            const uint8_t v = clamp8(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
            if (d.layout == YuvLayout::NV12) { cRow[x] = u; cRow[x + 1] = v; }
            else { cRow[x / 2] = u; vRow[x / 2] = v; }
        }
    }
}

StereoResampler::StereoResampler(double inRate, int outRate) : step_(inRate > 1 ? inRate / double(outRate) : 1.0) {}

void StereoResampler::process(const int16_t* in, size_t frames, std::vector<int16_t>& out) {
    if (!frames) return;
    hist_.insert(hist_.end(), in, in + frames * 2);
    if (!primed_) { hist_.insert(hist_.begin(), 2, int16_t(0)); primed_ = true; pos_ = 1.0; }  // one silent frame before the first sample: the cubic needs p0
    const size_t n = hist_.size() / 2;
    while (pos_ + 2.0 < double(n)) {
        const size_t i = size_t(pos_);
        const double t = pos_ - double(i);
        for (int ch = 0; ch < 2; ++ch) {
            const double p0 = hist_[(i - 1) * 2 + size_t(ch)], p1 = hist_[i * 2 + size_t(ch)], p2 = hist_[(i + 1) * 2 + size_t(ch)], p3 = hist_[(i + 2) * 2 + size_t(ch)];
            const double v = 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
            out.push_back(int16_t(v < -32768 ? -32768 : (v > 32767 ? 32767 : v)));
        }
        pos_ += step_;
    }
    const size_t drop = size_t(pos_) >= 1 ? size_t(pos_) - 1 : 0;  // keep the frame before the read position
    hist_.erase(hist_.begin(), hist_.begin() + std::ptrdiff_t(drop * 2));
    pos_ -= double(drop);
}

namespace {
// calls f(nalStart, nalEnd) for every NAL of an Annex-B buffer (start codes excluded)
template <class F> void eachNal(const uint8_t* d, size_t n, F f) {
    size_t i = 0, start = size_t(-1);
    while (i + 3 <= n) {
        if (d[i] == 0 && d[i + 1] == 0 && d[i + 2] == 1) {
            if (start != size_t(-1)) { size_t e = i; while (e > start && d[e - 1] == 0) --e; f(start, e); }
            start = i + 3;
            i += 3;
        } else {
            ++i;
        }
    }
    if (start != size_t(-1) && start < n) f(start, n);
}
}  // namespace

bool annexbHasType(const uint8_t* d, size_t n, int type) {
    bool found = false;
    eachNal(d, n, [&](size_t s, size_t) { if (int(d[s] & 0x1f) == type) found = true; });
    return found;
}

std::vector<uint8_t> annexbParamSets(const uint8_t* d, size_t n) {
    std::vector<uint8_t> out;
    eachNal(d, n, [&](size_t s, size_t e) {
        const int t = d[s] & 0x1f;
        if (t == 7 || t == 8) { out.insert(out.end(), {0, 0, 0, 1}); out.insert(out.end(), d + s, d + e); }
    });
    return out;
}

void RateWindow::frame(double nowS, size_t bytes, double latMs) {
    if (t0_ == 0) t0_ = nowS;
    ++n_; bytes_ += bytes; latSum_ += latMs; if (latMs > latMax_) latMax_ = latMs;
    if (nowS - t0_ >= 1.0) {
        const double dt = nowS - t0_;
        last_.fps = double(n_) / dt;
        last_.kbps = double(bytes_) * 8.0 / 1000.0 / dt;
        last_.latAvgMs = n_ ? latSum_ / double(n_) : 0;
        last_.latMaxMs = latMax_;
        last_.convertMs = convN_ ? convSum_ / double(convN_) : 0;
        t0_ = nowS; n_ = bytes_ = convN_ = 0; latSum_ = latMax_ = convSum_ = 0;
    }
}

}  // namespace dsrt
