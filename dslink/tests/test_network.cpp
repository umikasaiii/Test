#include <cstdio>
#include <thread>

#include "dslink/control.hpp"
#include "dslink/identity.hpp"
#include "dslink/netaddr.hpp"
#include "testing.hpp"

using namespace dslink;

namespace {
RoomAdvert advert() {
    RoomAdvert a;
    a.appVersion = "1.0.0"; a.coreVersion = "core-1"; a.roomName = "Room"; a.hostIp = "127.0.0.1";
    a.port = 55435; a.sessionId = "sess1"; a.hostDeviceId = "aaaa0000000000000000000000000000";
    a.maxPlayers = 3;
    return a;
}
ClientInfo client(const std::string& dev) {
    ClientInfo c;
    c.appVersion = "1.0.0"; c.coreVersion = "core-1"; c.deviceId = dev; c.nick = "Nick-" + dev.substr(0, 4);
    return c;
}
std::string dev(char c) { return std::string(4, c) + std::string(28, '0'); }
// Distinct fake MACs (the real derivation is covered in test_identity).
std::string macOf(char c) { char b[18]; std::snprintf(b, sizeof b, "00:08:BF:00:00:%02X", unsigned(c)); return b; }
}  // namespace

TEST(packet_codec_roundtrip_and_rejects_garbage) {
    Packet p{MsgType::Ping, 513, "hi"};
    std::string w = encodePacket(p);
    Packet q;
    CHECK(decodePacket(w.data(), w.size(), q));
    CHECK(q.type == MsgType::Ping && q.seq == 513 && q.payload == "hi");
    CHECK(!decodePacket("DSLK", 4, q));
    std::string bad = w; bad[0] = 'X';
    CHECK(!decodePacket(bad.data(), bad.size(), q));
    bad = w; bad[4] = 99;  // wrong wire version
    CHECK(!decodePacket(bad.data(), bad.size(), q));
    bad = w; bad.push_back('x');  // length mismatch
    CHECK(!decodePacket(bad.data(), bad.size(), q));
    bad = w; bad[5] = 77;  // unknown type
    CHECK(!decodePacket(bad.data(), bad.size(), q));
}

TEST(control_hello_accepts_compatible_client_and_tracks_peer) {
    ControlServer s(advert(), "HostNick", "00:08:BF:11:11:11");
    std::string err;
    CHECK(s.start(0, err));
    std::atomic<int> joined{0};
    s.setOnPeerJoined([&](const PeerRecord&) { ++joined; });
    HelloResult r = sendHello("127.0.0.1", s.port(), client(dev('b')), macOf('b'));
    CHECK(r.ok && r.reachable);
    CHECK_EQ(r.hostNick, std::string("HostNick"));
    CHECK_EQ(r.sessionId, std::string("sess1"));
    CHECK_EQ(s.peers().size(), std::size_t(1));
    CHECK_EQ(s.room().players, 2u);
    CHECK_EQ(joined.load(), 1);
    // The same device re-sending Hello (retry) must not take a second slot.
    CHECK(sendHello("127.0.0.1", s.port(), client(dev('b')), macOf('b')).ok);
    CHECK_EQ(s.peers().size(), std::size_t(1));
    s.stop();
}

TEST(control_hello_rejects_version_mismatch_with_clear_reason) {
    ControlServer s(advert(), "HostNick", "00:08:BF:11:11:11");
    std::string err;
    CHECK(s.start(0, err));
    ClientInfo c = client(dev('c'));
    c.protocolVersion = 7;
    HelloResult r = sendHello("127.0.0.1", s.port(), c, macOf('c'));
    CHECK(r.reachable && !r.ok);
    CHECK(r.compat == Compat::ProtocolMismatch);
    CHECK_EQ(s.peers().size(), std::size_t(0));
    c = client(dev('c'));
    c.coreVersion = "other-core";
    r = sendHello("127.0.0.1", s.port(), c, macOf('c'));
    CHECK(r.compat == Compat::CoreMismatch);
    s.stop();
}

