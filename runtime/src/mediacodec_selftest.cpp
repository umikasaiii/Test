// dslink-runtime --encoder-selftest: what the stream encoder does on THIS device, without any game or network. Synthetic frames go through the very same McVideoEncoder the
// Hosted mode uses (the device's MediaCodec H.264 encoder: hardware when the SoC has one), the access units come back out of it, are decoded again with the device's decoder
// and the decoded picture is compared with what was fed in. Prints one JSON line; exit code 0 = pass. The emulator tests run it with the software codecs, the developer menu
// of the app runs it on a phone: a layout/colour/stride problem of a vendor codec shows up here instead of as a garbled picture on the guest's screen.
#include "mc_encoder.hpp"

#include <cstdio>

#if defined(__ANDROID__) && defined(DSLINK_WITH_MEDIACODEC)
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaFormat.h>

#include <chrono>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <thread>

namespace dsrt {
namespace {

struct Au { std::vector<uint8_t> d; bool key; uint64_t pts; };

// quadrants: red | green over blue | white, plus a bar that moves so every frame differs
void paint(std::vector<uint8_t>& f, unsigned w, unsigned h, int frame) {
    f.assign(size_t(w) * h * 4, 0);
    for (unsigned y = 0; y < h; ++y) for (unsigned x = 0; x < w; ++x) {
        const bool right = x >= w / 2, bottom = y >= h / 2;
        uint8_t r = 0, g = 0, b = 0;
        if (!right && !bottom) r = 220; else if (right && !bottom) g = 200; else if (!right && bottom) b = 220; else r = g = b = 235;
        if (y < 6 && x / 8 == unsigned(frame * 3) % (w / 8)) r = g = b = 20;  // a dark bar along the top edge that moves, so every frame differs (the sampled quadrant centres stay clear of it)
        uint8_t* p = &f[(size_t(y) * w + x) * 4];
        p[0] = b; p[1] = g; p[2] = r; p[3] = 0;
    }
}

int ex(int r, int g, int b, int plane) {  // BT.601 limited range
    if (plane == 0) return ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16;
    if (plane == 1) return ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128;
    return ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128;
}

// decodes the access units with the device's decoder and checks the quadrant centres of the last decoded picture
const char* decodeCheck(const std::vector<Au>& aus, unsigned w, unsigned h, std::string& decoderInfo) {
    AMediaCodec* dec = AMediaCodec_createDecoderByType("video/avc");
    if (!dec) return "no_decoder";
    AMediaFormat* f = AMediaFormat_new();
    AMediaFormat_setString(f, "mime", "video/avc");
    AMediaFormat_setInt32(f, "width", int(w));
    AMediaFormat_setInt32(f, "height", int(h));
    if (AMediaCodec_configure(dec, f, nullptr, nullptr, 0) != AMEDIA_OK || AMediaCodec_start(dec) != AMEDIA_OK) { AMediaFormat_delete(f); AMediaCodec_delete(dec); return "decoder_config"; }
    AMediaFormat_delete(f);
    int colorFmt = 0, stride = int(w), slice = int(h), decoded = 0;
    std::vector<uint8_t> last;
    size_t next = 0;
    const auto t0 = std::chrono::steady_clock::now();
    bool eos = false;
    while (std::chrono::steady_clock::now() - t0 < std::chrono::seconds(6) && !(eos && decoded > 0)) {
        if (next < aus.size()) {
            const ssize_t i = AMediaCodec_dequeueInputBuffer(dec, 2000);
            if (i >= 0) {
                size_t cap = 0;
                uint8_t* b = AMediaCodec_getInputBuffer(dec, size_t(i), &cap);
                const auto& au = aus[next];
                if (b && au.d.size() <= cap) {
                    std::memcpy(b, au.d.data(), au.d.size());
                    AMediaCodec_queueInputBuffer(dec, size_t(i), 0, au.d.size(), uint64_t(next) * 16666, 0);
                }
                ++next;
            }
        } else if (!eos) {
            const ssize_t i = AMediaCodec_dequeueInputBuffer(dec, 2000);
            if (i >= 0) { AMediaCodec_queueInputBuffer(dec, size_t(i), 0, 0, uint64_t(next) * 16666, 4 /*END_OF_STREAM*/); eos = true; }
        }
        AMediaCodecBufferInfo info{};
        const ssize_t o = AMediaCodec_dequeueOutputBuffer(dec, &info, 2000);
        if (o >= 0) {
            size_t cap = 0;
            uint8_t* p = AMediaCodec_getOutputBuffer(dec, size_t(o), &cap);
            if (p && info.size > 0) { last.assign(p + info.offset, p + info.offset + info.size); ++decoded; }
            AMediaCodec_releaseOutputBuffer(dec, size_t(o), false);
            if (info.flags & 4) break;
        } else if (o == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {
            AMediaFormat* of = AMediaCodec_getOutputFormat(dec);
            if (of) {
                int32_t v = 0;
                if (AMediaFormat_getInt32(of, "color-format", &v)) colorFmt = v;
                if (AMediaFormat_getInt32(of, "stride", &v) && v > 0) stride = v;
                if (AMediaFormat_getInt32(of, "slice-height", &v) && v > 0) slice = v;
                AMediaFormat_delete(of);
            }
        }
    }
    AMediaCodec_stop(dec);
    AMediaCodec_delete(dec);
    decoderInfo = "color " + std::to_string(colorFmt) + " stride " + std::to_string(stride) + " slice " + std::to_string(slice) + " pictures " + std::to_string(decoded);
    if (!decoded || last.empty()) return "no_output";
    const bool planar = colorFmt == 19, semi = colorFmt == 21 || colorFmt == 0x7F420888;
    if (!planar && !semi) return "skipped_vendor_format";  // e.g. a tiled vendor layout: the encoder side is still checked
    if (slice < int(h)) slice = int(h);
    struct Q { unsigned x, y; int r, g, b; } q[4] = {{w / 4, h / 4, 220, 0, 0}, {3 * w / 4, h / 4, 0, 200, 0}, {w / 4, 3 * h / 4, 0, 0, 220}, {3 * w / 4, 3 * h / 4, 235, 235, 235}};
    for (const auto& c : q) {
        const size_t yo = size_t(c.y) * stride + c.x;
        const size_t cb = size_t(stride) * slice;
        int Y = 0, U = 0, V = 0;
        if (yo >= last.size()) return "short_buffer";
        Y = last[yo];
        if (semi) {
            const size_t co = cb + size_t(c.y / 2) * stride + (c.x / 2) * 2;
            if (co + 1 >= last.size()) return "short_buffer";
            U = last[co]; V = last[co + 1];
        } else {
            const size_t cs = size_t(stride) / 2, uo = cb + size_t(c.y / 2) * cs + c.x / 2, vo = cb + cs * size_t(slice / 2) + size_t(c.y / 2) * cs + c.x / 2;
            if (vo >= last.size()) return "short_buffer";
            U = last[uo]; V = last[vo];
        }
        if (std::abs(Y - ex(c.r, c.g, c.b, 0)) > 28 || std::abs(U - ex(c.r, c.g, c.b, 1)) > 28 || std::abs(V - ex(c.r, c.g, c.b, 2)) > 28) return "mismatch";
    }
    return "ok";
}

}  // namespace

namespace {
struct One { bool pass = false, hw = false; std::string json; };

// one stream: its own McVideoEncoder (= its own MediaCodec instance), 150 synthetic frames at 60 fps, then the decode check
One runOne(unsigned w, unsigned h, int index) {
    One r;
    McVideoEncoder enc(makeMediaCodecH264());
    std::string err;
    char b[1024];
    if (!enc.open(w, h, 60, 2500, 2, err)) {
        std::snprintf(b, sizeof b, "{\"stream\":%d,\"pass\":false,\"error\":\"%s\"}", index, err.c_str());
        r.json = b;
        return r;
    }
    std::mutex mu;
    std::vector<Au> aus;
    enc.onVideo = [&](const uint8_t* d, size_t n, bool key, uint64_t pts) { std::lock_guard<std::mutex> l(mu); aus.push_back({std::vector<uint8_t>(d, d + n), key, pts}); };
    std::vector<uint8_t> frame;
    const int N = 150;
    for (int i = 0; i < N; ++i) {
        paint(frame, w, h, i + index * 7);
        enc.push(frame.data(), w, h, size_t(w) * 4);
        std::this_thread::sleep_for(std::chrono::microseconds(16667));
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(600));
    EncStats st = enc.stats();
    const std::string name = enc.codecName();
    r.hw = enc.hardware();
    std::vector<Au> got;
    { std::lock_guard<std::mutex> l(mu); got = aus; }
    enc.close();
    const bool firstKeyOk = !got.empty() && got[0].key && annexbHasType(got[0].d.data(), got[0].d.size(), 7) && annexbHasType(got[0].d.data(), got[0].d.size(), 8) && annexbHasType(got[0].d.data(), got[0].d.size(), 5);
    uint64_t bytes = 0;
    int keys = 0;
    for (auto& a : got) { bytes += a.d.size(); keys += a.key ? 1 : 0; }
    std::string dinfo;
    const std::string dec = got.empty() ? "no_output" : decodeCheck(got, w, h, dinfo);
    r.pass = firstKeyOk && got.size() >= size_t(N) * 8 / 10 && (dec == "ok" || dec == "skipped_vendor_format");
    std::snprintf(b, sizeof b, "{\"stream\":%d,\"pass\":%s,\"codec\":\"%s\",\"hardware\":%s,\"w\":%u,\"h\":%u,\"in\":%d,\"out\":%zu,\"keys\":%d,\"firstKeyframeHasSpsPpsIdr\":%s,\"encFps\":%.1f,\"latMs\":%.1f,\"latMaxMs\":%.1f,\"kbps\":%.0f,\"avgFrameBytes\":%llu,\"dropped\":%llu,\"decode\":\"%s\",\"decodeInfo\":\"%s\"}",
                  index, r.pass ? "true" : "false", name.c_str(), r.hw ? "true" : "false", w, h, N, got.size(), keys, firstKeyOk ? "true" : "false", st.fps, st.latAvgMs, st.latMaxMs, st.kbps,
                  (unsigned long long)(got.empty() ? 0 : bytes / got.size()), (unsigned long long)st.dropped, dec.c_str(), dinfo.c_str());
    r.json = b;
    return r;
}
}  // namespace

// streams > 1: that many encoders run AT THE SAME TIME (a Hosted game with two guests needs two): the report says whether every one of them opened and ran, and whether all are hardware
int runEncoderSelfTest(unsigned w, unsigned h, int streams) {
    if (streams < 1) streams = 1;
    if (streams > 3) streams = 3;
    std::vector<One> res(static_cast<size_t>(streams));
    std::vector<std::thread> th;
    for (int i = 0; i < streams; ++i) th.emplace_back([&, i] { res[size_t(i)] = runOne(w, h, i); });
    for (auto& t : th) t.join();
    bool pass = true, hwAll = true;
    std::string arr;
    for (size_t i = 0; i < res.size(); ++i) { pass = pass && res[i].pass; hwAll = hwAll && res[i].hw; arr += (i ? "," : "") + res[i].json; }
    std::printf("{\"pass\":%s,\"concurrent\":%d,\"hardwareAll\":%s,\"streams\":[%s]}\n", pass ? "true" : "false", streams, hwAll ? "true" : "false", arr.c_str());
    return pass ? 0 : 1;
}

}  // namespace dsrt
#else
namespace dsrt {
int runEncoderSelfTest(unsigned, unsigned, int) { std::printf("{\"pass\":false,\"error\":\"this Runtime has no MediaCodec encoder\"}\n"); return 2; }
}  // namespace dsrt
#endif
