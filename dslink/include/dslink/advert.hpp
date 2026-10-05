// DSLink - room advert (what the host publishes on the LAN) and session compatibility rules.
#pragma once
#include <cstdint>
#include <string>

#include "dslink/kv.hpp"

namespace dslink {

constexpr std::uint32_t kProtocolVersion = 1;
constexpr const char* kServiceType = "_dslink._tcp";  // mDNS / Bonjour service type
constexpr std::uint16_t kDefaultPort = 55435;           // RetroArch's default netplay port is 55435
constexpr std::uint16_t kBeaconPort = 55437;            // UDP broadcast fallback beacon (not used on iOS)

enum class SessionMode {
    DownloadPlay,  // host has the card; clients boot the DS menu with no cartridge (the real Mario Party DS flow)
    MultiRom,      // "Multi-ROM compatibility mode": every device loads the same ROM (debug fallback only)
};
const char* sessionModeName(SessionMode m);
bool parseSessionMode(const std::string& s, SessionMode& out);

struct RoomAdvert {
    std::uint32_t protocolVersion = kProtocolVersion;
    std::string appVersion;
    std::string coreVersion;  // melonDS DS version string; must be identical on both ends
    std::string roomName;
    std::string hostIp;       // dotted IPv4
    std::uint16_t port = 0;
    std::string gameTitle;
    std::string sessionId;
    std::string hostDeviceId;
    SessionMode mode = SessionMode::DownloadPlay;
    std::string console = "nds";  // "nds" | "dsi"
    std::string romSha256;        // only filled in MultiRom mode (the hash is public, the ROM never is)
    unsigned players = 1;
    unsigned maxPlayers = 4;
};

KvMap advertToKv(const RoomAdvert& a);
// Strict: required fields present and valid (IPv4, port 1024..65535, sane lengths); returns false otherwise.
bool advertFromKv(const KvMap& kv, RoomAdvert& out);
// Wire form for the UDP beacon: "DSLINK-ADVERT/1\n" + kv text.
std::string encodeAdvert(const RoomAdvert& a);
bool decodeAdvert(const std::string& wire, RoomAdvert& out);
// mDNS TXT records are <=255 bytes per entry and the whole record should stay small, so the TXT form drops
// nothing but is checked to fit.
bool advertFitsTxt(const RoomAdvert& a);

enum class Compat {
    Ok,
    ProtocolMismatch,
    CoreMismatch,
    ConsoleMismatch,
    ModeMismatch,
    RomMismatch,
    RoomFull,
    MacConflict,
    SelfConnect,
};

struct ClientInfo {
    std::uint32_t protocolVersion = kProtocolVersion;
    std::string appVersion;
    std::string coreVersion;
    std::string console = "nds";
    SessionMode mode = SessionMode::DownloadPlay;
    std::string romSha256;  // empty for download-play clients (they have no ROM)
    std::string deviceId;
    std::string nick;       // netplay nickname (MAC derives from it)
};

// Pure function: host-side validation of a joining client against the advert.
// 'takenMacs' are the MACs of players already in the room (including the host's).
Compat checkCompatibility(const RoomAdvert& room, const ClientInfo& client, const std::string& macOfClient,
                          const std::string* takenMacs, std::size_t takenCount);
// Short stable code for logs ("PROTO_MISMATCH"...), never shown to the user.
const char* compatCode(Compat c);
// Italian, user-facing explanation.
std::string compatMessage(Compat c);

bool validIPv4(const std::string& s);
bool validPort(unsigned long p);

}  // namespace dslink
