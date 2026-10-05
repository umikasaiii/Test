#include "radio_lan.hpp"

#include <arpa/inet.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <sstream>
#include <thread>

namespace dsrt {
namespace {
constexpr uint32_t kMagic = 0x524C5344u;   // "DSLR"
constexpr uint8_t kVer = 1;
enum : uint8_t { T_JOIN = 1, T_WELCOME = 2, T_DATA = 3, T_PING = 4, T_PONG = 5, T_BYE = 6, T_REJECT = 7, T_DISCOVER = 8, T_ANNOUNCE = 9 };
constexpr size_t kHdr = 36, kMaxPayload = 60000;

inline uint64_t rotl(uint64_t x, int b) { return (x << b) | (x >> (64 - b)); }
uint64_t siphash24(const uint8_t key[16], const uint8_t* m, size_t n) {
    uint64_t k0, k1; std::memcpy(&k0, key, 8); std::memcpy(&k1, key + 8, 8);
    uint64_t v0 = 0x736f6d6570736575ull ^ k0, v1 = 0x646f72616e646f6dull ^ k1, v2 = 0x6c7967656e657261ull ^ k0, v3 = 0x7465646279746573ull ^ k1;
    auto round = [&] { v0 += v1; v1 = rotl(v1, 13); v1 ^= v0; v0 = rotl(v0, 32); v2 += v3; v3 = rotl(v3, 16); v3 ^= v2; v0 += v3; v3 = rotl(v3, 21); v3 ^= v0; v2 += v1; v1 = rotl(v1, 17); v1 ^= v2; v2 = rotl(v2, 32); };
    size_t i = 0;
    for (; i + 8 <= n; i += 8) { uint64_t w; std::memcpy(&w, m + i, 8); v3 ^= w; round(); round(); v0 ^= w; }
    uint64_t b = uint64_t(n) << 56;
    for (size_t j = 0; i + j < n; j++) b |= uint64_t(m[i + j]) << (8 * j);
    v3 ^= b; round(); round(); v0 ^= b; v2 ^= 0xff; round(); round(); round(); round();
    return v0 ^ v1 ^ v2 ^ v3;
}
void kdf(const uint8_t key[16], const std::string& label, const uint8_t* extra, size_t en, uint8_t out[16]) {
    std::vector<uint8_t> m(label.begin(), label.end()); m.insert(m.end(), extra, extra + en); m.push_back(0);
    uint64_t a = siphash24(key, m.data(), m.size()); m.back() = 1; uint64_t b = siphash24(key, m.data(), m.size());
    std::memcpy(out, &a, 8); std::memcpy(out + 8, &b, 8);
}
const uint8_t kFixed[16] = {'D', 'S', 'L', 'i', 'n', 'k', '-', 'c', 'o', 'd', 'e', '-', 'v', '1', 0, 0};
void put32(uint8_t* p, uint32_t v) { std::memcpy(p, &v, 4); }
void put16(uint8_t* p, uint16_t v) { std::memcpy(p, &v, 2); }
uint32_t get32(const uint8_t* p) { uint32_t v; std::memcpy(&v, p, 4); return v; }
uint16_t get16(const uint8_t* p) { uint16_t v; std::memcpy(&v, p, 2); return v; }
uint64_t get64(const uint8_t* p) { uint64_t v; std::memcpy(&v, p, 8); return v; }
bool hexTo(const std::string& h, uint8_t out[16]) {
    if (h.size() != 32) return false;
    for (int i = 0; i < 16; i++) { unsigned v; if (std::sscanf(h.c_str() + 2 * i, "%2x", &v) != 1) return false; out[i] = uint8_t(v); }
    return true;
}
std::string toHex(const uint8_t* p, size_t n) { std::string s; char b[3]; for (size_t i = 0; i < n; i++) { std::snprintf(b, 3, "%02x", p[i]); s += b; } return s; }
bool nonblock(int fd) { int f = fcntl(fd, F_GETFL, 0); return f >= 0 && fcntl(fd, F_SETFL, f | O_NONBLOCK) == 0; }
bool sameAddr(const sockaddr_in& a, const sockaddr_in& b) { return a.sin_addr.s_addr == b.sin_addr.s_addr && a.sin_port == b.sin_port; }
void urandom(void* p, size_t n) { FILE* f = std::fopen("/dev/urandom", "rb"); if (f) { if (std::fread(p, 1, n, f) != n) std::memset(p, 0x5a, n); std::fclose(f); } else std::memset(p, 0x5a, n); }
}  // namespace

double LanLink::nowMs() { return std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
uint32_t LanLink::rnd() { rngState_ ^= rngState_ << 13; rngState_ ^= rngState_ >> 7; rngState_ ^= rngState_ << 17; return uint32_t(rngState_ >> 16); }
LanLink::~LanLink() { stop(); }

std::string LanLink::makeCode() { uint32_t v; urandom(&v, 4); char b[8]; std::snprintf(b, sizeof b, "%06u", 100000u + v % 900000u); return b; }

std::string LanLink::joinUri(const std::string& ip) const { return "dslink://join?c=" + cfg_.code + "&s=" + toHex(secret_, 16) + "&h=" + ip + ":" + std::to_string(port_); }

bool LanLink::parseUri(const std::string& uri, LanConfig& cfg) {
    if (uri.rfind("dslink://join?", 0) != 0) return false;
    std::stringstream ss(uri.substr(14)); std::string kv;
    while (std::getline(ss, kv, '&')) {
        auto e = kv.find('='); if (e == std::string::npos) continue;
        std::string k = kv.substr(0, e), v = kv.substr(e + 1);
        if (k == "c") cfg.code = v; else if (k == "s") cfg.secretHex = v; else if (k == "h") cfg.hostAddr = v;
    }
    return !cfg.code.empty();
}

bool LanLink::openSocket(const std::string& bind, int port, std::string& err) {
    fd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
    if (fd_ < 0) { err = std::string("lan socket: ") + std::strerror(errno); return false; }
    int one = 1; ::setsockopt(fd_, SOL_SOCKET, SO_BROADCAST, &one, sizeof one);
    int buf = 4 << 20; ::setsockopt(fd_, SOL_SOCKET, SO_RCVBUF, &buf, sizeof buf); ::setsockopt(fd_, SOL_SOCKET, SO_SNDBUF, &buf, sizeof buf);
    sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons(uint16_t(port)); a.sin_addr.s_addr = inet_addr(bind.c_str());
    if (::bind(fd_, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0) { err = std::string("lan bind: ") + std::strerror(errno); return false; }
    socklen_t l = sizeof a; ::getsockname(fd_, reinterpret_cast<sockaddr*>(&a), &l); port_ = ntohs(a.sin_port);
    return nonblock(fd_);
}

bool LanLink::hostStart(LanConfig& cfg, std::string& err) {
    host_ = true;
    if (cfg.code.empty()) cfg.code = makeCode();
    if (cfg.secretHex.empty()) { uint8_t s[16]; urandom(s, 16); cfg.secretHex = toHex(s, 16); }
    cfg_ = cfg;
    rngState_ ^= cfg.seed ? cfg.seed : ([] { uint64_t v; urandom(&v, 8); return v; })();
    if (!hexTo(cfg_.secretHex, secret_)) { err = "bad secret"; return false; }
    kdf(kFixed, "join0", reinterpret_cast<const uint8_t*>(cfg_.code.data()), cfg_.code.size(), k0_);
    urandom(&session_, 4);
    if (!openSocket(cfg_.bindAddr, cfg_.port, err)) return false;
    discFd_ = ::socket(AF_INET, SOCK_DGRAM, 0);
    int one = 1; ::setsockopt(discFd_, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one); ::setsockopt(discFd_, SOL_SOCKET, SO_REUSEPORT, &one, sizeof one);
    sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons(uint16_t(cfg_.discoveryPort)); a.sin_addr.s_addr = htonl(INADDR_ANY);
    if (discFd_ < 0 || ::bind(discFd_, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0) { err = std::string("lan discovery bind: ") + std::strerror(errno); return false; }
    nonblock(discFd_);
    cfg = cfg_;
    return true;
}

void LanLink::rawSend(const sockaddr_in& to, uint8_t type, uint16_t peerId, uint32_t seq, uint16_t dest, uint16_t src, const void* p, size_t n, bool impair, const uint8_t* key) {
    std::vector<uint8_t> b(kHdr + n);
    put32(b.data(), kMagic); b[4] = kVer; b[5] = type; put16(&b[6], peerId); put32(&b[8], session_); put32(&b[12], seq);
    put32(&b[16], uint32_t(nowMs())); put32(&b[20], uint32_t(n)); put16(&b[24], dest); put16(&b[26], src);
    std::memset(&b[28], 0, 8);
    if (n) std::memcpy(&b[kHdr], p, n);
    if (key) { uint64_t t = siphash24(key, b.data(), b.size()); std::memcpy(&b[28], &t, 8); }
    st_.txPackets++; st_.txBytes += b.size();
    if (impair && cfg_.impair.active()) {
        if (cfg_.impair.lossPct > 0 && (rnd() % 100000) < uint32_t(cfg_.impair.lossPct * 1000)) { st_.impairDropped++; return; }
        double d = cfg_.impair.delayMs + (cfg_.impair.jitterMs > 0 ? (double(rnd() % 20001) / 10000.0 - 1.0) * cfg_.impair.jitterMs : 0);
        if (d > 0.05) { delayed_.push_back({nowMs() + d, std::move(b), to}); return; }
    }
    ::sendto(fd_, b.data(), b.size(), MSG_NOSIGNAL, reinterpret_cast<const sockaddr*>(&to), sizeof to);
}

namespace {
// handshake packets: built here so the tag can use the join key (not the session key)
std::vector<uint8_t> buildHs(uint8_t type, uint16_t peerId, uint32_t session, uint32_t seq, const void* p, size_t n, const uint8_t* key, double ts) {
    std::vector<uint8_t> b(kHdr + n);
    put32(b.data(), kMagic); b[4] = kVer; b[5] = type; put16(&b[6], peerId); put32(&b[8], session); put32(&b[12], seq);
    put32(&b[16], uint32_t(ts)); put32(&b[20], uint32_t(n)); std::memset(&b[24], 0, 12);
    if (n) std::memcpy(&b[kHdr], p, n);
    if (key) { uint64_t t = siphash24(key, b.data(), b.size()); std::memcpy(&b[28], &t, 8); }
    return b;
}
bool verifyTag(const uint8_t* d, size_t n, const uint8_t key[16]) {
    std::vector<uint8_t> c(d, d + n); uint64_t got = get64(&c[28]); std::memset(&c[28], 0, 8);
    return siphash24(key, c.data(), c.size()) == got;
}
}  // namespace

bool LanLink::clientJoin(const LanConfig& cfgIn, int timeoutMs, uint16_t& assignedId, std::string& err) {
    host_ = false; cfg_ = cfgIn;
    rngState_ ^= cfg_.seed ? cfg_.seed : ([] { uint64_t v; urandom(&v, 8); return v; })();
    kdf(kFixed, "join0", reinterpret_cast<const uint8_t*>(cfg_.code.data()), cfg_.code.size(), k0_);
    bool haveSecret = !cfg_.secretHex.empty();
    uint8_t joinKey[16];
    if (haveSecret) { if (!hexTo(cfg_.secretHex, secret_)) { err = "bad secret"; return false; } kdf(secret_, "join", nullptr, 0, joinKey); } else std::memcpy(joinKey, k0_, 16);
    if (!openSocket("0.0.0.0", 0, err)) return false;
    auto deadline = nowMs() + timeoutMs;
    sockaddr_in hostA{}; hostA.sin_family = AF_INET; bool haveAddr = false;
    auto parseAddr = [&](const std::string& s) { auto c = s.rfind(':'); if (c == std::string::npos) return false; hostA.sin_addr.s_addr = inet_addr(s.substr(0, c).c_str()); hostA.sin_port = htons(uint16_t(std::atoi(s.c_str() + c + 1))); return hostA.sin_addr.s_addr != INADDR_NONE; };
    if (!cfg_.hostAddr.empty()) { if (!parseAddr(cfg_.hostAddr)) { err = "bad host address"; return false; } haveAddr = true; }
    uint8_t tagKey[16]; kdf(kFixed, "disc", reinterpret_cast<const uint8_t*>(cfg_.code.data()), cfg_.code.size(), tagKey);
    uint64_t codeTag = siphash24(tagKey, reinterpret_cast<const uint8_t*>("DISCOVER"), 8);
    uint8_t nonceG[8]; uint64_t ng = (uint64_t(rnd()) << 32) | rnd(); std::memcpy(nonceG, &ng, 8);
    double lastTx = 0;
    uint8_t buf[2048];
    while (nowMs() < deadline) {
        double now = nowMs();
        if (now - lastTx > 300) {
            lastTx = now;
            if (!haveAddr) {   // discovery
                sockaddr_in d{}; d.sin_family = AF_INET; d.sin_port = htons(uint16_t(cfg_.discoveryPort)); d.sin_addr.s_addr = inet_addr(cfg_.discoveryAddr.c_str());
                auto b = buildHs(T_DISCOVER, 0xFFFF, 0, 0, &codeTag, 8, nullptr, now);
                ::sendto(fd_, b.data(), b.size(), 0, reinterpret_cast<sockaddr*>(&d), sizeof d);
            } else {
                uint8_t pl[9]; std::memcpy(pl, nonceG, 8); pl[8] = haveSecret ? 1 : 0;
                auto b = buildHs(T_JOIN, 0xFFFF, session_, 0, pl, 9, joinKey, now);
                ::sendto(fd_, b.data(), b.size(), 0, reinterpret_cast<sockaddr*>(&hostA), sizeof hostA);
            }
        }
        sockaddr_in from{}; socklen_t fl = sizeof from;
        ssize_t r = ::recvfrom(fd_, buf, sizeof buf, 0, reinterpret_cast<sockaddr*>(&from), &fl);
        if (r < 0) { std::this_thread::sleep_for(std::chrono::milliseconds(2)); continue; }
        if (size_t(r) < kHdr || get32(buf) != kMagic || buf[4] != kVer || get32(buf + 20) != size_t(r) - kHdr) { st_.badFormat++; continue; }
        uint8_t type = buf[5];
        if (type == T_ANNOUNCE && !haveAddr) {
            if (!verifyTag(buf, size_t(r), k0_) || get32(buf + 20) < 2) { st_.badAuth++; continue; }
            hostA = from; hostA.sin_port = htons(get16(buf + kHdr)); session_ = get32(buf + 8); haveAddr = true; lastTx = 0;
        } else if (type == T_WELCOME && haveAddr && sameAddr(from, hostA)) {
            if (!verifyTag(buf, size_t(r), joinKey) || get32(buf + 20) != 26) { st_.badAuth++; continue; }
            assignedId = get16(buf + kHdr); const uint8_t* nonceH = buf + kHdr + 2; const uint8_t* masked = buf + kHdr + 10;
            session_ = get32(buf + 8);
            if (!haveSecret) {   // code-only join: the host sent the session secret masked with a keystream derived from the code
                uint8_t ex[16]; std::memcpy(ex, nonceG, 8); std::memcpy(ex + 8, nonceH, 8);
                uint8_t ksm[16]; kdf(k0_, "mask", ex, 16, ksm);
                for (int i = 0; i < 16; i++) secret_[i] = masked[i] ^ ksm[i];
            }
            uint8_t ex[16]; std::memcpy(ex, nonceG, 8); std::memcpy(ex + 8, nonceH, 8);
            Peer p; kdf(secret_, "session", ex, 16, p.ks); p.id = 0; p.addr = hostA; p.lastRx = nowMs(); p.lastPing = nowMs(); peers_.push_back(std::move(p));
            myId_ = assignedId;
            return true;
        } else if (type == T_REJECT && haveAddr && sameAddr(from, hostA)) { err = "the host refused the join"; return false; }
    }
    err = haveAddr ? "host did not answer the join (wrong code/secret or host full)" : "no DSLink host found with that code on this network";
    return false;
}

void LanLink::discoveryTick() {
    uint8_t buf[512];
    for (;;) {
        sockaddr_in from{}; socklen_t fl = sizeof from;
        ssize_t r = ::recvfrom(discFd_, buf, sizeof buf, 0, reinterpret_cast<sockaddr*>(&from), &fl);
        if (r < 0) return;
        if (size_t(r) != kHdr + 8 || get32(buf) != kMagic || buf[5] != T_DISCOVER) continue;
        uint8_t tagKey[16]; kdf(kFixed, "disc", reinterpret_cast<const uint8_t*>(cfg_.code.data()), cfg_.code.size(), tagKey);
        uint64_t want = siphash24(tagKey, reinterpret_cast<const uint8_t*>("DISCOVER"), 8);
        if (get64(buf + kHdr) != want) continue;        // some other room on this network
        std::vector<uint8_t> pl(2 + cfg_.name.size()); put16(pl.data(), uint16_t(port_)); std::memcpy(&pl[2], cfg_.name.data(), cfg_.name.size());
        auto b = buildHs(T_ANNOUNCE, 0, session_, 0, pl.data(), pl.size(), k0_, nowMs());
        ::sendto(discFd_, b.data(), b.size(), 0, reinterpret_cast<sockaddr*>(&from), sizeof from);
    }
}

LanLink::Peer* LanLink::peerById(uint16_t id) { for (auto& p : peers_) if (p.id == id) return &p; return nullptr; }

void LanLink::sendData(uint16_t peerId, uint16_t dest, uint16_t src, const void* p, size_t n) {
    if (n > kMaxPayload) return;
    Peer* pe = host_ ? peerById(peerId) : (peers_.empty() ? nullptr : &peers_[0]);
    if (!pe) return;
    rawSend(pe->addr, T_DATA, myId_, pe->txSeq++, dest, src, p, n, true, pe->ks);
}

void LanLink::deliverInOrder(Peer& p, double now) {
    while (!p.reseq.empty()) {
        auto it = p.reseq.begin();
        if (it->first == p.nextRx) {
            st_.reordered++;                                    // it was buffered, i.e. it arrived behind a later packet
            Buffered b = std::move(it->second); p.reseq.erase(it); p.nextRx++;
            if (onData_) onData_(p.id, b.dest, b.src, b.payload.data(), b.payload.size());
        } else if (now - it->second.at >= cfg_.reorderMs) {
            st_.lost += it->first - p.nextRx; p.nextRx = it->first;   // give up on the gap
        } else break;
    }
}

void LanLink::handleDatagram(const uint8_t* d, size_t n, const sockaddr_in& from, double now) {
    if (n < kHdr || get32(d) != kMagic || d[4] != kVer || get32(d + 20) != n - kHdr || n - kHdr > kMaxPayload) { st_.badFormat++; return; }
    uint8_t type = d[5];
    st_.rxPackets++; st_.rxBytes += n;
    if (host_ && type == T_JOIN) {
        if (now < lockedUntil_) return;
        bool hasSecret = n - kHdr == 9 && d[kHdr + 8] == 1;
        uint8_t joinKey[16]; if (hasSecret) kdf(secret_, "join", nullptr, 0, joinKey); else std::memcpy(joinKey, k0_, 16);
        if (n - kHdr != 9 || !verifyTag(d, n, joinKey) || (get32(d + 8) != 0 && get32(d + 8) != session_)) {
            st_.badAuth++;
            if (now - badJoinWindowStart_ > 10000) { badJoinWindowStart_ = now; badJoins_ = 0; }
            if (++badJoins_ > 8) lockedUntil_ = now + 30000;      // throttle code guessing: 8 bad joins / 10 s -> 30 s lockout
            return;
        }
        uint8_t nonceG[8]; std::memcpy(nonceG, d + kHdr, 8);
        Peer* ex = nullptr; for (auto& p : peers_) if (sameAddr(p.addr, from)) ex = &p;
        uint16_t id;
        if (ex) id = ex->id;                                    // retransmitted JOIN: same answer
        else {
            if (peers_.size() >= size_t(cfg_.maxPeers)) { auto b = buildHs(T_REJECT, 0, session_, 0, nullptr, 0, joinKey, now); ::sendto(fd_, b.data(), b.size(), 0, reinterpret_cast<const sockaddr*>(&from), sizeof from); st_.joinRejected++; return; }
            id = 1; for (;;) { bool used = false; for (auto& p : peers_) used |= p.id == id; if (!used) break; ++id; }
            if (onJoin_ && !onJoin_(id)) { auto b = buildHs(T_REJECT, 0, session_, 0, nullptr, 0, joinKey, now); ::sendto(fd_, b.data(), b.size(), 0, reinterpret_cast<const sockaddr*>(&from), sizeof from); st_.joinRejected++; return; }
        }
        uint8_t pl[26]; put16(pl, id);
        uint8_t nonceH[8]; if (ex) std::memcpy(nonceH, ex->nonceH, 8); else { uint64_t nh = (uint64_t(rnd()) << 32) | rnd(); std::memcpy(nonceH, &nh, 8); }
        std::memcpy(pl + 2, nonceH, 8);
        uint8_t exn[16]; std::memcpy(exn, nonceG, 8); std::memcpy(exn + 8, nonceH, 8);
        uint8_t ksm[16]; kdf(k0_, "mask", exn, 16, ksm);
        for (int i = 0; i < 16; i++) pl[10 + i] = hasSecret ? 0 : uint8_t(secret_[i] ^ ksm[i]);
        auto b = buildHs(T_WELCOME, id, session_, 0, pl, 26, joinKey, now);
        ::sendto(fd_, b.data(), b.size(), 0, reinterpret_cast<const sockaddr*>(&from), sizeof from);
        if (!ex) {
            Peer p; p.id = id; p.addr = from; p.lastRx = now; p.lastPing = now; std::memcpy(p.nonceH, nonceH, 8);
            kdf(secret_, "session", exn, 16, p.ks);                 // per-peer key: secret + this join's two nonces
            peers_.push_back(std::move(p));
        }
        return;
    }
    // everything else needs the session key
    Peer* pe = nullptr;
    for (auto& p : peers_) if (sameAddr(p.addr, from)) pe = &p;
    if (!pe) return;
    if (get32(d + 8) != session_ || !verifyTag(d, n, pe->ks)) { st_.badAuth++; return; }
    pe->lastRx = now;
    const uint8_t* pl = d + kHdr; size_t pn = n - kHdr;
    switch (type) {
        case T_DATA: {
            uint32_t seq = get32(d + 12), ts = get32(d + 16);
            double dd = (now - pe->lastArrival) - (double(int32_t(ts - uint32_t(pe->lastTs)))) ;   // RFC 3550 interarrival jitter (ms)
            if (pe->haveJ) st_.jitterMs += (std::fabs(dd) - st_.jitterMs) / 16.0;
            pe->haveJ = true; pe->lastArrival = now; pe->lastTs = ts;
            if (!pe->rxStarted) { pe->rxStarted = true; pe->nextRx = seq; }
            uint16_t dest = get16(d + 24), src = get16(d + 26);
            if (seq == pe->nextRx) {
                pe->nextRx++;
                if (onData_) onData_(pe->id, dest, src, pl, pn);
                deliverInOrder(*pe, now);
            } else if (int32_t(seq - pe->nextRx) > 0) {
                if (pe->reseq.count(seq)) { st_.duplicates++; return; }
                pe->reseq[seq] = Buffered{std::vector<uint8_t>(pl, pl + pn), dest, src, now};
                deliverInOrder(*pe, now);
            } else st_.lateDropped++;                          // behind the window (or a duplicate of something already delivered)
            break;
        }
        case T_PING: if (pn == 4) rawSend(pe->addr, T_PONG, myId_, ctlSeq_++, 0, 0, pl, 4, true, pe->ks); break;
        case T_PONG:
            if (pn == 4) {
                double rtt = double(uint32_t(uint32_t(now) - get32(pl)));
                st_.rttMs = st_.rttSamples ? st_.rttMs + (rtt - st_.rttMs) / 8.0 : rtt; st_.rttSamples++;
                st_.rttMinMs = std::min(st_.rttMinMs, rtt); st_.rttMaxMs = std::max(st_.rttMaxMs, rtt);
            }
            break;
        case T_BYE: for (size_t i = 0; i < peers_.size(); i++) if (&peers_[i] == pe) { dropPeer(i, false); break; } break;
        default: break;
    }
}

void LanLink::dropPeer(size_t idx, bool tellPeer) {
    Peer p = peers_[idx];
    if (tellPeer) { for (int i = 0; i < 3; i++) rawSend(p.addr, T_BYE, myId_, ctlSeq_++, 0, 0, nullptr, 0, false, p.ks); }
    peers_.erase(peers_.begin() + long(idx));
    if (onLost_) onLost_(p.id);
}

void LanLink::poll() {
    if (fd_ < 0) return;
    double now = nowMs();
    for (size_t i = 0; i < delayed_.size();) {                        // impairment queue: release what is due
        if (delayed_[i].due <= now) { ::sendto(fd_, delayed_[i].bytes.data(), delayed_[i].bytes.size(), MSG_NOSIGNAL, reinterpret_cast<sockaddr*>(&delayed_[i].to), sizeof(sockaddr_in)); delayed_.erase(delayed_.begin() + long(i)); }
        else ++i;
    }
    if (discFd_ >= 0) discoveryTick();
    uint8_t buf[65536]; uint64_t drained = 0;
    for (;;) {
        sockaddr_in from{}; socklen_t fl = sizeof from;
        ssize_t r = ::recvfrom(fd_, buf, sizeof buf, 0, reinterpret_cast<sockaddr*>(&from), &fl);
        if (r < 0) break;
        ++drained;
        handleDatagram(buf, size_t(r), from, now);
    }
    uint64_t q = drained + delayed_.size(); for (auto& p : peers_) q += p.reseq.size();
    st_.queueMax = std::max(st_.queueMax, q); st_.queueAvg += (double(q) - st_.queueAvg) / double(++st_.queueN > 1000 ? 1000 : st_.queueN);
    for (size_t i = 0; i < peers_.size();) {
        Peer& p = peers_[i];
        deliverInOrder(p, now);
        if (now - p.lastPing >= 500) { uint32_t ts = uint32_t(now); rawSend(p.addr, T_PING, myId_, ctlSeq_++, 0, 0, &ts, 4, true, p.ks); p.lastPing = now; }
        if (now - p.lastRx > cfg_.peerTimeoutMs) { dropPeer(i, false); continue; }
        ++i;
    }
}

void LanLink::stop() {
    for (auto& p : peers_) for (int i = 0; i < 3 && fd_ >= 0; i++) rawSend(p.addr, T_BYE, myId_, ctlSeq_++, 0, 0, nullptr, 0, false, p.ks);
    peers_.clear(); delayed_.clear();
    if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
    if (discFd_ >= 0) { ::close(discFd_); discFd_ = -1; }
}

std::string LanLink::json() const {
    std::ostringstream o;
    o << "{\"role\":\"" << (host_ ? "host" : "guest") << "\",\"peers\":" << peers_.size() << ",\"tx\":" << st_.txPackets << ",\"rx\":" << st_.rxPackets
      << ",\"tx_bytes\":" << st_.txBytes << ",\"rx_bytes\":" << st_.rxBytes << ",\"lost\":" << st_.lost << ",\"reordered\":" << st_.reordered
      << ",\"late_dropped\":" << st_.lateDropped << ",\"dup\":" << st_.duplicates << ",\"bad_auth\":" << st_.badAuth << ",\"bad_format\":" << st_.badFormat
      << ",\"impair_dropped\":" << st_.impairDropped << ",\"jitter_ms\":" << st_.jitterMs << ",\"rtt_ms\":" << st_.rttMs
      << ",\"rtt_min_ms\":" << (st_.rttSamples ? st_.rttMinMs : 0) << ",\"rtt_max_ms\":" << st_.rttMaxMs << ",\"queue_max\":" << st_.queueMax << ",\"queue_avg\":" << st_.queueAvg << "}";
    return o.str();
}

}  // namespace dsrt
