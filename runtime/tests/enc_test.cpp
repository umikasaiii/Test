// Desktop test of the Android stream encoder's platform-neutral half: colour conversion into codec-chosen layouts, the 48 kHz resampler, Annex-B helpers,
// the encoder front (mailbox, keyframes, SPS/PPS on keyframes, drop counting) against a fake codec, and the Opus path against the real libopus.
#include <opus.h>

#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <thread>

#include "mc_encoder.hpp"
#include "opus_stream.hpp"

using namespace dsrt;
static int fails = 0, checks = 0;
#define CHECK(c, ...) do { ++checks; if (!(c)) { ++fails; std::printf("FAIL %s:%d  %s  ", __FILE__, __LINE__, #c); std::printf(__VA_ARGS__); std::printf("\n"); } } while (0)

static std::vector<uint8_t> solid(unsigned w, unsigned h, int r, int g, int b) {
    std::vector<uint8_t> f(size_t(w) * h * 4);
    for (size_t i = 0; i < size_t(w) * h; ++i) { f[i * 4] = uint8_t(b); f[i * 4 + 1] = uint8_t(g); f[i * 4 + 2] = uint8_t(r); f[i * 4 + 3] = 0; }
    return f;
}
static int expY(int r, int g, int b) { return ((66 * r + 129 * g + 25 * b + 128) >> 8) + 16; }
static int expU(int r, int g, int b) { return ((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128; }
static int expV(int r, int g, int b) { return ((112 * r - 94 * g - 18 * b + 128) >> 8) + 128; }

// ---------------------------------------------------------------- conversion
static void testConversion() {
    const int W = 64, H = 48, STR = 96, SLICE = 64;
    struct C { int r, g, b; } cols[] = {{255, 0, 0}, {0, 255, 0}, {0, 0, 255}, {255, 255, 255}, {0, 0, 0}, {200, 120, 30}};
    for (YuvLayout lay : {YuvLayout::NV12, YuvLayout::I420}) {
        for (auto c : cols) {
            std::vector<uint8_t> buf(size_t(STR) * SLICE * 3 / 2, 0xAA);
            YuvDst d; d.base = buf.data(); d.stride = STR; d.sliceHeight = SLICE; d.layout = lay; d.w = W; d.h = H;
            auto src = solid(32, 24, c.r, c.g, c.b);  // 2x upscale
            xrgbToYuv(src.data(), 32, 24, 32 * 4, d);
            const uint8_t* ch = buf.data() + size_t(STR) * SLICE;
            const int cs = lay == YuvLayout::NV12 ? STR : STR / 2;
            for (int y : {0, 1, H - 1}) for (int x : {0, 1, W - 1}) CHECK(buf[size_t(y) * STR + x] == expY(c.r, c.g, c.b), "Y(%d,%d)=%d want %d", x, y, buf[size_t(y) * STR + x], expY(c.r, c.g, c.b));
            for (int y : {0, H / 2 - 1}) for (int x : {0, W / 2 - 1}) {
                int u, v;
                if (lay == YuvLayout::NV12) { u = ch[size_t(y) * cs + 2 * x]; v = ch[size_t(y) * cs + 2 * x + 1]; }
                else { u = ch[size_t(y) * cs + x]; v = ch[size_t(SLICE / 2) * cs + size_t(y) * cs + x]; }
                CHECK(std::abs(u - expU(c.r, c.g, c.b)) <= 1 && std::abs(v - expV(c.r, c.g, c.b)) <= 1, "UV(%d,%d)=%d,%d want %d,%d lay=%d", x, y, u, v, expU(c.r, c.g, c.b), expV(c.r, c.g, c.b), int(lay));
            }
            CHECK(buf[W] == 0xAA && buf[STR - 1] == 0xAA, "padding of the Y rows is not touched");  // row padding left alone
        }
    }
    // point sampling: a half-and-half picture keeps its edge at the right column after a 2x upscale
    std::vector<uint8_t> src(size_t(8) * 4 * 4);
    for (int y = 0; y < 4; ++y) for (int x = 0; x < 8; ++x) { uint8_t v = x < 4 ? 255 : 0; uint8_t* p = &src[(size_t(y) * 8 + x) * 4]; p[0] = p[1] = p[2] = v; }
    std::vector<uint8_t> buf(size_t(16) * 8 * 3 / 2);
    YuvDst d; d.base = buf.data(); d.stride = 16; d.sliceHeight = 8; d.layout = YuvLayout::NV12; d.w = 16; d.h = 8;
    xrgbToYuv(src.data(), 8, 4, 8 * 4, d);
    CHECK(buf[7] == 235 && buf[8] == 16, "edge at the middle: %d %d", buf[7], buf[8]);
}

// ---------------------------------------------------------------- resampler
static void testResampler() {
    const double inRate = 32728.0;
    StereoResampler rs(inRate);
    std::vector<int16_t> out;
    const size_t total = 32728 * 2;  // 2 s, fed in uneven chunks like a core does
    size_t fed = 0, k = 0;
    while (fed < total) {
        size_t n = std::min<size_t>(500 + (k++ * 37) % 100, total - fed);
        std::vector<int16_t> in(n * 2);
        for (size_t i = 0; i < n; ++i) { double s = 12000.0 * std::sin(2 * M_PI * 1000.0 * double(fed + i) / inRate); in[i * 2] = int16_t(s); in[i * 2 + 1] = int16_t(-s); }
        rs.process(in.data(), n, out);
        fed += n;
    }
    const size_t frames = out.size() / 2;
    CHECK(std::abs(double(frames) - 96000.0) < 8, "2 s of audio -> %zu frames at 48 kHz", frames);
    int crossings = 0, peak = 0;
    for (size_t i = 100; i + 1 < frames; ++i) { if ((out[i * 2] < 0) != (out[(i + 1) * 2] < 0)) ++crossings; peak = std::max(peak, std::abs(int(out[i * 2]))); }
    CHECK(std::abs(crossings - 4000) < 12, "1 kHz stays 1 kHz (%d crossings in ~2 s)", crossings);
    CHECK(peak > 11500 && peak < 12600, "level kept (peak %d)", peak);
    CHECK(out[2000] == -out[2001] || std::abs(out[2000] + out[2001]) < 3, "channels stay separate");
}

// ---------------------------------------------------------------- Annex-B
static void testAnnexB() {
    std::vector<uint8_t> au = {0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 1, 0x68, 9, 9, 0, 0, 0, 1, 0x65, 5, 5, 5, 5};
    CHECK(annexbHasType(au.data(), au.size(), 7) && annexbHasType(au.data(), au.size(), 8) && annexbHasType(au.data(), au.size(), 5), "SPS/PPS/IDR found");
    CHECK(!annexbHasType(au.data(), au.size(), 1), "no P slice");
    auto ps = annexbParamSets(au.data(), au.size());
    const std::vector<uint8_t> want = {0, 0, 0, 1, 0x67, 1, 2, 3, 0, 0, 0, 1, 0x68, 9, 9};
    CHECK(ps == want, "parameter sets extracted with 4-byte start codes (%zu bytes)", ps.size());
}

// ---------------------------------------------------------------- fake codec + encoder front
struct Seen { int y, u, v; bool key; int64_t pts; };
struct FakeCodec : H264Codec {
    int W = 0, H = 0, str = 0, slice = 0;
    std::vector<uint8_t> in;
    std::deque<CodecOutput> q;
    std::mutex mu;
    std::condition_variable cv;
    std::atomic_bool syncNext{false}, blockInput{false}, noPrepend{true};
    std::vector<Seen> seen;
    int count = 0;
    YuvLayout lay = YuvLayout::NV12;
    bool open(int w, int h, int, int, int, std::string&) override {
        W = w; H = h; str = w + 32; slice = h + 16; in.assign(size_t(str) * slice * 3 / 2, 0);
        CodecOutput c; c.config = true; c.data = {0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80};
        q.push_back(c);
        return true;
    }
    YuvLayout layout() const override { return lay; }
    int stride() const override { return str; }
    int sliceHeight() const override { return slice; }
    std::string name() const override { return "fake.h264.encoder"; }
    bool hardware() const override { return false; }
    int dequeueInput(int) override { return blockInput ? -1 : 0; }
    uint8_t* inputBuffer(int, size_t& cap) override { cap = in.size(); return in.data(); }
    bool queueInput(int, size_t, int64_t pts) override {
        Seen s; s.y = in[0]; const uint8_t* ch = in.data() + size_t(str) * slice;
        if (lay == YuvLayout::NV12) { s.u = ch[0]; s.v = ch[1]; } else { s.u = ch[0]; s.v = ch[size_t(str / 2) * (slice / 2)]; }
        const bool wanted = syncNext.exchange(false); s.key = count == 0 || wanted; s.pts = pts;
        CodecOutput o; o.ptsUs = pts; o.key = s.key;
        o.data = {0, 0, 0, 1, uint8_t(s.key ? 0x65 : 0x41), uint8_t(s.y), 7, 7};
        std::lock_guard<std::mutex> l(mu);
        seen.push_back(s); q.push_back(o); ++count; cv.notify_all();
        return true;
    }
    int dequeueOutput(CodecOutput& out, int timeoutUs) override {
        std::unique_lock<std::mutex> l(mu);
        if (q.empty()) cv.wait_for(l, std::chrono::microseconds(timeoutUs), [&] { return !q.empty(); });
        if (q.empty()) return 0;
        out = q.front(); q.pop_front();
        return 1;
    }
    void requestSync() override { syncNext = true; }
    void close() override {}
};

static void sleepMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

static void testEncoder() {
    for (YuvLayout lay : {YuvLayout::NV12, YuvLayout::I420}) {
        auto fc = std::make_unique<FakeCodec>();
        FakeCodec* f = fc.get();
        f->lay = lay;
        McVideoEncoder enc(std::move(fc));
        std::string err;
        CHECK(enc.open(64, 96, 60, 2000, 2, err), "open: %s", err.c_str());
        std::mutex om; std::vector<std::pair<bool, std::vector<uint8_t>>> got; std::vector<uint64_t> pts;
        enc.onVideo = [&](const uint8_t* d, size_t n, bool key, uint64_t p) { std::lock_guard<std::mutex> l(om); got.push_back({key, std::vector<uint8_t>(d, d + n)}); pts.push_back(p); };
        for (int i = 0; i < 20; ++i) {
            auto fr = solid(64, 96, (i * 12) % 256, 40, 200);
            enc.push(fr.data(), 64, 96, 64 * 4);
            sleepMs(12);
            if (i == 10) enc.requestKey();
        }
        sleepMs(150);
        {
            std::lock_guard<std::mutex> l(om);
            CHECK(got.size() == 20, "20 pictures encoded, got %zu", got.size());
            CHECK(!got.empty() && got[0].first, "first picture is a keyframe");
            if (!got.empty()) {
                CHECK(annexbHasType(got[0].second.data(), got[0].second.size(), 7) && annexbHasType(got[0].second.data(), got[0].second.size(), 8), "keyframe carries SPS+PPS even though the codec only sent them as config");
                CHECK(got[0].second.size() > 16 && got[0].second[0] == 0 && got[0].second[4] == 0x67, "SPS comes first");
            }
            int keys = 0; for (auto& g : got) keys += g.first;
            CHECK(keys == 2, "one keyframe at the start + one requested (got %d)", keys);
            bool mono = true; for (size_t i = 1; i < pts.size(); ++i) mono = mono && pts[i] > pts[i - 1];
            CHECK(mono, "timestamps increase");
            bool pOk = true; for (size_t i = 1; i < got.size(); ++i) if (!got[i].first) pOk = pOk && !annexbHasType(got[i].second.data(), got[i].second.size(), 7);
            CHECK(pOk, "delta frames do not repeat parameter sets");
        }
        {
            std::lock_guard<std::mutex> l(f->mu);
            for (size_t i = 0; i < f->seen.size(); ++i) {
                const int r = int(i) * 12 % 256;
                CHECK(std::abs(f->seen[i].y - expY(r, 40, 200)) <= 1 && std::abs(f->seen[i].u - expU(r, 40, 200)) <= 1 && std::abs(f->seen[i].v - expV(r, 40, 200)) <= 1,
                      "frame %zu planes in the codec's layout (lay=%d): y=%d u=%d v=%d want %d %d %d", i, int(lay), f->seen[i].y, f->seen[i].u, f->seen[i].v, expY(r, 40, 200), expU(r, 40, 200), expV(r, 40, 200));
            }
        }
        EncStats st = enc.stats();
        CHECK(st.in == 20 && st.out == 20 && st.dropped == 0, "stats in=%llu out=%llu dropped=%llu", (unsigned long long)st.in, (unsigned long long)st.out, (unsigned long long)st.dropped);
        enc.close();
    }
    // a codec that takes no input: pictures are dropped and counted, the emulation thread (push) never blocks
    auto fc = std::make_unique<FakeCodec>();
    FakeCodec* f = fc.get();
    McVideoEncoder enc(std::move(fc));
    std::string err;
    enc.open(64, 96, 60, 2000, 2, err);
    f->blockInput = true;
    auto t0 = std::chrono::steady_clock::now();
    for (int i = 0; i < 40; ++i) { auto fr = solid(64, 96, 1, 2, 3); enc.push(fr.data(), 64, 96, 256); }
    const double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
    CHECK(ms < 80, "push never waits for the encoder (%.1f ms for 40)", ms);
    sleepMs(200);
    CHECK(enc.stats().dropped >= 30, "dropped frames are counted (%llu)", (unsigned long long)enc.stats().dropped);
    f->blockInput = false;
    enc.close();
}

// ---------------------------------------------------------------- Opus
static void testOpus() {
    OpusStream os;
    std::string err;
    CHECK(os.open(32728.0, 96, err), "opus open %s", err.c_str());
    std::vector<std::vector<uint8_t>> pk;
    os.onPacket = [&](const uint8_t* d, size_t n, uint64_t) { pk.emplace_back(d, d + n); };
    const size_t total = 32728;  // 1 s
    for (size_t fed = 0; fed < total;) {
        const size_t n = std::min<size_t>(546, total - fed);
        std::vector<int16_t> in(n * 2);
        for (size_t i = 0; i < n; ++i) { double s = 10000.0 * std::sin(2 * M_PI * 440.0 * double(fed + i) / 32728.0); in[i * 2] = int16_t(s); in[i * 2 + 1] = int16_t(s / 2); }
        os.push(in.data(), n);
        fed += n;
    }
    CHECK(pk.size() >= 48 && pk.size() <= 51, "1 s -> %zu packets of 20 ms", pk.size());
    int e = 0;
    OpusDecoder* dec = opus_decoder_create(48000, 2, &e);
    double sum = 0; size_t cnt = 0;
    std::vector<int16_t> pcm(960 * 2);
    for (size_t i = 5; i < pk.size(); ++i) {
        const int n = opus_decode(dec, pk[i].data(), int(pk[i].size()), pcm.data(), 960, 0);
        CHECK(n == 960, "decodes to 960 frames");
        for (int k = 0; k < n; ++k) { sum += double(pcm[size_t(k) * 2]) * pcm[size_t(k) * 2]; ++cnt; }
    }
    opus_decoder_destroy(dec);
    const double rms = std::sqrt(sum / double(cnt ? cnt : 1));
    CHECK(rms > 6000 && rms < 8200, "decoded level matches the input (rms %.0f, input 7071)", rms);
}

int main() {
    testConversion();
    testResampler();
    testAnnexB();
    testEncoder();
    testOpus();
    std::printf("%s: %d checks, %d failed\n", fails ? "FAIL" : "PASS", checks, fails);
    return fails ? 1 : 0;
}
