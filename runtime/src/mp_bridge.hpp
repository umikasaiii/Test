// DSLink Multiplayer Bridge: the minimal frontend side of libretro's NETPACKET interface, which is all the melonDS DS core
// needs from RetroArch's Netplay to carry DS local-wireless packets between two instances (see docs/MULTIPLAYER_BRIDGE.md).
// Transport: a Unix-domain stream socket inside the container (reliable + ordered, like RetroArch's TCP). Nothing leaves the host.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

#include "dlplay_diag.hpp"
#include <memory>

#include "libretro_host.hpp"
#include "radio_link.hpp"
#include "radio_lan.hpp"

namespace dsrt {

class MpBridge {
public:
    enum class Role { None, Host, Client };
    ~MpBridge();

    // Host: listen at 'path'. Client: connect to 'path' (waits up to timeoutMs for the host).
    bool startHost(LibretroHost& host, const std::string& path, std::string& err);
    bool startClient(LibretroHost& host, const std::string& path, int timeoutMs, std::string& err);
    // Call once per frame BEFORE retro_run (RetroArch does the same): accept clients, deliver received packets, core poll().
    void pump();
    void stop();

    // LAN RadioTransport (Distributed Mode): the same bridge over DSLink Radio Protocol / UDP instead of the in-container Unix socket.
    bool startLanHost(LibretroHost& host, LanConfig& cfg, std::string& err);                       // fills cfg.code / cfg.secretHex when empty
    bool startLanClient(LibretroHost& host, const LanConfig& cfg, int timeoutMs, std::string& err);
    // Any other RadioTransport (the PWA's WebRTC DataChannel): the bridge takes the link over. Host: the guest joins during poll(); guest: 'myId' is its assigned id.
    bool attachHost(LibretroHost& host, std::unique_ptr<RadioLink> link, std::string& err);
    bool attachGuest(LibretroHost& host, std::unique_ptr<RadioLink> link, uint16_t myId, std::string& err);
    const RadioLink* lan() const { return lan_.get(); }       // the active datagram/DataChannel transport (null for the in-container Unix socket)
    const char* transportName() const { return lan_ ? lan_->name() : "local"; }

    void setDiag(DlDiag* d) { diag_ = d; }  // passive observer of the wireless frames (Download Play diagnostics)
    Role role() const { return role_; }
    uint16_t clientId() const { return myId_; }
    size_t peers() const { return conns_.size(); }
    uint64_t packetsIn() const { return in_; }
    uint64_t packetsOut() const { return out_; }
    bool sessionActive() const { return active_; }

    // trampolines for the core
    void send(int flags, const void* buf, size_t len, uint16_t dest);
    void pollReceive();

private:
    struct Conn { int fd = -1; uint16_t id = 0; std::vector<uint8_t> rx; };
    void acceptNew();
    bool readConn(Conn& c);        // false = closed
    void handleFrame(Conn* from, uint16_t dest, uint16_t src, const uint8_t* p, size_t n);
    void writeFrame(int fd, uint16_t dest, uint16_t src, const void* p, size_t n);
    void sendFrame(Conn& c, uint16_t dest, uint16_t src, const void* p, size_t n);   // transport dispatch (stream or LAN datagram)
    void wireLan();
    std::unique_ptr<RadioLink> lan_;
    void dropConn(size_t idx);
    void startSession(uint16_t id);

    LibretroHost* host_ = nullptr;
    Role role_ = Role::None;
    int listenFd_ = -1;
    std::string path_;
    std::vector<Conn> conns_;  // host: one per client; client: [0] = the host
    uint16_t myId_ = 0;
    bool active_ = false;
    uint64_t in_ = 0, out_ = 0;
    DlDiag* diag_ = nullptr;
    // lifecycle callbacks that must not run inside a core call: the core may be inside poll_receive (blocking reply wait) when a peer vanishes,
    // and its stop() handler clears the very function pointers that wait loop is still using. They are delivered from pump(), between frames.
    bool pendingStop_ = false;
    std::vector<uint16_t> pendingDisconnected_;
    void flushPending();
};

}  // namespace dsrt
