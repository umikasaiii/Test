#include "audio_out.hpp"

#include <android/log.h>

#include <algorithm>
#include <cstring>
#include <thread>

#define TAG "dslink-audio"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace dsfe {
namespace {
aaudio_data_callback_result_t dataCb(AAudioStream*, void* user, void* data, int32_t frames) { return static_cast<AudioOut*>(user)->onData(data, frames); }
void errorCb(AAudioStream*, void* user, aaudio_result_t err) { static_cast<AudioOut*>(user)->onError(err); }
}  // namespace

aaudio_data_callback_result_t AudioOut::onData(void* data, int32_t frames) {
    if (paused_.load(std::memory_order_relaxed)) { std::memset(data, 0, size_t(frames) * 4); return AAUDIO_CALLBACK_RESULT_CONTINUE; }
    reader_.pullAudio(static_cast<int16_t*>(data), size_t(frames));
    return AAUDIO_CALLBACK_RESULT_CONTINUE;
}

void AudioOut::onError(aaudio_result_t err) {
    LOGE("stream error %d (%s)", err, AAudio_convertResultToText(err));
    if (err != AAUDIO_ERROR_DISCONNECTED) return;
    // headphones unplugged / route changed: the stream is dead. Re-open it from a thread that is not the callback thread.
    std::thread([this] { const uint32_t r = rate_; stop(); ++restarts_; start(r); }).detach();
}

bool AudioOut::start(uint32_t sampleRate) {
    if (stream_ || sampleRate == 0) return stream_ != nullptr;
    AAudioStreamBuilder* b = nullptr;
    if (AAudio_createStreamBuilder(&b) != AAUDIO_OK) { LOGE("createStreamBuilder failed"); return false; }
    AAudioStreamBuilder_setDirection(b, AAUDIO_DIRECTION_OUTPUT);
    AAudioStreamBuilder_setPerformanceMode(b, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
    AAudioStreamBuilder_setSharingMode(b, AAUDIO_SHARING_MODE_SHARED);
    AAudioStreamBuilder_setFormat(b, AAUDIO_FORMAT_PCM_I16);
    AAudioStreamBuilder_setChannelCount(b, 2);
    AAudioStreamBuilder_setSampleRate(b, int32_t(sampleRate));
    AAudioStreamBuilder_setDataCallback(b, dataCb, this);
    AAudioStreamBuilder_setErrorCallback(b, errorCb, this);
    AAudioStream* s = nullptr;
    aaudio_result_t r = AAudioStreamBuilder_openStream(b, &s);
    AAudioStreamBuilder_delete(b);
    if (r != AAUDIO_OK) { LOGE("openStream failed: %s", AAudio_convertResultToText(r)); return false; }
    // two bursts of buffer: low latency without crackling on a busy phone; the ring in front of it absorbs the Runtime's 60 Hz bursts
    const int32_t burst = AAudioStream_getFramesPerBurst(s);
    AAudioStream_setBufferSizeInFrames(s, burst * 2);
    reader_.resetAudio();
    r = AAudioStream_requestStart(s);
    if (r != AAUDIO_OK) { LOGE("requestStart failed: %s", AAudio_convertResultToText(r)); AAudioStream_close(s); return false; }
    stream_ = s;
    rate_ = sampleRate;
    LOGI("audio running: %u Hz requested, device %d Hz, burst %d frames, buffer %d frames", sampleRate, AAudioStream_getSampleRate(s), burst, AAudioStream_getBufferSizeInFrames(s));
    return true;
}

void AudioOut::stop() {
    AAudioStream* s = stream_;
    stream_ = nullptr;
    if (!s) return;
    AAudioStream_requestStop(s);
    AAudioStream_close(s);
}

void AudioOut::setPaused(bool p) { paused_.store(p); if (!p) reader_.resetAudio(); }

AudioMetrics AudioOut::metrics() const {
    AudioMetrics m;
    AAudioStream* s = stream_;
    m.running = s != nullptr;
    m.rate = rate_;
    const AudioStats st = reader_.audioStats();
    m.underruns = st.underruns; m.skips = st.skips; m.restarts = restarts_.load();
    if (s) {
        m.xruns = uint64_t(std::max(0, AAudioStream_getXRunCount(s)));
        int64_t pos = 0, ns = 0;
        if (AAudioStream_getTimestamp(s, CLOCK_MONOTONIC, &pos, &ns) == AAUDIO_OK) {
            const int64_t written = AAudioStream_getFramesWritten(s);
            m.latencyMs = double(written - pos) * 1000.0 / double(std::max<uint32_t>(1, rate_));
        }
    }
    return m;
}

}  // namespace dsfe
