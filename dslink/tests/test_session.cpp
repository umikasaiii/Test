#include "dslink/advert.hpp"
#include "dslink/kv.hpp"
#include "dslink/netaddr.hpp"
#include "testing.hpp"

using namespace dslink;

namespace {
RoomAdvert sampleAdvert() {
    RoomAdvert a;
    a.appVersion = "1.0.0";
    a.coreVersion = "melonDS DS v1.4.0";
    a.roomName = "Stanza di Simone";
    a.hostIp = "192.168.1.20";
    a.port = 55435;
    a.gameTitle = "Test Game";
    a.sessionId = "s-123456";
    a.hostDeviceId = "aaaa0000000000000000000000000000";
    a.players = 1;
    a.maxPlayers = 4;
    return a;
}
ClientInfo sampleClient() {
    ClientInfo c;
    c.appVersion = "1.0.0";
    c.coreVersion = "melonDS DS v1.4.0";
    c.deviceId = "bbbb0000000000000000000000000000";
    c.nick = "Client-bbbb";
    return c;
}
}  // namespace

TEST(kv_roundtrip_and_strictness) {
    KvMap m{{"a", "1"}, {"b_2", "hello world"}};
    KvMap out;
    CHECK(kvDecode(kvEncode(m), out));
    CHECK(out == m);
    CHECK(!kvDecode("a=1\na=2\n", out));        // duplicate
    CHECK(!kvDecode("noequals\n", out));         // malformed
    CHECK(!kvDecode("A=1\n", out));              // uppercase key
    CHECK(!kvDecode("a=1", out));                // unterminated
    CHECK(!kvDecode(std::string(5000, 'x'), out));
}

TEST(advert_serialization_roundtrip) {
    RoomAdvert a = sampleAdvert();
    RoomAdvert b;
    CHECK(decodeAdvert(encodeAdvert(a), b));
    CHECK_EQ(b.roomName, a.roomName);
    CHECK_EQ(b.hostIp, a.hostIp);
    CHECK_EQ(int(b.port), int(a.port));
    CHECK_EQ(b.coreVersion, a.coreVersion);
    CHECK_EQ(b.sessionId, a.sessionId);
    CHECK(b.mode == SessionMode::DownloadPlay);
    CHECK(advertFitsTxt(a));
}

TEST(advert_parsing_rejects_garbage) {
    RoomAdvert out;
    CHECK(!decodeAdvert("", out));
    CHECK(!decodeAdvert("NOT-A-DSLINK-PACKET\n", out));
    CHECK(!decodeAdvert("DSLINK-ADVERT/1\nproto=1\n", out));  // missing fields
    KvMap kv = advertToKv(sampleAdvert());
    auto bad = [&](const char* k, const char* v) {
        KvMap m = kv;
        m[k] = v;
        RoomAdvert o;
        return advertFromKv(m, o);
    };
    CHECK(!bad("ip", "999.1.1.1"));
    CHECK(!bad("ip", "192.168.1"));
    CHECK(!bad("port", "80"));
    CHECK(!bad("port", "70000"));
    CHECK(!bad("port", "55a"));
    CHECK(!bad("mode", "weird"));
    CHECK(!bad("console", "gba"));
    CHECK(!bad("players", "9"));  // more than max
    CHECK(bad("players", "4"));
    CHECK(!bad("rom_sha", "tooshort"));
}

TEST(session_validation_ok_and_mismatches) {
    RoomAdvert room = sampleAdvert();
    ClientInfo c = sampleClient();
    std::string host = "00:08:BF:00:00:01";
    CHECK(checkCompatibility(room, c, "00:08:BF:00:00:02", &host, 1) == Compat::Ok);

    ClientInfo p = c; p.protocolVersion = 2;
    CHECK(checkCompatibility(room, p, "00:08:BF:00:00:02", &host, 1) == Compat::ProtocolMismatch);
    ClientInfo k = c; k.coreVersion = "melonDS DS v9";
    CHECK(checkCompatibility(room, k, "00:08:BF:00:00:02", &host, 1) == Compat::CoreMismatch);
    ClientInfo d = c; d.console = "dsi";
    CHECK(checkCompatibility(room, d, "00:08:BF:00:00:02", &host, 1) == Compat::ConsoleMismatch);
    ClientInfo m = c; m.mode = SessionMode::MultiRom;
    CHECK(checkCompatibility(room, m, "00:08:BF:00:00:02", &host, 1) == Compat::ModeMismatch);
    ClientInfo s = c; s.deviceId = room.hostDeviceId;
    CHECK(checkCompatibility(room, s, "00:08:BF:00:00:02", &host, 1) == Compat::SelfConnect);
    CHECK(checkCompatibility(room, c, host, &host, 1) == Compat::MacConflict);
    RoomAdvert full = room; full.players = 4;
    CHECK(checkCompatibility(full, c, "00:08:BF:00:00:02", &host, 1) == Compat::RoomFull);
}

