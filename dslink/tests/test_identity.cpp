#include <cstdio>
#include <iostream>
#include <random>
#include <string>
#include <set>
#include <unistd.h>

#include "dslink/identity.hpp"
#include "dslink/sha256.hpp"
#include "testing.hpp"

using namespace dslink;

namespace {
struct PrngRandom : RandomSource {
    std::mt19937_64 g{12345};
    void fill(std::uint8_t* out, std::size_t len) override { for (std::size_t i = 0; i < len; ++i) out[i] = std::uint8_t(g()); }
};
struct SeqRandom : RandomSource {
    unsigned char n;
    explicit SeqRandom(unsigned char s) : n(s) {}
    void fill(std::uint8_t* out, std::size_t len) override { for (std::size_t i = 0; i < len; ++i) out[i] = n++; }
};
std::string tmpPath(const char* tag) {
    return std::string("/tmp/dslink_test_") + tag + "_" + std::to_string(getpid());
}
}  // namespace

TEST(sha256_known_vectors) {
    CHECK_EQ(toHex(sha256("")), std::string("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"));
    CHECK_EQ(toHex(sha256("abc")), std::string("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    CHECK_EQ(toHex(sha256("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")),
             std::string("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"));
    std::string mil(1000000, 'a');
    CHECK_EQ(toHex(sha256(mil)), std::string("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"));
}

TEST(sha256_file_streaming) {
    std::string p = tmpPath("sha");
    std::FILE* f = std::fopen(p.c_str(), "wb");
    std::fputs("abc", f);
    std::fclose(f);
    std::string hex;
    CHECK(sha256File(p, hex));
    CHECK_EQ(hex, std::string("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"));
    std::remove(p.c_str());
    CHECK(!sha256File("/nonexistent/dslink/file", hex));
}

TEST(identity_creation) {
    SeqRandom r(1);
    DeviceIdentity id = createIdentity(r);
    CHECK_EQ(id.deviceId.size(), std::size_t(32));
    CHECK_EQ(id.deviceId, std::string("0102030405060708090a0b0c0d0e0f10"));
    CHECK_EQ(id.playerName, std::string("Player-0102"));
    CHECK(validPlayerName(id.playerName));
    CHECK(!id.netplayNick().empty() && id.netplayNick().size() <= 31);
}

TEST(identity_persistence) {
    std::string p = tmpPath("id");
    std::remove(p.c_str());
    SeqRandom r1(10), r2(99);
    bool created = false;
    DeviceIdentity a = loadOrCreateIdentity(p, r1, &created);
    CHECK(created);
    DeviceIdentity b = loadOrCreateIdentity(p, r2, &created);  // must NOT regenerate
    CHECK(!created);
    CHECK_EQ(a.deviceId, b.deviceId);
    CHECK_EQ(macToString(a.mac()), macToString(b.mac()));
    // rename survives a restart
    b.playerName = "Simone";
    CHECK(saveIdentity(p, b));
    DeviceIdentity c = loadOrCreateIdentity(p, r2, &created);
    CHECK_EQ(c.playerName, std::string("Simone"));
    CHECK_EQ(c.deviceId, a.deviceId);
    std::remove(p.c_str());
}

TEST(identity_corrupt_file_is_replaced) {
    std::string p = tmpPath("bad");
    std::FILE* f = std::fopen(p.c_str(), "wb");
    std::fputs("garbage without equals\n", f);
    std::fclose(f);
    SeqRandom r(5);
    bool created = false;
    DeviceIdentity id = loadOrCreateIdentity(p, r, &created);
    CHECK(created);
    CHECK_EQ(id.deviceId.size(), std::size_t(32));
    DeviceIdentity again;
    CHECK(loadIdentity(p, again));
    std::remove(p.c_str());
}

TEST(mac_known_answers_match_reference_mt19937) {
    // Reference values computed with an independent Python MT19937 implementation of the melonDS DS algorithm.
    CHECK_EQ(macToString(macFromNickname("Player-1A2B")), std::string("00:08:BF:90:F9:18"));
    CHECK_EQ(macToString(macFromNickname("Simone-ab12")), std::string("00:08:BF:0E:61:B9"));
    CHECK_EQ(macToString(macFromNickname("a")), std::string("00:08:BF:0A:2F:E8"));
    CHECK_EQ(macToString(macFromNickname("Mario-0000-1")), std::string("00:08:BF:85:64:CB"));
}

TEST(macs_differ_between_devices) {
    std::set<std::string> macs;
    PrngRandom r;
    for (int i = 0; i < 2000; ++i) {
        DeviceIdentity id = createIdentity(r);
        macs.insert(macToString(id.mac()));
    }
    // 2000 devices over a 24-bit MAC space: expected birthday collisions ~0.12, so allow at most 1.
    CHECK(macs.size() >= 1999);
    std::cout << "  (unique MACs: " << macs.size() << "/2000)\n";
    // Same name, different devices -> still different thanks to the deviceId suffix.
    // Regression: with a hex-suffix nickname "aaaa" and "bbbb" cancelled out in the core's hash and collided.
    DeviceIdentity a, b;
    a.deviceId = "aaaa0000000000000000000000000000"; a.playerName = "Simone";
    b.deviceId = "bbbb0000000000000000000000000000"; b.playerName = "Simone";
    CHECK(macToString(a.mac()) != macToString(b.mac()));
}

TEST(mac_conflict_resolution_changes_mac) {
    DeviceIdentity a;
    a.deviceId = "aaaa0000000000000000000000000000"; a.playerName = "Simone";
    std::string m0 = macToString(a.mac());
    a.nickSalt = 1;
    CHECK(macToString(a.mac()) != m0);
}

TEST(nick_is_ascii_and_bounded) {
    DeviceIdentity a;
    a.deviceId = "cafe0000000000000000000000000000";
    a.playerName = "Zoë 田中 \"quoted\" very long player name";
    std::string n = a.netplayNick();
    CHECK(n.size() <= 32);
    for (unsigned char c : n) CHECK(c >= 0x20 && c < 0x7f && c != '"' && c != ' ');
    // tag letters are distinct: required because repeated characters cancel out in the core's XOR hash
    std::set<char> seen(n.begin(), n.end());
    CHECK_EQ(seen.size(), n.size());
    CHECK(!sanitizeAscii("", 10).empty());
}

TEST(mac_parse_roundtrip) {
    MacAddress m{};
    CHECK(parseMac("00:08:BF:90:f9:18", m));
    CHECK_EQ(macToString(m), std::string("00:08:BF:90:F9:18"));
    CHECK(!parseMac("00:08:BF:90:F9", m));
    CHECK(!parseMac("00-08-BF-90-F9-18", m));
    CHECK(!parseMac("0G:08:BF:90:F9:18", m));
}
