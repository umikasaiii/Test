// DSLink - control channel (UDP, same port number as the TCP Netplay port) and LAN beacon discovery.
// The control channel does what RetroArch's Netplay handshake cannot: DSLink-level compatibility checks
// (protocol / core / mode / ROM hash / MAC conflict) with human-readable rejections, plus RTT/jitter probes.
#pragma once
#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include "dslink/advert.hpp"
#include "dslink/latency.hpp"

namespace dslink {

enum class MsgType : std::uint8_t { Hello = 1, HelloAck = 2, HelloReject = 3, Ping = 4, Pong = 5, Bye = 6 };

struct Packet {
    MsgType type = MsgType::Ping;
    std::uint16_t seq = 0;
    std::string payload;
};
constexpr std::size_t kMaxPayload = 1024;
// Frame: "DSLK" | version(1) | type(1) | seq(2, BE) | payloadLen(2, BE) | payload
std::string encodePacket(const Packet& p);
bool decodePacket(const void* data, std::size_t len, Packet& out);

KvMap clientInfoToKv(const ClientInfo& c, const std::string& mac);
bool clientInfoFromKv(const KvMap& kv, ClientInfo& out, std::string& mac);

struct PeerRecord {
    std::string deviceId, nick, mac, ip;
    std::int64_t lastSeenMs = 0;
};

// Host side. Answers Hello (validates with checkCompatibility) and Ping. Runs on its own thread.
class ControlServer {
public:
    ControlServer(RoomAdvert room, std::string hostNick, std::string hostMac);
    ~ControlServer();
    // Binds UDP 0.0.0.0:port. On failure fills 'error' (e.g. "porta occupata") and returns false.
    bool start(std::uint16_t port, std::string& error);
    void stop();
    std::uint16_t port() const { return port_; }
    std::vector<PeerRecord> peers();     // peers that said Hello and were seen in the last 'peerTimeoutMs'
    RoomAdvert room();                   // with live player count
    void setPeerTimeoutMs(int ms) { peerTimeoutMs_ = ms; }
    // Called (from the server thread) after a client is accepted / dropped (Bye or timeout). Thread-safe to set
    // at any time.
    using PeerCallback = std::function<void(const PeerRecord&)>;
    void setOnPeerJoined(PeerCallback cb);
    void setOnPeerLeft(PeerCallback cb);

private:
    void loop();
    void expire(std::int64_t now);
    RoomAdvert room_;
    std::string hostNick_, hostMac_;
    int fd_ = -1;
    std::uint16_t port_ = 0;
    std::atomic<bool> run_{false};
    std::thread th_;
    std::mutex mu_;
    std::map<std::string, PeerRecord> peers_;
    std::atomic<int> peerTimeoutMs_{15000};
    PeerCallback onJoined_, onLeft_;  // guarded by mu_
};

struct HelloResult {
    bool ok = false;          // true only when the host accepted
    bool reachable = false;   // false = timeout / no answer
    Compat compat = Compat::Ok;
    std::string hostNick, hostMac, sessionId, error;  // 'error' = technical, for the log
};
// Client side helpers (blocking, UDP). timeoutMs applies to each attempt; 3 attempts are made.
HelloResult sendHello(const std::string& ip, std::uint16_t port, const ClientInfo& me, const std::string& myMac,
                      int timeoutMs = 700);
void sendBye(const std::string& ip, std::uint16_t port, const std::string& deviceId);
// Sends 'count' pings spaced by 'intervalMs'; lost pings count towards loss.
LatencyStats probeLatency(const std::string& ip, std::uint16_t port, int count = 20, int intervalMs = 30,
                          int timeoutMs = 250);

std::int64_t nowMs();

// Broadcast beacon (Android / desktop). iOS needs the multicast entitlement for this, so it uses Bonjour instead.
class BeaconAnnouncer {
public:
    ~BeaconAnnouncer() { stop(); }
    // 'targets' are dotted IPv4s that receive the advert (e.g. "255.255.255.255" or the subnet broadcast).
    bool start(const std::function<RoomAdvert()>& advertProvider, std::vector<std::string> targets,
               std::uint16_t beaconPort = kBeaconPort, int intervalMs = 1000);
    void stop();

private:
    std::atomic<bool> run_{false};
    std::thread th_;
};

struct DiscoveredRoom {
    RoomAdvert advert;
    std::string sourceIp;  // where the beacon really came from (trusted over the 'ip' field if they differ)
    std::int64_t lastSeenMs = 0;
};

class BeaconListener {
public:
    ~BeaconListener() { stop(); }
    bool start(std::uint16_t beaconPort, std::string& error);
    void stop();
    std::vector<DiscoveredRoom> rooms(int maxAgeMs = 4000);

private:
    int fd_ = -1;
    std::atomic<bool> run_{false};
    std::thread th_;
    std::mutex mu_;
    std::map<std::string, DiscoveredRoom> rooms_;
};

}  // namespace dslink
