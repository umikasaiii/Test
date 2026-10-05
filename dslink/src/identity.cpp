#include "dslink/identity.hpp"

#include <chrono>
#include <cstdio>
#include <fstream>
#include <random>
#include <sstream>

#include "dslink/kv.hpp"
#include "dslink/sha256.hpp"

namespace dslink {
namespace {
class SystemRandom : public RandomSource {
public:
    void fill(std::uint8_t* out, std::size_t len) override {
        std::random_device rd;
        std::uint64_t t = std::chrono::high_resolution_clock::now().time_since_epoch().count();
        std::mt19937_64 mix((std::uint64_t(rd()) << 32) ^ rd() ^ t);
        for (std::size_t i = 0; i < len; ++i) out[i] = std::uint8_t(rd() ^ (mix() >> 24));
    }
};
}  // namespace

RandomSource& systemRandom() {
    static SystemRandom r;
    return r;
}

std::string sanitizeAscii(const std::string& s, std::size_t maxLen) {
    std::string out;
    for (unsigned char c : s) {
        if (out.size() >= maxLen) break;
        bool ok = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_';
        // Non-ASCII bytes (UTF-8 continuation) collapse into a single '_'.
        if (ok) out += char(c);
        else if (out.empty() || out.back() != '_') out += '_';
    }
    return out.empty() ? std::string("player") : out;
}

bool validPlayerName(const std::string& name) {
    if (name.empty() || name.size() > 24) return false;
    for (unsigned char c : name)
        if (c < 0x20 || c == 0x7f) return false;
    return true;
}

std::string defaultPlayerName(const std::string& deviceId) {
    std::string tail = deviceId.size() >= 4 ? deviceId.substr(0, 4) : std::string("0000");
    for (auto& c : tail) c = char(std::toupper(static_cast<unsigned char>(c)));
    return "Player-" + tail;
}

std::string DeviceIdentity::netplayNick() const {
    // The melonDS DS hash is an XOR of per-character terms: order-independent, and a character that appears twice
    // cancels itself ("aaaa" == "bbbb" == ""). A hex deviceId suffix would therefore collapse to ~nothing. So the
    // nickname is a *set* of distinct letters (each used at most once): letter i is present iff bit i of
    // SHA-256(deviceId + salt) is set. 31 symbols span >= 24 bits of seed entropy (checked offline: GF(2) rank 25),
    // which is all the 24-bit MAC suffix can carry. At most 31 chars (RetroArch's nick buffer is 32 incl. NUL).
    // The player's display name is deliberately NOT part of it; it is only shown in DSLink's own UI.
    Sha256 h;
    h.update(deviceId.data(), deviceId.size());
    std::string saltText = std::to_string(nickSalt);
    h.update(saltText.data(), saltText.size());
    Sha256Digest d = h.finish();
    std::uint32_t bits = ((std::uint32_t(d[0]) << 24) | (std::uint32_t(d[1]) << 16) | (std::uint32_t(d[2]) << 8) | d[3]) &
                         0x7FFFFFFFu;
    static const char kAlphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcde";  // 31 distinct symbols
    std::string tag;
    for (int i = 0; i < 31; ++i)
        if (bits & (1u << i)) tag += kAlphabet[i];
    return tag.empty() ? std::string("A") : tag;
}

MacAddress DeviceIdentity::mac() const { return macFromNickname(netplayNick()); }

MacAddress macFromNickname(const std::string& nick) {
    MacAddress addr{0x00, 0x08, 0xBF, 0, 0, 0};
    std::uint32_t seed = 0;
    for (char c : nick) {
        if (c < 0) c = char(-c);
        std::uint32_t s = std::uint32_t(c);
        s *= 1419857;
        seed ^= s;
    }
    std::mersenne_twister_engine<std::uint32_t, 32, 624, 397, 31, 0x9908b0df, 11, 0xffffffff, 7, 0x9d2c5680, 15,
                                 0xefc60000, 18, 1812433253>
        rng{seed};
    for (int i = 3; i <= 5; ++i) addr[i] = std::uint8_t(rng() % 256);
    return addr;
}

std::string macToString(const MacAddress& m) {
    char b[18];
    std::snprintf(b, sizeof b, "%02X:%02X:%02X:%02X:%02X:%02X", m[0], m[1], m[2], m[3], m[4], m[5]);
    return b;
}

bool parseMac(const std::string& s, MacAddress& out) {
    if (s.size() != 17) return false;
    MacAddress m{};
    for (int i = 0; i < 6; ++i) {
        std::size_t o = std::size_t(i) * 3;
        if (i < 5 && s[o + 2] != ':') return false;
        unsigned v = 0;
        for (int j = 0; j < 2; ++j) {
            char c = s[o + std::size_t(j)];
            unsigned d;
            if (c >= '0' && c <= '9') d = unsigned(c - '0');
            else if (c >= 'a' && c <= 'f') d = unsigned(c - 'a' + 10);
            else if (c >= 'A' && c <= 'F') d = unsigned(c - 'A' + 10);
            else return false;
            v = v * 16 + d;
        }
        m[std::size_t(i)] = std::uint8_t(v);
    }
    out = m;
    return true;
}

DeviceIdentity createIdentity(RandomSource& rng) {
    std::uint8_t raw[16];
    rng.fill(raw, sizeof raw);
    DeviceIdentity id;
    id.deviceId = toHex(raw, sizeof raw);
    id.playerName = defaultPlayerName(id.deviceId);
    return id;
}

bool saveIdentity(const std::string& path, const DeviceIdentity& id) {
    KvMap m{{"device_id", id.deviceId}, {"player_name", id.playerName}, {"nick_salt", std::to_string(id.nickSalt)}};
    std::string tmp = path + ".tmp";
    {
        std::ofstream f(tmp, std::ios::binary | std::ios::trunc);
        if (!f) return false;
        f << kvEncode(m);
        if (!f.good()) return false;
    }
    return std::rename(tmp.c_str(), path.c_str()) == 0;  // atomic replace: never leaves a half-written identity
}

bool loadIdentity(const std::string& path, DeviceIdentity& out) {
    std::ifstream f(path, std::ios::binary);
    if (!f) return false;
    std::stringstream ss;
    ss << f.rdbuf();
    KvMap m;
    if (!kvDecode(ss.str(), m)) return false;
    auto id = m.find("device_id"), nm = m.find("player_name");
    if (id == m.end() || nm == m.end() || id->second.size() != 32) return false;
    for (char c : id->second)
        if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
    if (!validPlayerName(nm->second)) return false;
    DeviceIdentity d;
    d.deviceId = id->second;
    d.playerName = nm->second;
    if (auto s = m.find("nick_salt"); s != m.end()) {
        try { d.nickSalt = std::uint32_t(std::stoul(s->second)); } catch (...) { return false; }
    }
    out = d;
    return true;
}

DeviceIdentity loadOrCreateIdentity(const std::string& path, RandomSource& rng, bool* created) {
    DeviceIdentity id;
    if (loadIdentity(path, id)) {
        if (created) *created = false;
        return id;
    }
    id = createIdentity(rng);
    saveIdentity(path, id);
    if (created) *created = true;
    return id;
}

}  // namespace dslink
