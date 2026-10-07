// DSRadioTransport: what the Multiplayer Bridge needs from a transport that carries the emulated DS radio between two or more instances.
// The bridge (mp_bridge.*) and the melonDS libretro netpacket interface above it never know which one is underneath:
//   Unix socket (LOCAL)      two instances on one machine (kept inside mp_bridge.cpp)
//   LanLink      (LAN)       DSLink Radio Protocol over UDP between native Runtimes (radio_lan.*)
//   WebRtcLink   (WEBRTC)    the same frames over an RTCDataChannel between two PWAs (wasm/webrtc_link.*)
// A frame is (dest, src, payload): exactly what libretro's netpacket send() hands over. Order, loss and re-sequencing are the transport's business.
#pragma once
#include <cstddef>
#include <cstdint>
#include <functional>
#include <string>

namespace dsrt {

struct LanStats {
    uint64_t txPackets = 0, rxPackets = 0, txBytes = 0, rxBytes = 0;
    uint64_t lost = 0;                // sequence gaps given up on
    uint64_t reordered = 0;           // arrived out of order but inside the re-sequencer window (delivered in order)
    uint64_t lateDropped = 0;         // arrived after their gap was declared lost
    uint64_t duplicates = 0, badAuth = 0, badFormat = 0, joinRejected = 0, impairDropped = 0;
    double jitterMs = 0, rttMs = 0, rttMinMs = 1e9, rttMaxMs = 0;
    uint64_t rttSamples = 0;
    uint64_t queueMax = 0;            // datagrams waiting in one poll / re-sequencer + impairment queues
    double queueAvg = 0; uint64_t queueN = 0;
};

class RadioLink {
public:
    using DataFn = std::function<void(uint16_t peerId, uint16_t dest, uint16_t src, const uint8_t* p, size_t n)>;
    using JoinFn = std::function<bool(uint16_t peerId)>;     // host: accept the new peer? (the bridge's netpacket.connected)
    using LostFn = std::function<void(uint16_t peerId)>;
    virtual ~RadioLink() = default;

    virtual void setHandlers(DataFn d, JoinFn j, LostFn l) = 0;
    virtual void poll() = 0;                                  // one bridge tick: deliver what arrived (data, joins, losses); must never block
    virtual void sendData(uint16_t peerId, uint16_t dest, uint16_t src, const void* p, size_t n) = 0;   // host -> that client; guest -> ignored (always the host)
    virtual void stop() = 0;

    virtual bool isHost() const = 0;
    virtual size_t peers() const = 0;
    virtual uint16_t myId() const = 0;
    virtual const LanStats& stats() const = 0;
    virtual const char* name() const = 0;                     // "lan" | "webrtc"
    virtual std::string json() const = 0;
    virtual int port() const { return 0; }
    virtual std::string joinUri(const std::string&) const { return std::string(); }
};

}  // namespace dsrt