TEST(control_hello_detects_mac_conflict_and_room_full) {
    ControlServer s(advert(), "HostNick", "00:08:BF:11:11:11");
    std::string err;
    CHECK(s.start(0, err));
    CHECK(sendHello("127.0.0.1", s.port(), client(dev('b')), macOf('b')).ok);
    // d claims the same MAC as b
    HelloResult r = sendHello("127.0.0.1", s.port(), client(dev('d')), macOf('b'));
    CHECK(r.reachable && !r.ok && r.compat == Compat::MacConflict);
    // claims the host's MAC
    r = sendHello("127.0.0.1", s.port(), client(dev('d')), "00:08:BF:11:11:11");
    CHECK(r.compat == Compat::MacConflict);
    CHECK(sendHello("127.0.0.1", s.port(), client(dev('d')), macOf('d')).ok);  // max 3 players: host + b + d
    r = sendHello("127.0.0.1", s.port(), client(dev('e')), macOf('e'));
    CHECK(r.reachable && r.compat == Compat::RoomFull);
    s.stop();
}

TEST(control_unreachable_host_times_out_cleanly) {
    std::uint16_t p = pickPort(48000);
    HelloResult r = sendHello("127.0.0.1", p, client(dev('b')), macOf('b'), 80);
    CHECK(!r.reachable && !r.ok);
    CHECK_EQ(r.error, std::string("TIMEOUT"));
}

TEST(control_bye_and_timeout_remove_peers) {
    ControlServer s(advert(), "HostNick", "00:08:BF:11:11:11");
    std::string err;
    CHECK(s.start(0, err));
    std::atomic<int> left{0};
    s.setOnPeerLeft([&](const PeerRecord&) { ++left; });
    CHECK(sendHello("127.0.0.1", s.port(), client(dev('b')), macOf('b')).ok);
    sendBye("127.0.0.1", s.port(), dev('b'));
    for (int i = 0; i < 40 && s.peers().size(); ++i) std::this_thread::sleep_for(std::chrono::milliseconds(25));
    CHECK_EQ(s.peers().size(), std::size_t(0));
    CHECK_EQ(left.load(), 1);
    // silent client expires
    s.setPeerTimeoutMs(150);
    CHECK(sendHello("127.0.0.1", s.port(), client(dev('c')), macOf('c')).ok);
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    CHECK_EQ(s.peers().size(), std::size_t(0));
    CHECK_EQ(left.load(), 2);
    s.stop();
}

TEST(control_port_in_use_is_reported) {
    ControlServer a(advert(), "A", "00:08:BF:11:11:11");
    ControlServer b(advert(), "B", "00:08:BF:11:11:12");
    std::string err;
    CHECK(a.start(0, err));
    CHECK(!b.start(a.port(), err));
    CHECK_EQ(err, std::string("porta occupata"));
    a.stop();
}

TEST(latency_probe_over_loopback) {
    ControlServer s(advert(), "HostNick", "00:08:BF:11:11:11");
    std::string err;
    CHECK(s.start(0, err));
    LatencyStats st = probeLatency("127.0.0.1", s.port(), 10, 5, 200);
    CHECK_EQ(st.sent, 10u);
    CHECK_EQ(st.received, 10u);
    CHECK(st.avgMs < 20.0);
    CHECK(classify(st) != Quality::Insufficient);
    s.stop();
    // after the host is gone every probe is lost
    LatencyStats gone = probeLatency("127.0.0.1", s.port(), 3, 5, 30);
    CHECK_EQ(gone.received, 0u);
    CHECK(classify(gone) == Quality::Insufficient);
}

TEST(beacon_announce_and_listen_over_loopback) {
    std::uint16_t bport = pickPort(49000);
    CHECK(bport != 0);
    BeaconListener l;
    std::string err;
    CHECK(l.start(bport, err));
    BeaconAnnouncer a;
    RoomAdvert ad = advert();
    CHECK(a.start([&] { return ad; }, {"127.0.0.1"}, bport, 50));
    std::vector<DiscoveredRoom> rooms;
    for (int i = 0; i < 60 && rooms.empty(); ++i) {
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
        rooms = l.rooms();
    }
    CHECK_EQ(rooms.size(), std::size_t(1));
    if (!rooms.empty()) {
        CHECK_EQ(rooms[0].advert.roomName, std::string("Room"));
        CHECK_EQ(rooms[0].sourceIp, std::string("127.0.0.1"));
    }
    a.stop();
    // stale rooms age out
    std::this_thread::sleep_for(std::chrono::milliseconds(150));
    CHECK_EQ(l.rooms(100).size(), std::size_t(0));
    l.stop();
}
