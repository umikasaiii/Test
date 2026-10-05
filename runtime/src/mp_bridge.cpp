#include <cstdlib>
#include <cstdio>
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

FILE* g_trace = nullptr;
uint32_t crc32b(const uint8_t* p, size_t n) { uint32_t c = 0xFFFFFFFFu; for (size_t i = 0; i < n; i++) { c ^= p[i]; for (int k = 0; k < 8; k++) c = (c >> 1) ^ (0xEDB88320u & (0u - (c & 1u))); } return ~c; }
// DSLINK_MP_TRACE=<file>: one line per netpacket (direction, MP type, lengths, 802.11 frame control, sequence control, CRC-32 of the body). Never the body itself.
void trace(bool tx, const uint8_t* p, size_t n, double t) {
    if (!g_trace) { const char* e = std::getenv("DSLINK_MP_TRACE"); if (!e) return; g_trace = std::fopen(e, "a"); if (!g_trace) return; }
    if (n < 10) return;
    const uint8_t* f = p + 22;
    uint16_t fc = n >= 24 ? uint16_t(f[0] | f[1] << 8) : 0, sc = n >= 46 ? uint16_t(f[22] | f[23] << 8) : 0;
    uint16_t flen = n >= 22 ? uint16_t(p[20] | p[21] << 8) : 0;
    std::fprintf(g_trace, "%.1f %s type=%u aid=%u len=%zu flen=%u fc=%04x sc=%04x crc=%08x\n", t, tx ? "TX" : "RX", p[9], p[8], n, flen, fc, sc, n > 22 ? crc32b(p + 22, n - 22) : 0);
    std::fflush(g_trace);
}
double nowMs() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
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

void MpBridge::sendFrame(Conn& c, uint16_t dest, uint16_t src, const void* p, size_t n) {
    if (lan_) { lan_->sendData(c.id, dest, src, p, n); ++out_; return; }
    writeFrame(c.fd, dest, src, p, n);
}

void MpBridge::wireLan() {
    lan_->setHandlers(
        [this](uint16_t id, uint16_t dest, uint16_t src, const uint8_t* p, size_t n) {          // a datagram's frame, in order
            for (auto& c : conns_) if (c.id == id) { handleFrame(&c, dest, src, p, n); return; }
        },
        [this](uint16_t id) {                                                                    // host: a guest joined
            bool accept = !host_->netpacket().connected || host_->netpacket().connected(id);
            if (accept) { Conn c; c.id = id; conns_.push_back(std::move(c)); }
            return accept;
        },
        [this](uint16_t id) { for (size_t i = 0; i < conns_.size(); i++) if (conns_[i].id == id) { dropConn(i); return; } });
}

bool MpBridge::startLanHost(LibretroHost& host, LanConfig& cfg, std::string& err) {
    host_ = &host;
    g_mp = this;
    if (!host.hasNetpacket()) { err = "core has no netpacket interface"; return false; }
    lan_ = std::make_unique<LanLink>();
    if (!lan_->hostStart(cfg, err)) { lan_.reset(); return false; }
    wireLan();
    role_ = Role::Host;
    startSession(0);
    return true;
}

bool MpBridge::startLanClient(LibretroHost& host, const LanConfig& cfg, int timeoutMs, std::string& err) {
    host_ = &host;
    g_mp = this;
    if (!host.hasNetpacket()) { err = "core has no netpacket interface"; return false; }
    lan_ = std::make_unique<LanLink>();
    uint16_t id = 0;
    if (!lan_->clientJoin(cfg, timeoutMs, id, err)) { lan_.reset(); return false; }
    wireLan();
    Conn c; c.id = 0; conns_.push_back(std::move(c));
    role_ = Role::Client;
    startSession(id);
    return true;
}

void MpBridge::send(int, const void* buf, size_t len, uint16_t dest) {
    if (!active_ || (len && !buf) || len > kMaxPacket) return;
    if (diag_ && len) diag_->observe(true, static_cast<const uint8_t*>(buf), len, nowMs());
    if (len) trace(true, static_cast<const uint8_t*>(buf), len, nowMs());
    if (role_ == Role::Client) {
        if (!conns_.empty() && len) sendFrame(conns_[0], dest, myId_, buf, len);  // the host routes it
        return;
    }
    if (!len) return;
    for (auto& c : conns_)
        if (dest == kBroadcast || dest == c.id) sendFrame(c, dest, 0, buf, len);
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
    if (conns_[idx].fd >= 0) ::close(conns_[idx].fd);
    conns_.erase(conns_.begin() + long(idx));
    if (role_ == Role::Host) {
        pendingDisconnected_.push_back(id);               // delivered from pump(): see flushPending()
    } else if (active_) {
        active_ = false;                                   // sends/polls become no-ops immediately; the core hears about it between frames
        pendingStop_ = true;
    }
}

void MpBridge::flushPending() {
    for (uint16_t id : pendingDisconnected_) if (host_->netpacket().disconnected) host_->netpacket().disconnected(id);
    pendingDisconnected_.clear();
    if (pendingStop_) { pendingStop_ = false; if (host_->netpacket().stop) host_->netpacket().stop(); }
}

// Same routing as RetroArch's NETPLAY_CMD_NETPACKET handler (netplay_frontend.c): see docs/MULTIPLAYER_BRIDGE.md
void MpBridge::handleFrame(Conn* from, uint16_t dest, uint16_t src, const uint8_t* p, size_t n) {
    ++in_;
    const auto& cb = host_->netpacket();
    if (role_ == Role::Client) {  // packets arriving at a client are always for it; 'src' is the original sender
        if (diag_) diag_->observe(false, p, n, nowMs());
        trace(false, p, n, nowMs());
        if (cb.receive) cb.receive(p, n, src);
        return;
    }
    uint16_t incoming = from->id;
    bool bcast = dest == kBroadcast;
    if ((bcast || dest == 0) && cb.receive) { if (diag_) diag_->observe(false, p, n, nowMs()); trace(false, p, n, nowMs()); cb.receive(p, n, incoming); }
    if (bcast) {
        for (auto& c : conns_) if (c.id != incoming) sendFrame(c, kBroadcast, incoming, p, n);
    } else if (dest && dest != incoming) {
        for (auto& c : conns_) if (c.id == dest) sendFrame(c, dest, incoming, p, n);
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
    if (lan_) { lan_->poll(); return; }
    for (size_t i = 0; i < conns_.size();) {
        if (!readConn(conns_[i])) { dropConn(i); continue; }
        ++i;
    }
}

void MpBridge::pump() {
    if (role_ == Role::None) return;
    flushPending();
    if (!lan_) acceptNew();
    pollReceive();
    if (active_ && host_->netpacket().poll) host_->netpacket().poll();
}

void MpBridge::stop() {
    if ((active_ || pendingStop_) && host_ && host_->netpacket().stop) host_->netpacket().stop();   // shutdown path: called from main, never from inside the core
    active_ = false;
    pendingStop_ = false;
    if (lan_) { lan_->stop(); lan_.reset(); }
    for (auto& c : conns_) if (c.fd >= 0) ::close(c.fd);
    conns_.clear();
    if (listenFd_ >= 0) { ::close(listenFd_); ::unlink(path_.c_str()); listenFd_ = -1; }
    role_ = Role::None;
    if (g_mp == this) g_mp = nullptr;
}

}  // namespace dsrt
