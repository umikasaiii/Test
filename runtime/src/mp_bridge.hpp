// DSLink Multiplayer Bridge: the minimal frontend side of libretro's NETPACKET interface, which is all the melonDS DS core
// needs from RetroArch's Netplay to carry DS local-wireless packets between two instances (see docs/MULTIPLAYER_BRIDGE.md).
// Transport: a Unix-domain stream socket inside the container (reliable + ordered, like RetroArch's TCP). Nothing leaves the host.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

#include "libretro_host.hpp"

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
};

}  // namespace dsrt
