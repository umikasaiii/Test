// Unit tests of the LAN RadioTransport (DSLink Radio Protocol over UDP) on the loopback interface: discovery, join (code-only and QR secret),
// authentication, per-peer keys, ordering/loss/jitter behaviour, forged datagrams, lockout, timeouts. No emulator involved.
#include <arpa/inet.h>
#include <sys/socket.h>
#include <unistd.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <thread>
#include <vector>

#include "radio_lan.hpp"

using namespace dsrt;
static int g_fail = 0, g_n = 0;
#define CHECK(c, msg) do { ++g_n; if (!(c)) { ++g_fail; std::printf("FAIL  %s  (%s:%d)\n", msg, __FILE__, __LINE__); } else std::printf("PASS  %s\n", msg); } while (0)
static void sleepMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

struct Rx { uint16_t peer, dest, src; std::vector<uint8_t> data; };
// one LanLink polled by its own thread (a LanLink is single-threaded by design, like the bridge's main loop)
struct Node {
    LanLink link; std::mutex lm, mu; /* lm: link (poll thread vs send), mu: received lists */ std::vector<Rx> got; std::vector<uint16_t> joined, lost; std::atomic<bool> run{false}; std::thread th;
    void wire() {
        link.setHandlers([this](uint16_t p, uint16_t d, uint16_t s, const uint8_t* b, size_t n) { std::lock_guard<std::mutex> l(mu); got.push_back({p, d, s, std::vector<uint8_t>(b, b + n)}); },
                         [this](uint16_t p) { std::lock_guard<std::mutex> l(mu); joined.push_back(p); return true; },
                         [this](uint16_t p) { std::lock_guard<std::mutex> l(mu); lost.push_back(p); });
    }
    void start() { run = true; th = std::thread([this] { while (run) { { std::lock_guard<std::mutex> l(lm); link.poll(); } sleepMs(1); } }); }
    void stopThread() { run = false; if (th.joinable()) th.join(); }
    size_t count() { std::lock_guard<std::mutex> l(mu); return got.size(); }
    void send(uint16_t peer, uint16_t dest, uint16_t src, const std::vector<uint8_t>& b) { std::lock_guard<std::mutex> l(lm); link.sendData(peer, dest, src, b.data(), b.size()); }
    ~Node() { stopThread(); }
};
static std::vector<uint8_t> pkt(uint32_t i, size_t n = 40) { std::vector<uint8_t> b(n); for (size_t k = 0; k < n; k++) b[k] = uint8_t(i * 7 + k); std::memcpy(b.data(), &i, 4); return b; }
static uint32_t idOf(const Rx& r) { uint32_t v; std::memcpy(&v, r.data.data(), 4); return v; }

static LanConfig hostCfg(int discPort, const char* code = "482731") { LanConfig c; c.code = code; c.bindAddr = "127.0.0.1"; c.discoveryPort = discPort; c.seed = 11; return c; }
static LanConfig guestCfg(int discPort, const char* code = "482731") { LanConfig c; c.code = code; c.discoveryAddr = "127.0.0.1"; c.discoveryPort = discPort; c.seed = 22; return c; }

