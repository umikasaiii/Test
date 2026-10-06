// The Android MediaCodec H.264 encoder through the NDK (libmediandk), used by the Runtime that streams a console to another device (Hosted mode).
// The system picks the default AVC encoder, which on a phone is the SoC's hardware block (the codec's name tells: c2.android.* / OMX.google.* are software).
// Input is a ByteBuffer in the layout the codec reports (NV12 or I420, its own stride/slice height), so no vendor-specific assumptions are baked in.
#include "mc_encoder.hpp"

#if defined(__ANDROID__) && defined(DSLINK_WITH_MEDIACODEC)
#include <dlfcn.h>
#include <media/NdkMediaCodec.h>
#include <media/NdkMediaFormat.h>

#include <cstring>

namespace dsrt {
namespace {

constexpr int kColorYuv420Planar = 19, kColorYuv420SemiPlanar = 21, kColorYuv420Flexible = 0x7F420888;
constexpr uint32_t kFlagSync = 1, kFlagConfig = 2;  // BUFFER_FLAG_SYNC_FRAME / BUFFER_FLAG_CODEC_CONFIG

// API 28 symbols, looked up at run time: the app supports Android 8 (API 26), these only improve what we report
using GetInputFormatFn = AMediaFormat* (*)(AMediaCodec*);
using GetNameFn = media_status_t (*)(AMediaCodec*, char**);
using ReleaseNameFn = void (*)(char*);

class McCodec : public H264Codec {
public:
    ~McCodec() override { close(); }

    bool open(int w, int h, int fps, int kbps, int keyintSec, std::string& err) override {
        std::string last;
        for (int fmt : {kColorYuv420SemiPlanar, kColorYuv420Planar, kColorYuv420Flexible}) {
            for (int mode : {2 /*CBR*/, 1 /*VBR*/}) {
                if (tryOpen(w, h, fps, kbps, keyintSec, fmt, mode, last)) return true;
                close();
            }
        }
        err = "MediaCodec H.264 encoder: " + last;
        return false;
    }

    YuvLayout layout() const override { return layout_; }
    int stride() const override { return stride_; }
    int sliceHeight() const override { return slice_; }
    std::string name() const override { return name_; }
    bool hardware() const override { return hw_; }

    int dequeueInput(int timeoutUs) override {
        const ssize_t i = AMediaCodec_dequeueInputBuffer(c_, timeoutUs);
        return i >= 0 ? int(i) : (i == AMEDIACODEC_INFO_TRY_AGAIN_LATER ? -1 : -2);
    }
    uint8_t* inputBuffer(int idx, size_t& cap) override { cap = 0; return AMediaCodec_getInputBuffer(c_, size_t(idx), &cap); }
    bool queueInput(int idx, size_t size, int64_t ptsUs) override { return AMediaCodec_queueInputBuffer(c_, size_t(idx), 0, size, uint64_t(ptsUs), 0) == AMEDIA_OK; }

    int dequeueOutput(CodecOutput& out, int timeoutUs) override {
        AMediaCodecBufferInfo info{};
        const ssize_t i = AMediaCodec_dequeueOutputBuffer(c_, &info, timeoutUs);
        if (i >= 0) {
            size_t cap = 0;
            uint8_t* p = AMediaCodec_getOutputBuffer(c_, size_t(i), &cap);
            if (p && info.size > 0 && size_t(info.offset) + size_t(info.size) <= cap) out.data.assign(p + info.offset, p + info.offset + info.size);
            else out.data.clear();
            out.ptsUs = info.presentationTimeUs;
            out.config = (info.flags & kFlagConfig) != 0;
            out.key = (info.flags & kFlagSync) != 0;
            AMediaCodec_releaseOutputBuffer(c_, size_t(i), false);
            return 1;
        }
        if (i == AMEDIACODEC_INFO_OUTPUT_FORMAT_CHANGED) {  // csd-0 / csd-1 = SPS / PPS (already Annex-B)
            AMediaFormat* f = AMediaCodec_getOutputFormat(c_);
            out.data.clear(); out.config = true; out.key = false; out.ptsUs = 0;
            for (const char* k : {"csd-0", "csd-1"}) {
                void* d = nullptr; size_t n = 0;
                if (f && AMediaFormat_getBuffer(f, k, &d, &n) && d && n) out.data.insert(out.data.end(), static_cast<uint8_t*>(d), static_cast<uint8_t*>(d) + n);
            }
            if (f) AMediaFormat_delete(f);
            return out.data.empty() ? 0 : 1;
        }
        return i == AMEDIACODEC_INFO_TRY_AGAIN_LATER || i == AMEDIACODEC_INFO_OUTPUT_BUFFERS_CHANGED ? 0 : -1;
    }

