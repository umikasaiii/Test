#include "av_pipeline.hpp"

extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/channel_layout.h>
#include <libavutil/opt.h>
#include <libavutil/imgutils.h>
#include <libswresample/swresample.h>
#include <libswscale/swscale.h>
}

#include <chrono>
#include <cstring>

namespace dsrt {
namespace {
int64_t nowUs() {
    return std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
}
std::string averr(int e) { char b[128]; av_strerror(e, b, sizeof b); return b; }
}  // namespace

AvPipeline::AvPipeline() = default;
AvPipeline::~AvPipeline() {
    if (venc_) avcodec_free_context(&venc_);
    if (aenc_) avcodec_free_context(&aenc_);
    if (vframe_) av_frame_free(&vframe_);
    if (aframe_) av_frame_free(&aframe_);
    if (pkt_) av_packet_free(&pkt_);
    if (sws_) sws_freeContext(sws_);
    if (swr_) swr_free(&swr_);
}

bool AvPipeline::open(const AvConfig& cfg, double coreRate, std::string& err) {
    cfg_ = cfg;
    t0Us_ = nowUs();
    pkt_ = av_packet_alloc();

    const AVCodec* vc = avcodec_find_encoder_by_name(cfg.vp8 ? "libvpx" : "libx264");
    if (!vc) { err = std::string(cfg.vp8 ? "libvpx" : "libx264") + " encoder not available"; return false; }
    venc_ = avcodec_alloc_context3(vc);
    venc_->width = int(cfg.outW);
    venc_->height = int(cfg.outH);
    venc_->time_base = AVRational{1, cfg.fps};
    venc_->framerate = AVRational{cfg.fps, 1};
    venc_->pix_fmt = AV_PIX_FMT_YUV420P;
    venc_->gop_size = cfg.keyintFrames;
    venc_->max_b_frames = 0;
    venc_->bit_rate = int64_t(cfg.videoKbps) * 1000;
    venc_->rc_max_rate = venc_->bit_rate * 3 / 2;
    venc_->rc_buffer_size = int(venc_->bit_rate / 2);
    if (cfg.vp8) {
        av_opt_set(venc_->priv_data, "deadline", "realtime", 0);
        av_opt_set(venc_->priv_data, "cpu-used", "8", 0);
        av_opt_set(venc_->priv_data, "lag-in-frames", "0", 0);
        av_opt_set(venc_->priv_data, "error-resilient", "1", 0);
        av_opt_set(venc_->priv_data, "auto-alt-ref", "0", 0);
        venc_->thread_count = 1;
    } else {
        av_opt_set(venc_->priv_data, "preset", "ultrafast", 0);
        av_opt_set(venc_->priv_data, "tune", "zerolatency", 0);
        av_opt_set(venc_->priv_data, "profile", "baseline", 0);  // widest WebRTC/H.264 interop (Safari, Chrome, Android)
        av_opt_set(venc_->priv_data, "x264-params", "repeat-headers=1:scenecut=0:threads=2", 0);
    }
    int r = avcodec_open2(venc_, vc, nullptr);
    if (r < 0) { err = "x264 open: " + averr(r); return false; }
    vframe_ = av_frame_alloc();
    vframe_->format = AV_PIX_FMT_YUV420P;
    vframe_->width = venc_->width;
    vframe_->height = venc_->height;
    av_frame_get_buffer(vframe_, 32);

    const AVCodec* ac = avcodec_find_encoder_by_name("libopus");
    if (!ac) { err = "libopus encoder not available"; return false; }
    aenc_ = avcodec_alloc_context3(ac);
    aenc_->sample_rate = 48000;
    av_channel_layout_default(&aenc_->ch_layout, 2);
    aenc_->sample_fmt = AV_SAMPLE_FMT_S16;
    aenc_->bit_rate = 96000;
    aenc_->time_base = AVRational{1, 48000};
    av_opt_set(aenc_->priv_data, "application", "lowdelay", 0);
    av_opt_set(aenc_->priv_data, "frame_duration", "20", 0);
    r = avcodec_open2(aenc_, ac, nullptr);
    if (r < 0) { err = "opus open: " + averr(r); return false; }
    aframe_ = av_frame_alloc();
    aframe_->format = AV_SAMPLE_FMT_S16;
    aframe_->nb_samples = 960;
    av_channel_layout_default(&aframe_->ch_layout, 2);
    aframe_->sample_rate = 48000;
    av_frame_get_buffer(aframe_, 0);

    AVChannelLayout stereo;
    av_channel_layout_default(&stereo, 2);
    r = swr_alloc_set_opts2(&swr_, &stereo, AV_SAMPLE_FMT_S16, 48000, &stereo, AV_SAMPLE_FMT_S16, int(coreRate + 0.5), 0, nullptr);
    if (r < 0 || swr_init(swr_) < 0) { err = "swresample init failed"; return false; }
    return true;
}

bool AvPipeline::latestRgb(std::vector<uint8_t>& out, unsigned& w, unsigned& h) {
    std::lock_guard<std::mutex> l(rawMu_);
    if (raw_.empty()) return false;
    out = raw_;
    w = rawW_;
    h = rawH_;
    return true;
}

void AvPipeline::pushVideo(const uint8_t* xrgb, unsigned w, unsigned h, size_t pitch) {
    {   // keep the last frame as RGB24 (diagnostics, parity tests)
        std::lock_guard<std::mutex> l(rawMu_);
        raw_.resize(size_t(w) * h * 3);
        for (unsigned y = 0; y < h; ++y) {
            const uint8_t* s = xrgb + y * pitch;
            uint8_t* d = raw_.data() + size_t(y) * w * 3;
            for (unsigned x = 0; x < w; ++x) { d[3 * x] = s[4 * x + 2]; d[3 * x + 1] = s[4 * x + 1]; d[3 * x + 2] = s[4 * x]; }
        }
        rawW_ = w;
        rawH_ = h;
    }
    if (!venc_) return;
    if (!sws_ || srcW_ != w || srcH_ != h) {
        if (sws_) sws_freeContext(sws_);
        // point sampling keeps DS pixel art crisp (integer 2x upscale)
        sws_ = sws_getContext(int(w), int(h), AV_PIX_FMT_BGR0, int(cfg_.outW), int(cfg_.outH), AV_PIX_FMT_YUV420P, SWS_POINT, nullptr, nullptr, nullptr);
        srcW_ = w;
        srcH_ = h;
        if (!sws_) return;
    }
    av_frame_make_writable(vframe_);
    const uint8_t* src[1] = {xrgb};
    int stride[1] = {int(pitch)};
    sws_scale(sws_, src, stride, 0, int(h), vframe_->data, vframe_->linesize);
    vframe_->pts = vpts_++;
    if (forceKey_.exchange(false)) vframe_->pict_type = AV_PICTURE_TYPE_I; else vframe_->pict_type = AV_PICTURE_TYPE_NONE;
    encodeVideo(vframe_);
}

void AvPipeline::encodeVideo(AVFrame* f) {
    if (avcodec_send_frame(venc_, f) < 0) return;
    while (avcodec_receive_packet(venc_, pkt_) == 0) {
        ++vFrames_;
        vBytes_ += uint64_t(pkt_->size);
        if (onVideo) onVideo(pkt_->data, size_t(pkt_->size), (pkt_->flags & AV_PKT_FLAG_KEY) != 0, uint64_t(nowUs() - t0Us_));
        av_packet_unref(pkt_);
    }
}

void AvPipeline::pushAudio(const int16_t* stereo, size_t frames) {
    if (!aenc_ || !frames) return;
    int maxOut = swr_get_out_samples(swr_, int(frames));
    size_t base = aq_.size();
    aq_.resize(base + size_t(maxOut) * 2);
    uint8_t* out[1] = {reinterpret_cast<uint8_t*>(aq_.data() + base)};
    const uint8_t* in[1] = {reinterpret_cast<const uint8_t*>(stereo)};
    int n = swr_convert(swr_, out, maxOut, in, int(frames));
    aq_.resize(base + size_t(n > 0 ? n : 0) * 2);
    drainAudio();
}

void AvPipeline::drainAudio() {
    while (aq_.size() >= 960 * 2) {
        av_frame_make_writable(aframe_);
        std::memcpy(aframe_->data[0], aq_.data(), 960 * 2 * sizeof(int16_t));
        aq_.erase(aq_.begin(), aq_.begin() + 960 * 2);
        aframe_->pts = apts_;
        apts_ += 960;
        if (avcodec_send_frame(aenc_, aframe_) < 0) return;
        while (avcodec_receive_packet(aenc_, pkt_) == 0) {
            ++aPackets_;
            if (onAudio) onAudio(pkt_->data, size_t(pkt_->size), uint64_t(nowUs() - t0Us_));
            av_packet_unref(pkt_);
        }
    }
}

void AvPipeline::flush() {
    if (venc_) { avcodec_send_frame(venc_, nullptr); while (avcodec_receive_packet(venc_, pkt_) == 0) av_packet_unref(pkt_); }
}

}  // namespace dsrt
