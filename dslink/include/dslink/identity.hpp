// DSLink - per-installation identity: deviceId, player name and the emulated DS MAC address.
#pragma once
#include <array>
#include <cstdint>
#include <string>

namespace dslink {

using MacAddress = std::array<std::uint8_t, 6>;

class RandomSource {
public:
    virtual ~RandomSource() = default;
    virtual void fill(std::uint8_t* out, std::size_t len) = 0;
};
// std::random_device based (mixed with a clock); used in production.
RandomSource& systemRandom();

struct DeviceIdentity {
    std::string deviceId;    // 32 lowercase hex chars (128 random bits)
    std::string playerName;  // user-visible, UTF-8, 1..24 bytes
    std::uint32_t nickSalt = 0;  // bumped to resolve an (unlikely) MAC conflict

    // ASCII-only nickname (<= 31 chars) handed to RetroArch ("netplay_nickname"); the melonDS DS core derives
    // the DS MAC from it. Always ASCII so that every platform derives the same MAC (see macFromNickname()).
    std::string netplayNick() const;
    MacAddress mac() const;
};

// "Player-XXXX" where XXXX comes from the first bytes of the deviceId.
std::string defaultPlayerName(const std::string& deviceId);
// Keeps [A-Za-z0-9_-], maps everything else to '_' and trims to maxLen. Never returns an empty string.
std::string sanitizeAscii(const std::string& s, std::size_t maxLen);
bool validPlayerName(const std::string& name);

// Exact re-implementation of melonDS DS 1.4.0 "melonds_mac_address_mode = from-username"
// (src/libretro/config/config.cpp): OUI 00:08:BF + 3 bytes from a std::mt19937 seeded with a char hash.
// Only ASCII input is guaranteed to match across platforms (char signedness differs between ARM ABIs).
MacAddress macFromNickname(const std::string& nick);
std::string macToString(const MacAddress& m);
bool parseMac(const std::string& s, MacAddress& out);

DeviceIdentity createIdentity(RandomSource& rng);

// Persistence (key=value file). loadOrCreate writes the file on first run and rewrites it if it is corrupt.
// 'created' (optional) reports whether a new identity was generated.
bool saveIdentity(const std::string& path, const DeviceIdentity& id);
bool loadIdentity(const std::string& path, DeviceIdentity& out);
DeviceIdentity loadOrCreateIdentity(const std::string& path, RandomSource& rng, bool* created = nullptr);

}  // namespace dslink
