#include "dslink/control.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstring>

#include "dslink/netaddr.hpp"

namespace dslink {

std::int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}
static std::int64_t nowUs() {
    return std::chrono::duration_cast<std::chrono::microseconds>(std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

// ---------------------------------------------------------------- codec
std::string encodePacket(const Packet& p) {
    std::string s = "DSLK";
    s += char(kProtocolVersion);
    s += char(p.type);
    s += char(p.seq >> 8);
    s += char(p.seq & 255);
    std::size_t n = std::min(p.payload.size(), kMaxPayload);
    s += char(n >> 8);
    s += char(n & 255);
    s.append(p.payload, 0, n);
    return s;
}

bool decodePacket(const void* data, std::size_t len, Packet& out) {
    if (len < 10) return false;
    const auto* b = static_cast<const std::uint8_t*>(data);
    if (std::memcmp(b, "DSLK", 4) != 0) return false;
    if (b[4] != kProtocolVersion) return false;
    if (b[5] < 1 || b[5] > 6) return false;
    std::size_t n = (std::size_t(b[8]) << 8) | b[9];
    if (n > kMaxPayload || len != 10 + n) return false;
    out.type = MsgType(b[5]);
    out.seq = std::uint16_t((b[6] << 8) | b[7]);
    out.payload.assign(reinterpret_cast<const char*>(b + 10), n);
    return true;
}

KvMap clientInfoToKv(const ClientInfo& c, const std::string& mac) {
    KvMap m{{"proto", std::to_string(c.protocolVersion)}, {"app", c.appVersion}, {"core", c.coreVersion},
            {"console", c.console}, {"mode", sessionModeName(c.mode)}, {"device", c.deviceId},
            {"nick", c.nick}, {"mac", mac}};
    if (!c.romSha256.empty()) m["rom_sha"] = c.romSha256;
    return m;
}

bool clientInfoFromKv(const KvMap& kv, ClientInfo& out, std::string& mac) {
    auto get = [&](const char* k, std::string& v) {
        auto it = kv.find(k);
        if (it == kv.end() || it->second.size() > 96) return false;
        v = it->second;
        return true;
    };
    ClientInfo c;
    std::string proto, mode;
    if (!get("proto", proto) || !get("app", c.appVersion) || !get("core", c.coreVersion) ||
        !get("console", c.console) || !get("mode", mode) || !get("device", c.deviceId) || !get("nick", c.nick) ||
        !get("mac", mac))
        return false;
    if (proto.empty() || proto.size() > 9) return false;
    for (char ch : proto) if (ch < '0' || ch > '9') return false;
    c.protocolVersion = std::uint32_t(std::stoul(proto));
    if (!parseSessionMode(mode, c.mode)) return false;
    get("rom_sha", c.romSha256);
    if (c.deviceId.empty() || c.nick.empty()) return false;
    out = c;
    return true;
}

// ---------------------------------------------------------------- sockets
namespace {
int makeUdp() { return ::socket(AF_INET, SOCK_DGRAM, 0); }

sockaddr_in addrOf(const std::string& ip, std::uint16_t port) {
    sockaddr_in a{};
    a.sin_family = AF_INET;
    a.sin_port = htons(port);
    inet_pton(AF_INET, ip.c_str(), &a.sin_addr);
    return a;
}

bool waitReadable(int fd, int ms) {
    pollfd p{fd, POLLIN, 0};
    return ::poll(&p, 1, ms) > 0 && (p.revents & POLLIN);
}

std::string ipOf(const sockaddr_in& a) {
    char b[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &a.sin_addr, b, sizeof b);
    return b;
}

void sendPkt(int fd, const sockaddr_in& to, const Packet& p) {
    std::string w = encodePacket(p);
    ::sendto(fd, w.data(), w.size(), 0, reinterpret_cast<const sockaddr*>(&to), sizeof to);
}
}  // namespace

// ---------------------------------------------------------------- server
ControlServer::ControlServer(RoomAdvert room, std::string hostNick, std::string hostMac)
    : room_(std::move(room)), hostNick_(std::move(hostNick)), hostMac_(std::move(hostMac)) {}

ControlServer::~ControlServer() { stop(); }

bool ControlServer::start(std::uint16_t port, std::string& error) {
    if (run_) return true;
    fd_ = makeUdp();
    if (fd_ < 0) { error = "socket(): " + std::string(std::strerror(errno)); return false; }
    sockaddr_in a = addrOf("0.0.0.0", port);
    if (::bind(fd_, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0) {
        error = errno == EADDRINUSE ? "porta occupata" : std::string("bind(): ") + std::strerror(errno);
        ::close(fd_);
        fd_ = -1;
        return false;
    }
    if (port == 0) {
        socklen_t l = sizeof a;
        ::getsockname(fd_, reinterpret_cast<sockaddr*>(&a), &l);
        port = ntohs(a.sin_port);
    }
    port_ = port;
    room_.port = port;
    run_ = true;
    th_ = std::thread([this] { loop(); });
    return true;
}

void ControlServer::setOnPeerJoined(PeerCallback cb) {
    std::lock_guard<std::mutex> l(mu_);
    onJoined_ = std::move(cb);
}
void ControlServer::setOnPeerLeft(PeerCallback cb) {
    std::lock_guard<std::mutex> l(mu_);
    onLeft_ = std::move(cb);
}

void ControlServer::stop() {
    if (!run_.exchange(false)) return;
    if (th_.joinable()) th_.join();
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
}

void ControlServer::expire(std::int64_t now) {
    std::vector<PeerRecord> gone;
    PeerCallback cb;
    {
        std::lock_guard<std::mutex> l(mu_);
        cb = onLeft_;
        for (auto it = peers_.begin(); it != peers_.end();) {
            if (now - it->second.lastSeenMs > peerTimeoutMs_) { gone.push_back(it->second); it = peers_.erase(it); }
            else ++it;
        }
    }
    if (cb) for (auto& p : gone) cb(p);
}

std::vector<PeerRecord> ControlServer::peers() {
    std::lock_guard<std::mutex> l(mu_);
    std::vector<PeerRecord> v;
    std::int64_t now = nowMs();
    for (auto& [k, p] : peers_) if (now - p.lastSeenMs <= peerTimeoutMs_) v.push_back(p);
    return v;
}

RoomAdvert ControlServer::room() {
    std::lock_guard<std::mutex> l(mu_);
    RoomAdvert r = room_;
    r.players = unsigned(1 + peers_.size());
    return r;
}

void ControlServer::loop() {
    char buf[2048];
    while (run_) {
        if (waitReadable(fd_, 100)) {
            sockaddr_in from{};
            socklen_t fl = sizeof from;
            ssize_t n = ::recvfrom(fd_, buf, sizeof buf, 0, reinterpret_cast<sockaddr*>(&from), &fl);
            Packet p;
            if (n > 0 && decodePacket(buf, std::size_t(n), p)) {
                std::string ip = ipOf(from);
                switch (p.type) {
                    case MsgType::Ping: {
                        Packet r{MsgType::Pong, p.seq, p.payload};
                        sendPkt(fd_, from, r);
                        std::lock_guard<std::mutex> l(mu_);
                        for (auto& [k, peer] : peers_) if (peer.ip == ip) peer.lastSeenMs = nowMs();
                        break;
                    }
                    case MsgType::Hello: {
                        KvMap kv; ClientInfo ci; std::string mac;
                        Packet r{MsgType::HelloReject, p.seq, ""};
                        if (!kvDecode(p.payload, kv) || !clientInfoFromKv(kv, ci, mac)) {
                            r.payload = kvEncode({{"code", "BAD_HELLO"}});
                            sendPkt(fd_, from, r);
                            break;
                        }
                        PeerRecord joined; bool accepted = false;
                        PeerCallback joinedCb;
                        {
                            std::lock_guard<std::mutex> l(mu_);
                            joinedCb = onJoined_;
                            RoomAdvert live = room_;
                            // A device that re-sends Hello (retry / reconnect) replaces its own slot.
                            peers_.erase(ci.deviceId);
                            live.players = unsigned(1 + peers_.size());
                            std::vector<std::string> macs{hostMac_};
                            for (auto& [k, pr] : peers_) macs.push_back(pr.mac);
                            Compat c = checkCompatibility(live, ci, mac, macs.data(), macs.size());
                            if (c == Compat::Ok) {
                                joined = PeerRecord{ci.deviceId, ci.nick, mac, ip, nowMs()};
                                peers_[ci.deviceId] = joined;
                                accepted = true;
                                r.type = MsgType::HelloAck;
                                r.payload = kvEncode({{"session", room_.sessionId}, {"nick", hostNick_},
                                                      {"mac", hostMac_}, {"netplay_port", std::to_string(port_)}});
                            } else {
                                r.payload = kvEncode({{"code", compatCode(c)}});
                            }
                        }
                        sendPkt(fd_, from, r);
                        if (accepted && joinedCb) joinedCb(joined);
                        break;
                    }
                    case MsgType::Bye: {
                        KvMap kv; PeerRecord gone; bool had = false;
                        PeerCallback leftCb;
                        if (kvDecode(p.payload, kv) && kv.count("device")) {
                            std::lock_guard<std::mutex> l(mu_);
                            leftCb = onLeft_;
                            auto it = peers_.find(kv["device"]);
                            if (it != peers_.end() && it->second.ip == ip) { gone = it->second; peers_.erase(it); had = true; }
                        }
                        if (had && leftCb) leftCb(gone);
                        break;
                    }
                    default: break;
                }
            }
        }
        expire(nowMs());
    }
}

// ---------------------------------------------------------------- client
HelloResult sendHello(const std::string& ip, std::uint16_t port, const ClientInfo& me, const std::string& myMac,
                      int timeoutMs) {
    HelloResult res;
    int fd = makeUdp();
    if (fd < 0) { res.error = "socket() failed"; return res; }
    sockaddr_in to = addrOf(ip, port);
    Packet hello{MsgType::Hello, 0, kvEncode(clientInfoToKv(me, myMac))};
    for (int attempt = 0; attempt < 3 && !res.reachable; ++attempt) {
        hello.seq = std::uint16_t(attempt + 1);
        sendPkt(fd, to, hello);
        std::int64_t deadline = nowMs() + timeoutMs;
        while (nowMs() < deadline) {
            if (!waitReadable(fd, int(std::max<std::int64_t>(1, deadline - nowMs())))) break;
            char buf[2048];
            sockaddr_in from{};
            socklen_t fl = sizeof from;
            ssize_t n = ::recvfrom(fd, buf, sizeof buf, 0, reinterpret_cast<sockaddr*>(&from), &fl);
            Packet p;
            if (n <= 0 || !decodePacket(buf, std::size_t(n), p)) continue;
            if (from.sin_addr.s_addr != to.sin_addr.s_addr) continue;
            KvMap kv;
            if (p.type == MsgType::HelloAck && kvDecode(p.payload, kv)) {
                res.reachable = res.ok = true;
                res.hostNick = kv["nick"]; res.hostMac = kv["mac"]; res.sessionId = kv["session"];
            } else if (p.type == MsgType::HelloReject && kvDecode(p.payload, kv)) {
                res.reachable = true;
                std::string code = kv["code"];
                res.error = code;
                res.compat = Compat::ProtocolMismatch;
                for (Compat c : {Compat::ProtocolMismatch, Compat::CoreMismatch, Compat::ConsoleMismatch,
                                 Compat::ModeMismatch, Compat::RomMismatch, Compat::RoomFull, Compat::MacConflict,
                                 Compat::SelfConnect})
                    if (code == compatCode(c)) res.compat = c;
            }
            if (res.reachable) break;
        }
    }
    if (!res.reachable) res.error = "TIMEOUT";
    ::close(fd);
    return res;
}

void sendBye(const std::string& ip, std::uint16_t port, const std::string& deviceId) {
    int fd = makeUdp();
    if (fd < 0) return;
    sendPkt(fd, addrOf(ip, port), Packet{MsgType::Bye, 0, kvEncode({{"device", deviceId}})});
    ::close(fd);
}

LatencyStats probeLatency(const std::string& ip, std::uint16_t port, int count, int intervalMs, int timeoutMs) {
    LatencyTracker t;
    int fd = makeUdp();
    if (fd < 0) return t.stats();
    sockaddr_in to = addrOf(ip, port);
    for (int i = 0; i < count; ++i) {
        t.onSent();
        std::int64_t t0 = nowUs();
        sendPkt(fd, to, Packet{MsgType::Ping, std::uint16_t(i), std::string("x")});
        std::int64_t deadline = nowMs() + timeoutMs;
        while (nowMs() < deadline) {
            if (!waitReadable(fd, int(std::max<std::int64_t>(1, deadline - nowMs())))) break;
            char buf[512];
            ssize_t n = ::recv(fd, buf, sizeof buf, 0);
            Packet p;
            if (n > 0 && decodePacket(buf, std::size_t(n), p) && p.type == MsgType::Pong && p.seq == i) {
                t.onReply(double(nowUs() - t0) / 1000.0);
                break;
            }
        }
        if (i + 1 < count) {
            std::int64_t wait = intervalMs - (nowUs() - t0) / 1000;
            if (wait > 0) ::poll(nullptr, 0, int(wait));
        }
    }
    ::close(fd);
    return t.stats();
}

// ---------------------------------------------------------------- beacon
bool BeaconAnnouncer::start(const std::function<RoomAdvert()>& provider, std::vector<std::string> targets,
                            std::uint16_t beaconPort, int intervalMs) {
    if (run_) return true;
    int fd = makeUdp();
    if (fd < 0) return false;
    int yes = 1;
    ::setsockopt(fd, SOL_SOCKET, SO_BROADCAST, &yes, sizeof yes);
    run_ = true;
    th_ = std::thread([this, fd, provider, targets, beaconPort, intervalMs] {
        while (run_) {
            std::string wire = encodeAdvert(provider());
            for (auto& t : targets) {
                sockaddr_in to = addrOf(t, beaconPort);
                ::sendto(fd, wire.data(), wire.size(), 0, reinterpret_cast<sockaddr*>(&to), sizeof to);
            }
            for (int waited = 0; run_ && waited < intervalMs; waited += 50) ::poll(nullptr, 0, 50);
        }
        ::close(fd);
    });
    return true;
}

void BeaconAnnouncer::stop() {
    if (!run_.exchange(false)) return;
    if (th_.joinable()) th_.join();
}

bool BeaconListener::start(std::uint16_t port, std::string& error) {
    if (run_) return true;
    fd_ = makeUdp();
    if (fd_ < 0) { error = "socket() failed"; return false; }
    int yes = 1;
    ::setsockopt(fd_, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);
#ifdef SO_REUSEPORT
    ::setsockopt(fd_, SOL_SOCKET, SO_REUSEPORT, &yes, sizeof yes);
#endif
    sockaddr_in a = addrOf("0.0.0.0", port);
    if (::bind(fd_, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0) {
        error = std::string("bind(): ") + std::strerror(errno);
        ::close(fd_);
        fd_ = -1;
        return false;
    }
    run_ = true;
    th_ = std::thread([this] {
        char buf[2048];
        while (run_) {
            if (!waitReadable(fd_, 100)) continue;
            sockaddr_in from{};
            socklen_t fl = sizeof from;
            ssize_t n = ::recvfrom(fd_, buf, sizeof buf, 0, reinterpret_cast<sockaddr*>(&from), &fl);
            if (n <= 0) continue;
            RoomAdvert ad;
            if (!decodeAdvert(std::string(buf, std::size_t(n)), ad)) continue;
            DiscoveredRoom r{ad, ipOf(from), nowMs()};
            std::lock_guard<std::mutex> l(mu_);
            rooms_[ad.sessionId] = r;
        }
    });
    return true;
}

void BeaconListener::stop() {
    if (!run_.exchange(false)) return;
    if (th_.joinable()) th_.join();
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
}

std::vector<DiscoveredRoom> BeaconListener::rooms(int maxAgeMs) {
    std::lock_guard<std::mutex> l(mu_);
    std::vector<DiscoveredRoom> v;
    std::int64_t now = nowMs();
    for (auto& [k, r] : rooms_) if (now - r.lastSeenMs <= maxAgeMs) v.push_back(r);
    return v;
}

}  // namespace dslink
