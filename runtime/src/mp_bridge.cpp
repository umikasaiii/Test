#include "mp_bridge.hpp"

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstring>
#include <thread>

namespace dsrt {
namespace {
MpBridge* g_mp = nullptr;
constexpr uint16_t kBroadcast = RETRO_NETPACKET_BROADCAST;
constexpr uint16_t kCtlHello = 0xFFFE;  // host -> client: payload = assigned client id (u16)
constexpr size_t kMaxPacket = 65536 + 16;

void RETRO_CALLCONV c_send(int flags, const void* b, size_t n, uint16_t d) { if (g_mp) g_mp->send(flags, b, n, d); }
void RETRO_CALLCONV c_poll() { if (g_mp) g_mp->pollReceive(); }

bool setNonblock(int fd) { int f = fcntl(fd, F_GETFL, 0); return f >= 0 && fcntl(fd, F_SETFL, f | O_NONBLOCK) == 0; }

sockaddr_un addrFor(const std::string& p) {
    sockaddr_un a{};
    a.sun_family = AF_UNIX;
    std::strncpy(a.sun_path, p.c_str(), sizeof a.sun_path - 1);
    return a;
}
}  // namespace

MpBridge::~MpBridge() { stop(); }

bool MpBridge::startHost(LibretroHost& host, const std::string& path, std::string& err) {
    host_ = &host;
    g_mp = this;
    path_ = path;
    ::unlink(path.c_str());
    listenFd_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
    sockaddr_un a = addrFor(path);
    if (listenFd_ < 0 || ::bind(listenFd_, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0 || ::listen(listenFd_, 8) != 0 || !setNonblock(listenFd_)) {
        err = std::string("bridge listen: ") + std::strerror(errno);
        return false;
    }
    role_ = Role::Host;
    if (!host.hasNetpacket()) { err = "core has no netpacket interface"; return false; }
    startSession(0);  // libretro: host's start() has client_id 0 and no other player connected yet
    return true;
}

bool MpBridge::startClient(LibretroHost& host, const std::string& path, int timeoutMs, std::string& err) {
    host_ = &host;
    g_mp = this;
    path_ = path;
    if (!host.hasNetpacket()) { err = "core has no netpacket interface"; return false; }
    auto deadline = std::chrono::steady_clock::now() + std::chrono::milliseconds(timeoutMs);
    int fd = -1;
    while (std::chrono::steady_clock::now() < deadline) {
        fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
        sockaddr_un a = addrFor(path);
        if (::connect(fd, reinterpret_cast<sockaddr*>(&a), sizeof a) == 0) break;
        ::close(fd);
        fd = -1;
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    if (fd < 0) { err = "bridge: host not reachable"; return false; }
    // wait for the host's HELLO (assigned client id) - libretro: a client's start() happens when fully connected
    uint8_t hdr[8];
    size_t got = 0;
    pollfd p{fd, POLLIN, 0};
    while (got < sizeof hdr && std::chrono::steady_clock::now() < deadline) {
        if (::poll(&p, 1, 100) > 0) {
            ssize_t r = ::read(fd, hdr + got, sizeof hdr - got);
            if (r <= 0) break;
            got += size_t(r);
        }
    }
    uint16_t dest = uint16_t(hdr[0] | hdr[1] << 8);
    uint32_t len = uint32_t(hdr[4] | hdr[5] << 8 | hdr[6] << 16 | uint32_t(hdr[7]) << 24);
    uint8_t idb[2] = {0, 0};
    if (got != sizeof hdr || dest != kCtlHello || len != 2 || ::read(fd, idb, 2) != 2) {
        ::close(fd);
        err = "bridge: bad handshake (host refused the connection?)";
        return false;
    }
    setNonblock(fd);
    Conn c;
    c.fd = fd;
    c.id = 0;
    conns_.push_back(std::move(c));
    role_ = Role::Client;
    startSession(uint16_t(idb[0] | idb[1] << 8));
    return true;
}

void MpBridge::startSession(uint16_t id) {
    myId_ = id;
    active_ = true;
    host_->netpacket().start(id, c_send, c_poll);
}

void MpBridge::writeFrame(int fd, uint16_t dest, uint16_t src, const void* p, size_t n) {
    std::vector<uint8_t> f(8 + n);
    f[0] = uint8_t(dest); f[1] = uint8_t(dest >> 8); f[2] = uint8_t(src); f[3] = uint8_t(src >> 8);
    f[4] = uint8_t(n); f[5] = uint8_t(n >> 8); f[6] = uint8_t(n >> 16); f[7] = uint8_t(n >> 24);
    if (n) std::memcpy(f.data() + 8, p, n);
    size_t off = 0;
    while (off < f.size()) {
        ssize_t w = ::send(fd, f.data() + off, f.size() - off, MSG_NOSIGNAL);
        if (w < 0) {
            if (errno == EAGAIN || errno == EINTR) { pollfd pf{fd, POLLOUT, 0}; ::poll(&pf, 1, 20); continue; }
            return;  // peer gone: detected by the read side
        }
        off += size_t(w);
    }
    ++out_;
}

void MpBridge::send(int, const void* buf, size_t len, uint16_t dest) {
    if (!active_ || (len && !buf) || len > kMaxPacket) return;
    if (role_ == Role::Client) {
        if (!conns_.empty() && len) writeFrame(conns_[0].fd, dest, myId_, buf, len);  // the host routes it
        return;
    }
    if (!len) return;
    for (auto& c : conns_)
        if (dest == kBroadcast || dest == c.id) writeFrame(c.fd, dest, 0, buf, len);
}

void MpBridge::acceptNew() {
    if (role_ != Role::Host) return;
    for (;;) {
        int fd = ::accept(listenFd_, nullptr, nullptr);
        if (fd < 0) return;
        uint16_t id = 1;
        for (;;) {  // lowest free client id (RetroArch numbers clients 1..N)
            bool used = false;
            for (auto& c : conns_) used |= c.id == id;
            if (!used) break;
            ++id;
        }
        bool accept = true;
        if (host_->netpacket().connected) accept = host_->netpacket().connected(id);
        if (!accept) { ::close(fd); continue; }
        uint8_t idb[2] = {uint8_t(id), uint8_t(id >> 8)};
        writeFrame(fd, kCtlHello, 0, idb, 2);
        setNonblock(fd);
        Conn c;
        c.fd = fd;
        c.id = id;
        conns_.push_back(std::move(c));
    }
}

void MpBridge::dropConn(size_t idx) {
    uint16_t id = conns_[idx].id;
    ::close(conns_[idx].fd);
    conns_.erase(conns_.begin() + long(idx));
    if (role_ == Role::Host) {
        if (host_->netpacket().disconnected) host_->netpacket().disconnected(id);
    } else if (active_) {
        active_ = false;
        if (host_->netpacket().stop) host_->netpacket().stop();
    }
}

// Same routing as RetroArch's NETPLAY_CMD_NETPACKET handler (netplay_frontend.c): see docs/MULTIPLAYER_BRIDGE.md
void MpBridge::handleFrame(Conn* from, uint16_t dest, uint16_t src, const uint8_t* p, size_t n) {
    ++in_;
    const auto& cb = host_->netpacket();
    if (role_ == Role::Client) {  // packets arriving at a client are always for it; 'src' is the original sender
        if (cb.receive) cb.receive(p, n, src);
        return;
    }
    uint16_t incoming = from->id;
    bool bcast = dest == kBroadcast;
    if ((bcast || dest == 0) && cb.receive) cb.receive(p, n, incoming);
    if (bcast) {
        for (auto& c : conns_) if (c.id != incoming) writeFrame(c.fd, kBroadcast, incoming, p, n);
    } else if (dest && dest != incoming) {
        for (auto& c : conns_) if (c.id == dest) writeFrame(c.fd, dest, incoming, p, n);
    }
}

bool MpBridge::readConn(Conn& c) {
    uint8_t buf[65536];
    for (;;) {
        ssize_t r = ::recv(c.fd, buf, sizeof buf, 0);
        if (r > 0) { c.rx.insert(c.rx.end(), buf, buf + r); continue; }
        if (r == 0) return false;
        if (errno == EAGAIN || errno == EWOULDBLOCK) break;
        if (errno == EINTR) continue;
        return false;
    }
    size_t off = 0;
    while (c.rx.size() - off >= 8) {
        const uint8_t* h = c.rx.data() + off;
        uint16_t dest = uint16_t(h[0] | h[1] << 8), src = uint16_t(h[2] | h[3] << 8);
        uint32_t len = uint32_t(h[4] | h[5] << 8 | h[6] << 16 | uint32_t(h[7]) << 24);
        if (len > kMaxPacket) return false;  // protocol violation
        if (c.rx.size() - off < 8 + len) break;
        handleFrame(&c, dest, src, h + 8, len);
        off += 8 + len;
    }
    c.rx.erase(c.rx.begin(), c.rx.begin() + long(off));
    return true;
}

void MpBridge::pollReceive() {
    if (!active_) return;
    for (size_t i = 0; i < conns_.size();) {
        if (!readConn(conns_[i])) { dropConn(i); continue; }
        ++i;
    }
}

void MpBridge::pump() {
    if (role_ == Role::None) return;
    acceptNew();
    pollReceive();
    if (active_ && host_->netpacket().poll) host_->netpacket().poll();
}

void MpBridge::stop() {
    if (active_ && host_ && host_->netpacket().stop) host_->netpacket().stop();
    active_ = false;
    for (auto& c : conns_) ::close(c.fd);
    conns_.clear();
    if (listenFd_ >= 0) { ::close(listenFd_); ::unlink(path_.c_str()); listenFd_ = -1; }
    role_ = Role::None;
    if (g_mp == this) g_mp = nullptr;
}

}  // namespace dsrt
