#include "webrtc_link.hpp"

#include <emscripten/emscripten.h>

#include <cstdio>

namespace {
constexpr int kBuf = 65536 + 16;       // the largest frame the bridge accepts
constexpr int kMaxPerPoll = 256;       // bounded work per tick: poll() is called in a tight loop by the core's reply wait

EM_JS(int, dsl_radio_state, (), { const r = self.__dslRadio; return r ? r.state() : 2; });
EM_JS(int, dsl_radio_pop, (uint8_t* dst, int cap), { const r = self.__dslRadio; return r ? r.pop(dst, cap, HEAPU8) : 0; });
EM_JS(void, dsl_radio_tx, (int dest, int src, const uint8_t* p, int n), { const r = self.__dslRadio; if (r) r.tx(dest, src, p, n, HEAPU8); });
}  // namespace

namespace dsrt {

WebRtcLink::WebRtcLink(bool host) : host_(host), buf_(new uint8_t[kBuf]) {}
WebRtcLink::~WebRtcLink() { stop(); }

void WebRtcLink::poll() {
    if (stopped_) return;
    const int s = dsl_radio_state();
    if (host_ && !joined_ && s == 1) {                          // the guest's channel is open: ask the core whether it accepts a second player
        joined_ = true;
        if (onJoin_ && !onJoin_(1)) { stop(); return; }
    }
    if (!host_ && !joined_ && s == 1) joined_ = true;
    for (int i = 0; i < kMaxPerPoll; i++) {
        const int n = dsl_radio_pop(buf_.get(), kBuf);
        if (n <= 0) break;
        if (n < 4) continue;
        const uint16_t dest = uint16_t(buf_[0] | buf_[1] << 8), src = uint16_t(buf_[2] | buf_[3] << 8);
        ++st_.rxPackets; st_.rxBytes += uint64_t(n - 4);
        if (onData_) onData_(host_ ? 1 : 0, dest, src, buf_.get() + 4, size_t(n - 4));
    }
    if (s == 2 && joined_ && !lost_) {                          // channel closed after it had been open: the peer is gone
        lost_ = true;
        if (onLost_) onLost_(host_ ? 1 : 0);
    }
}

void WebRtcLink::sendData(uint16_t, uint16_t dest, uint16_t src, const void* p, size_t n) {
    if (stopped_ || lost_ || n > size_t(kBuf)) return;
    dsl_radio_tx(dest, src, static_cast<const uint8_t*>(p), int(n));
    ++st_.txPackets; st_.txBytes += uint64_t(n);
}

void WebRtcLink::stop() { stopped_ = true; }

std::string WebRtcLink::json() const {
    char b[256];
    std::snprintf(b, sizeof b, "{\"transport\":\"webrtc\",\"host\":%s,\"peers\":%zu,\"tx\":%llu,\"rx\":%llu}", host_ ? "true" : "false", peers(),
                  (unsigned long long)st_.txPackets, (unsigned long long)st_.rxPackets);
    return b;
}

}  // namespace dsrt
