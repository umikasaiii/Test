// DSLink Radio Protocol (DRP) over UDP: the LAN RadioTransport of the Multiplayer Bridge (Distributed Mode).
// It carries ONLY the frames the DS core hands to the libretro netpacket interface (the emulated DS radio); no video, audio or input.
// Datagram = fixed 36-byte header + payload. Integrity/authentication: SipHash-2-4 (64-bit tag) keyed with a per-session key derived from the
// join secret; format validation (magic, version, length). No retransmission (a radio medium is lossy); a bounded re-sequencer restores
// order for a few ms, then treats the gap as loss. See docs/DISTRIBUTED_MODE.md.
#pragma once
#include <netinet/in.h>

#include <cstdint>
#include <functional>
#include <map>
#include <string>
#include <vector>

namespace dsrt {

struct LanImpair { double delayMs = 0, jitterMs = 0, lossPct = 0; bool active() const { return delayMs > 0 || jitterMs > 0 || lossPct > 0; } };

struct LanConfig {
    std::string code;                 // 6-digit room code (discovery + join proof)
    std::string secretHex;            // 32 hex chars: out-of-band secret (QR). Empty on the host = generated; empty on a guest = code-only join
    std::string bindAddr = "0.0.0.0";
    int port = 0;                     // data port (0 = ephemeral)
    int discoveryPort = 47531;        // UDP discovery port (host listens, guest asks)
    std::string discoveryAddr = "255.255.255.255";   // guest: where to send DISCOVER (tests: 127.0.0.1)
    std::string hostAddr;             // guest: "ip:port" skips discovery (debug / QR with address)
    std::string name = "DSLink";      // shown to the guest in ANNOUNCE
    LanImpair impair;                 // test-only network impairment applied to outgoing data/ping/pong
    int reorderMs = 8;                // how long a gap is waited for before it is declared lost
    int maxPeers = 3;
    int peerTimeoutMs = 4000;
    uint32_t seed = 0;                // 0 = random
};

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

class LanLink {
public:
    using DataFn = std::function<void(uint16_t peerId, uint16_t dest, uint16_t src, const uint8_t* p, size_t n)>;
    using JoinFn = std::function<bool(uint16_t peerId)>;     // host: accept the new peer? (the bridge's netpacket.connected)
    using LostFn = std::function<void(uint16_t peerId)>;
    ~LanLink();

    // Host: bind, listen for joins and discovery requests. Fills code/secret if empty.
    bool hostStart(LanConfig& cfg, std::string& err);
    // Guest: find the host (discovery or direct address), join, return the assigned id.
    bool clientJoin(const LanConfig& cfg, int timeoutMs, uint16_t& assignedId, std::string& err);
    void stop();

    void setHandlers(DataFn d, JoinFn j, LostFn l) { onData_ = std::move(d); onJoin_ = std::move(j); onLost_ = std::move(l); }
    // one bridge tick: read datagrams, release the impairment queue, re-sequencer deadlines, pings, timeouts
    void poll();
    // payload for the netpacket 'send' path. peerId: host -> that client; guest -> ignored (always the host)
    void sendData(uint16_t peerId, uint16_t dest, uint16_t src, const void* p, size_t n);

    bool isHost() const { return host_; }
    size_t peers() const { return peers_.size(); }
    uint16_t myId() const { return myId_; }
    uint32_t sessionId() const { return session_; }
    int port() const { return port_; }
    const LanStats& stats() const { return st_; }
    std::string joinUri(const std::string& ip) const;     // dslink://join?c=CODE&s=SECRET&h=IP:PORT
    std::string json() const;

    static bool parseUri(const std::string& uri, LanConfig& cfg);
    static std::string makeCode();

private:
    struct Buffered { std::vector<uint8_t> payload; uint16_t dest, src; double at; };
    struct Peer {
        uint16_t id = 0;
        sockaddr_in addr{};
        uint8_t nonceH[8]{};         // host side: the nonce answered to this peer (a retransmitted JOIN gets the same WELCOME)
        uint8_t ks[16]{};            // per-peer session key (secret + both join nonces)
        uint32_t txSeq = 0, nextRx = 0;
        bool rxStarted = false;
        std::map<uint32_t, Buffered> reseq;
        double lastRx = 0, lastPing = 0;
        double lastArrival = 0, lastTs = 0; bool haveJ = false;
    };
    struct Delayed { double due; std::vector<uint8_t> bytes; sockaddr_in to; };

    bool openSocket(const std::string& bind, int port, std::string& err);
    void rawSend(const sockaddr_in& to, uint8_t type, uint16_t peerId, uint32_t seq, uint16_t dest, uint16_t src, const void* p, size_t n, bool impair, const uint8_t* key);
    void handleDatagram(const uint8_t* d, size_t n, const sockaddr_in& from, double now);
    void deliverInOrder(Peer& p, double now, bool filledGap);
    void dropPeer(size_t idx, bool tellPeer);
    void discoveryTick();
    Peer* peerById(uint16_t id);
    static double nowMs();
    uint32_t rnd();

    bool host_ = false;
    int fd_ = -1, discFd_ = -1;
    int port_ = 0;
    LanConfig cfg_;
    uint32_t session_ = 0;
    uint8_t secret_[16]{}, k0_[16]{};
    uint16_t myId_ = 0;
    std::vector<Peer> peers_;       // host: clients; guest: [0] = host
    std::vector<Delayed> delayed_;
    DataFn onData_; JoinFn onJoin_; LostFn onLost_;
    LanStats st_;
    uint64_t rngState_ = 0x9E3779B97F4A7C15ull;
    double badJoinWindowStart_ = 0; int badJoins_ = 0; double lockedUntil_ = 0;
    uint32_t ctlSeq_ = 0;
};

}  // namespace dsrt
