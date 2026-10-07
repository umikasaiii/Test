// WebRtcLink: the DSRadioTransport backend of the PWA. It carries the frames the melonDS core hands to the libretro netpacket interface over an RTCDataChannel that the
// PAGE owns (WebRTC objects live on the main thread; Safari has no RTCPeerConnection in workers). The emulator worker talks to the page through three JS hooks (self.__dslRadio):
//   state()                      0 connecting, 1 open, 2 closed
//   tx(dest, src, ptr, n)        queue one frame for the page (a postMessage: it never waits for the network)
//   pop(dstPtr, cap)             copy the next received frame as [dest u16][src u16][payload] into dstPtr and return its length (0 = none). It is SYNCHRONOUS on purpose:
//                                the core's reply wait (net/mp.cpp NextPacketBlock) spins for up to 25 ms calling poll() and a worker cannot receive messages while it spins,
//                                so received frames are published by the page into a SharedArrayBuffer ring that pop() reads (or into a message queue where SAB is unavailable).
// Two players: the host's only peer is id 1, the guest's only peer is the host, id 0 (the ids RetroArch/LanLink use).
#pragma once
#include <memory>
#include <string>

#include "radio_link.hpp"

namespace dsrt {

class WebRtcLink : public RadioLink {
public:
    explicit WebRtcLink(bool host);
    ~WebRtcLink() override;
    void setHandlers(DataFn d, JoinFn j, LostFn l) override { onData_ = std::move(d); onJoin_ = std::move(j); onLost_ = std::move(l); }
    void poll() override;
    void sendData(uint16_t peerId, uint16_t dest, uint16_t src, const void* p, size_t n) override;
    void stop() override;
    bool isHost() const override { return host_; }
    size_t peers() const override { return joined_ && !lost_ ? 1 : 0; }
    uint16_t myId() const override { return host_ ? 0 : 1; }
    const LanStats& stats() const override { return st_; }
    const char* name() const override { return "webrtc"; }
    std::string json() const override;

private:
    bool host_;
    bool joined_ = false, lost_ = false, stopped_ = false;
    DataFn onData_; JoinFn onJoin_; LostFn onLost_;
    LanStats st_;
    std::unique_ptr<uint8_t[]> buf_;
};

}  // namespace dsrt
