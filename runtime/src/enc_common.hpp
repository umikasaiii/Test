// Platform-neutral pieces of the Android stream encoder (MediaCodec H.264 + Opus). Everything here is plain C++ and unit-tested on the desktop
// (runtime/tests/enc_test.cpp); only the NDK codec itself (mediacodec_codec.cpp) needs Android.
#pragma once
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace dsrt {

// ---- colour conversion: core frame (XRGB8888, little endian = bytes B,G,R,X) -> 4:2:0 YUV in the layout/strides the codec asked for
enum class YuvLayout { NV12, I420 };  // NV12: Y plane + interleaved UV plane. I420: Y, U, V planes.

struct YuvDst {
    uint8_t* base = nullptr;
    int stride = 0;       // bytes per row of the Y plane (chroma rows: NV12 = stride, I420 = stride / 2)
    int sliceHeight = 0;  // rows of the Y plane before the chroma plane starts
    YuvLayout layout = YuvLayout::NV12;
    int w = 0, h = 0;     // picture size (even)
};

size_t yuvBufferSize(const YuvDst& d);  // bytes the codec must offer: stride * sliceHeight * 3 / 2
// BT.601, limited range (what a browser assumes for a stream without colour metadata at this size). The source is point-sampled to w x h
// (integer upscales stay crisp), chroma averages each 2x2 block.
void xrgbToYuv(const uint8_t* src, unsigned srcW, unsigned srcH, size_t pitch, const YuvDst& dst);

// ---- audio: the core's rate -> 48 kHz (cubic interpolation), stereo int16
class StereoResampler {
public:
    explicit StereoResampler(double inRate, int outRate = 48000);
    void process(const int16_t* in, size_t frames, std::vector<int16_t>& out);  // appends interleaved stereo to out
private:
    double step_, pos_ = 0;       // input frames advanced per output frame; fractional read position inside hist_
    std::vector<int16_t> hist_;   // interleaved stereo: the unconsumed tail of the input, starting 1 frame before the read position
    bool primed_ = false;
};

// ---- H.264 Annex-B helpers
bool annexbHasType(const uint8_t* d, size_t n, int nalType);   // any NAL of that type (7 = SPS, 8 = PPS, 5 = IDR slice)
std::vector<uint8_t> annexbParamSets(const uint8_t* d, size_t n);  // the SPS+PPS NALs of a buffer (with start codes), empty if none

// ---- statistics over the last full second
struct EncStats {
    uint64_t in = 0, out = 0, dropped = 0, bytes = 0, keyframes = 0;
    double fps = 0, kbps = 0, latAvgMs = 0, latMaxMs = 0, convertMs = 0;
};

class RateWindow {  // accumulates, rolls over once per second
public:
    void frame(double nowS, size_t bytes, double latMs);
    void convert(double ms) { convSum_ += ms; ++convN_; }
    EncStats snapshot() const { return last_; }
private:
    double t0_ = 0, latSum_ = 0, latMax_ = 0, convSum_ = 0;
    uint64_t n_ = 0, convN_ = 0, bytes_ = 0;
    EncStats last_;
};

}  // namespace dsrt