    void requestSync() override {
        if (!c_) return;
        AMediaFormat* f = AMediaFormat_new();
        AMediaFormat_setInt32(f, "request-sync", 0);
        AMediaCodec_setParameters(c_, f);
        AMediaFormat_delete(f);
    }

    void close() override {
        if (c_) {
            if (started_) AMediaCodec_stop(c_);
            AMediaCodec_delete(c_);
        }
        c_ = nullptr; started_ = false;
    }

private:
    bool tryOpen(int w, int h, int fps, int kbps, int keyintSec, int colorFmt, int bitrateMode, std::string& err) {
        c_ = AMediaCodec_createEncoderByType("video/avc");
        if (!c_) { err = "no AVC encoder"; return false; }
        AMediaFormat* f = AMediaFormat_new();
        AMediaFormat_setString(f, "mime", "video/avc");
        AMediaFormat_setInt32(f, "width", w);
        AMediaFormat_setInt32(f, "height", h);
        AMediaFormat_setInt32(f, "bitrate", kbps * 1000);
        AMediaFormat_setInt32(f, "frame-rate", fps);
        AMediaFormat_setInt32(f, "i-frame-interval", keyintSec);
        AMediaFormat_setInt32(f, "color-format", colorFmt);
        AMediaFormat_setInt32(f, "bitrate-mode", bitrateMode);
        AMediaFormat_setInt32(f, "profile", 1);                          // AVCProfileBaseline: what every browser decodes
        AMediaFormat_setInt32(f, "priority", 0);                         // real time
        AMediaFormat_setInt32(f, "low-latency", 1);                      // API 30; ignored before
        AMediaFormat_setInt32(f, "max-bframes", 0);
        AMediaFormat_setInt32(f, "operating-rate", fps);
        AMediaFormat_setInt32(f, "prepend-sps-pps-to-idr-frames", 1);
        AMediaFormat_setInt32(f, "color-range", 2);                      // limited
        AMediaFormat_setInt32(f, "color-standard", 4);                   // BT.601 (NTSC): the matrix the conversion uses
        AMediaFormat_setInt32(f, "color-transfer", 3);                   // SDR video
        const media_status_t st = AMediaCodec_configure(c_, f, nullptr, nullptr, AMEDIACODEC_CONFIGURE_FLAG_ENCODE);
        AMediaFormat_delete(f);
        if (st != AMEDIA_OK) { err = "configure failed (" + std::to_string(int(st)) + ", colour format " + std::to_string(colorFmt) + ")"; return false; }
        if (AMediaCodec_start(c_) != AMEDIA_OK) { err = "start failed"; return false; }
        started_ = true;

        layout_ = colorFmt == kColorYuv420Planar ? YuvLayout::I420 : YuvLayout::NV12;
        stride_ = w; slice_ = h;
        if (void* sym = dlsym(RTLD_DEFAULT, "AMediaCodec_getInputFormat")) {
            if (AMediaFormat* in = reinterpret_cast<GetInputFormatFn>(sym)(c_)) {
                int32_t v = 0;
                if (AMediaFormat_getInt32(in, "color-format", &v)) layout_ = v == kColorYuv420Planar ? YuvLayout::I420 : YuvLayout::NV12;
                if (AMediaFormat_getInt32(in, "stride", &v) && v >= w) stride_ = v;
                if (AMediaFormat_getInt32(in, "slice-height", &v) && v >= h) slice_ = v;
                AMediaFormat_delete(in);
            }
        }
        name_.clear(); hw_ = false;
        if (void* sym = dlsym(RTLD_DEFAULT, "AMediaCodec_getName")) {
            char* n = nullptr;
            if (reinterpret_cast<GetNameFn>(sym)(c_, &n) == AMEDIA_OK && n) {
                name_ = n;
                if (void* rel = dlsym(RTLD_DEFAULT, "AMediaCodec_releaseName")) reinterpret_cast<ReleaseNameFn>(rel)(n);
            }
        }
        hw_ = !name_.empty() && name_.rfind("c2.android.", 0) != 0 && name_.rfind("OMX.google.", 0) != 0 && name_.rfind("c2.google.", 0) != 0;
        return true;
    }

    AMediaCodec* c_ = nullptr;
    bool started_ = false, hw_ = false;
    YuvLayout layout_ = YuvLayout::NV12;
    int stride_ = 0, slice_ = 0;
    std::string name_;
};

}  // namespace

std::unique_ptr<H264Codec> makeMediaCodecH264() { return std::make_unique<McCodec>(); }

}  // namespace dsrt
#else
namespace dsrt {
std::unique_ptr<H264Codec> makeMediaCodecH264() { return nullptr; }
}  // namespace dsrt
#endif