TEST(session_rom_hash_only_checked_in_multirom_mode) {
    RoomAdvert room = sampleAdvert();
    std::string host = "00:08:BF:00:00:01";
    room.romSha256 = std::string(64, 'a');
    ClientInfo c = sampleClient();
    // Download Play: client has no ROM, host hash must not matter.
    CHECK(checkCompatibility(room, c, "00:08:BF:00:00:02", &host, 1) == Compat::Ok);
    room.mode = SessionMode::MultiRom;
    c.mode = SessionMode::MultiRom;
    c.romSha256 = std::string(64, 'b');
    CHECK(checkCompatibility(room, c, "00:08:BF:00:00:02", &host, 1) == Compat::RomMismatch);
    c.romSha256 = std::string(64, 'a');
    CHECK(checkCompatibility(room, c, "00:08:BF:00:00:02", &host, 1) == Compat::Ok);
}

TEST(compat_messages_are_human_readable) {
    for (Compat c : {Compat::ProtocolMismatch, Compat::CoreMismatch, Compat::RomMismatch, Compat::RoomFull,
                     Compat::MacConflict, Compat::SelfConnect, Compat::ConsoleMismatch, Compat::ModeMismatch}) {
        std::string msg = compatMessage(c);
        CHECK(msg.size() > 10);
        CHECK(msg.find("NETPLAY") == std::string::npos);
        CHECK(msg.find("0x") == std::string::npos);
    }
    CHECK(compatMessage(Compat::ProtocolMismatch).find("Aggiorna il secondo dispositivo") != std::string::npos);
}

TEST(ipv4_parsing) {
    std::uint32_t ip = 0;
    CHECK(parseIPv4("192.168.1.20", ip));
    CHECK_EQ(ip, 0xC0A80114u);
    CHECK_EQ(formatIPv4(ip), std::string("192.168.1.20"));
    for (const char* bad : {"", "1.2.3", "1.2.3.4.5", "256.1.1.1", "01.2.3.4", "1.2.3.", ".1.2.3", "a.b.c.d", "1..2.3", "1.2.3.4 "})
        CHECK(!parseIPv4(bad, ip));
}

TEST(ipv4_selection_prefers_lan_over_vpn_cellular_loopback) {
    auto mk = [](const char* n, const char* ip, bool lo = false) {
        NetInterface i; i.name = n; parseIPv4(ip, i.ip); i.netmask = 0xFFFFFF00u; i.isLoopback = lo; return i;
    };
    std::vector<NetInterface> v = {mk("lo", "127.0.0.1", true), mk("rmnet_data0", "10.64.2.3"), mk("tun0", "10.8.0.2"),
                                   mk("wlan0", "192.168.1.20")};
    IPv4Choice c = selectBestIPv4(v);
    CHECK(c.found);
    CHECK_EQ(c.iface.name, std::string("wlan0"));
    CHECK(c.vpnPresent);
    CHECK(c.kind == LinkKind::Wifi);

    std::vector<NetInterface> onlyBad = {mk("lo", "127.0.0.1", true), mk("rmnet0", "10.1.1.1"), mk("wlan0", "169.254.3.3")};
    CHECK(!selectBestIPv4(onlyBad).found);

    // Hotspot host (Android ap0 / wlan1) is a valid LAN address.
    std::vector<NetInterface> hs = {mk("rmnet0", "10.1.1.1"), mk("ap0", "192.168.43.1")};
    IPv4Choice h = selectBestIPv4(hs);
    CHECK(h.found && h.kind == LinkKind::Hotspot);
    // Private beats public on the same kind.
    std::vector<NetInterface> two = {mk("wlan0", "8.8.8.8"), mk("wlan1", "10.0.0.5")};
    CHECK_EQ(selectBestIPv4(two).iface.name, std::string("wlan1"));
    // Interface down is ignored.
    auto down = mk("wlan0", "192.168.1.20"); down.up = false;
    CHECK(!selectBestIPv4({down}).found);
}

TEST(subnet_helpers) {
    std::uint32_t a, b;
    parseIPv4("192.168.1.20", a); parseIPv4("192.168.1.99", b);
    CHECK(sameSubnet(a, b, 0xFFFFFF00u));
    parseIPv4("192.168.2.99", b);
    CHECK(!sameSubnet(a, b, 0xFFFFFF00u));
    CHECK_EQ(prefixLength(0xFFFFFF00u), 24u);
    CHECK_EQ(prefixLength(0xFF00FF00u), 0u);  // non contiguous
    CHECK(isLinkLocal(0xA9FE0101u));
    CHECK(isPrivate(0xAC100001u) && !isPrivate(0xAC200001u));
}

TEST(port_handling) {
    std::uint16_t p = 0;
    CHECK(parsePort("55435", p) && p == 55435);
    CHECK(!parsePort("", p));
    CHECK(!parsePort("80", p));
    CHECK(!parsePort("65536", p));
    CHECK(!parsePort("12ab", p));
    CHECK(!parsePort("-1", p));
    // pickPort skips an occupied port.
    std::uint16_t base = pickPort(47000);
    CHECK(base != 0);
    CHECK(portIsFree(base));
    CHECK(validPort(1024) && !validPort(1023));
}