int main() {
    setvbuf(stdout, nullptr, _IOLBF, 0);
    // ---- discovery + code-only join
    {
        Node h, g; std::string err; LanConfig hc = hostCfg(47601);
        CHECK(h.link.hostStart(hc, err), "host starts (bind + discovery socket)"); h.wire(); h.start();
        uint16_t id = 99; LanConfig gc = guestCfg(47601);
        CHECK(g.link.clientJoin(gc, 3000, id, err), ("guest finds the host by code via discovery and joins: " + err).c_str());
        CHECK(id == 1, "first guest gets id 1"); g.wire(); g.start(); sleepMs(100);
        { std::lock_guard<std::mutex> l(h.mu); CHECK(h.joined.size() == 1 && h.joined[0] == 1, "host's join callback fired once with id 1"); }
        // ---- data both ways, in order, payload intact
        for (uint32_t i = 0; i < 500; i++) { g.send(0, 0, 1, pkt(i)); h.send(1, 1, 0, pkt(1000 + i, 300)); sleepMs(1); }
        sleepMs(200);
        bool ok = h.count() == 500 && g.count() == 500;
        { std::lock_guard<std::mutex> l(h.mu); for (size_t i = 0; i < h.got.size() && ok; i++) ok = idOf(h.got[i]) == i && h.got[i].data == pkt(uint32_t(i)) && h.got[i].peer == 1 && h.got[i].dest == 0 && h.got[i].src == 1; }
        { std::lock_guard<std::mutex> l(g.mu); for (size_t i = 0; i < g.got.size() && ok; i++) ok = idOf(g.got[i]) == 1000 + i && g.got[i].data == pkt(1000 + uint32_t(i), 300); }
        CHECK(ok, "500 packets each way arrive complete, in order, byte-exact (dest/src preserved)");
        CHECK(h.link.stats().lost == 0 && g.link.stats().lost == 0, "no loss on a clean loopback");
        sleepMs(1300);
        CHECK(h.link.stats().rttSamples > 0 && g.link.stats().rttSamples > 0 && g.link.stats().rttMs < 20, "ping/pong measures RTT");
        // ---- forged datagrams are rejected
        int s = ::socket(AF_INET, SOCK_DGRAM, 0); sockaddr_in to{}; to.sin_family = AF_INET; to.sin_port = htons(uint16_t(h.link.port())); to.sin_addr.s_addr = inet_addr("127.0.0.1");
        uint8_t junk[64]; for (int i = 0; i < 64; i++) junk[i] = uint8_t(i);
        ::sendto(s, junk, 64, 0, reinterpret_cast<sockaddr*>(&to), sizeof to);
        uint8_t forged[44]; std::memset(forged, 0, sizeof forged); uint32_t magic = 0x524C5344u; std::memcpy(forged, &magic, 4); forged[4] = 1; forged[5] = 3; uint32_t len = 8; std::memcpy(forged + 20, &len, 4);
        ::sendto(s, forged, 44, 0, reinterpret_cast<sockaddr*>(&to), sizeof to);
        size_t before = h.count(); sleepMs(100);
        CHECK(h.count() == before, "datagrams with bad format or from unknown peers are never delivered");
        ::close(s);
        // ---- BYE on stop: the other side sees the peer leave
        g.stopThread(); g.link.stop(); sleepMs(100);
        { std::lock_guard<std::mutex> l(h.mu); CHECK(h.lost.size() == 1 && h.lost[0] == 1, "BYE: the host learns immediately that the guest left"); }
    }
    // ---- QR join (secret out of band) and multiple guests with distinct ids and keys
    {
        Node h, g1, g2; std::string err; LanConfig hc = hostCfg(47602);
        CHECK(h.link.hostStart(hc, err), "host 2 starts"); h.wire(); h.start();
        std::string uri = h.link.joinUri("127.0.0.1");
        LanConfig q; CHECK(LanLink::parseUri(uri, q) && q.secretHex.size() == 32 && q.hostAddr.find("127.0.0.1:") == 0, "QR/URI round-trips (code, secret, address)");
        uint16_t i1 = 0, i2 = 0; q.seed = 33;
        CHECK(g1.link.clientJoin(q, 3000, i1, err), "guest joins directly from the QR (no discovery)");
        LanConfig g2c = guestCfg(47602); g2c.seed = 44;
        CHECK(g2.link.clientJoin(g2c, 3000, i2, err), "second guest joins by code");
        CHECK(i1 == 1 && i2 == 2, "ids 1 and 2"); g1.wire(); g2.wire(); g1.start(); g2.start(); sleepMs(50);
        h.send(1, 1, 0, pkt(7)); h.send(2, 2, 0, pkt(8)); h.send(0xFFFF, 0xFFFF, 0, pkt(9)); sleepMs(100);
        { std::lock_guard<std::mutex> a(g1.mu); std::lock_guard<std::mutex> b(g2.mu);
          CHECK(g1.got.size() == 1 && idOf(g1.got[0]) == 7 && g2.got.size() == 1 && idOf(g2.got[0]) == 8, "per-peer keys: each guest receives only its own unicast"); }
        LanConfig g3c = guestCfg(47602); g3c.seed = 55; Node g3, g4; uint16_t i3 = 0, i4 = 0;
        CHECK(g3.link.clientJoin(g3c, 2000, i3, err) && i3 == 3, "third guest fits (max 3)");
        LanConfig g4c = guestCfg(47602); g4c.seed = 66;
        CHECK(!g4.link.clientJoin(g4c, 1500, i4, err), "a fourth guest is refused (room full)");
    }
    // ---- wrong code / wrong secret / brute-force lockout
    {
        Node h, g; std::string err; LanConfig hc = hostCfg(47603); h.link.hostStart(hc, err); h.wire(); h.start();
        uint16_t id = 0; LanConfig bad = guestCfg(47603, "000000");
        CHECK(!g.link.clientJoin(bad, 1200, id, err), "discovery with a wrong code finds nothing");
        Node g2; LanConfig bad2 = guestCfg(47603, "000001"); bad2.hostAddr = "127.0.0.1:" + std::to_string(h.link.port());
        CHECK(!g2.link.clientJoin(bad2, 1500, id, err), "direct join with a wrong code is refused");
        { std::lock_guard<std::mutex> l(h.mu); CHECK(h.link.stats().badAuth > 0 && h.joined.empty(), "host counted the bad proof and added no peer"); }
        Node g3; LanConfig bad3 = guestCfg(47603); bad3.secretHex = "00112233445566778899aabbccddeeff"; bad3.hostAddr = bad2.hostAddr;
        CHECK(!g3.link.clientJoin(bad3, 1200, id, err), "join with the right code but a wrong secret is refused");
        for (int i = 0; i < 4; i++) { Node gx; LanConfig b = guestCfg(47603, "111111"); b.hostAddr = bad2.hostAddr; gx.link.clientJoin(b, 700, id, err); }
        Node g4; LanConfig good = guestCfg(47603); good.hostAddr = bad2.hostAddr;
        CHECK(!g4.link.clientJoin(good, 1500, id, err), "brute-force throttle: after repeated bad proofs even the right code is locked out for a while");
    }
    // ---- loss: gaps are counted, nothing duplicated or corrupted
    {
        Node h, g; std::string err; LanConfig hc = hostCfg(47604); hc.impair.lossPct = 10; h.link.hostStart(hc, err); h.wire(); h.start();
        uint16_t id; LanConfig gc = guestCfg(47604); g.link.clientJoin(gc, 3000, id, err); g.wire(); g.start();
        for (uint32_t i = 0; i < 1000; i++) { h.send(1, 1, 0, pkt(i)); sleepMs(1); }
        sleepMs(300);
        std::lock_guard<std::mutex> l(g.mu);
        bool mono = true; for (size_t i = 1; i < g.got.size(); i++) mono &= idOf(g.got[i]) > idOf(g.got[i - 1]);
        double pct = 100.0 * (1000 - double(g.got.size())) / 1000.0;
        CHECK(mono && g.got.size() > 800 && g.got.size() < 980, ("10% injected loss: delivered strictly increasing, " + std::to_string(g.got.size()) + "/1000 received").c_str());
        CHECK(g.link.stats().lost + 25 >= uint64_t(1000 - g.got.size()) && g.link.stats().lost <= uint64_t(1000 - g.got.size()) + 25, ("receiver's loss counter matches (" + std::to_string(g.link.stats().lost) + " vs " + std::to_string(pct) + "%)").c_str());
    }
    // ---- jitter reorders datagrams: the re-sequencer restores order inside its window, drops what is later
    {
        Node h, g; std::string err; LanConfig hc = hostCfg(47605); hc.impair.delayMs = 12; hc.impair.jitterMs = 10; h.link.hostStart(hc, err); h.wire(); h.start();
        uint16_t id; LanConfig gc = guestCfg(47605); gc.reorderMs = 40; g.link.clientJoin(gc, 3000, id, err); g.wire(); g.start();
        for (uint32_t i = 0; i < 800; i++) { h.send(1, 1, 0, pkt(i)); if (i % 3 == 0) sleepMs(1); }
        sleepMs(400);
        std::lock_guard<std::mutex> l(g.mu);
        bool mono = true; for (size_t i = 1; i < g.got.size(); i++) mono &= idOf(g.got[i]) > idOf(g.got[i - 1]);
        CHECK(mono && g.got.size() == 800 && g.link.stats().reordered > 0 && g.link.stats().lost == 0, ("jitter 10 ms, window 40 ms: all 800 delivered in order (" + std::to_string(g.link.stats().reordered) + " re-sequenced)").c_str());
    }
    // ---- peer silence: timeout
    {
        Node h, g; std::string err; LanConfig hc = hostCfg(47606); hc.peerTimeoutMs = 600; h.link.hostStart(hc, err); h.wire(); h.start();
        uint16_t id; LanConfig gc = guestCfg(47606); g.link.clientJoin(gc, 3000, id, err);   // never polled afterwards: silent peer
        sleepMs(1500);
        std::lock_guard<std::mutex> l(h.mu); CHECK(h.lost.size() == 1 && h.link.peers() == 0, "a silent peer is dropped after the timeout");
    }
    std::printf("\n%d/%d checks passed\n", g_n - g_fail, g_n);
    return g_fail ? 1 : 0;
}
