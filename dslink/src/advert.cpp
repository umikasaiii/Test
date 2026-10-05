#include "dslink/advert.hpp"

#include "dslink/netaddr.hpp"

namespace dslink {

const char* sessionModeName(SessionMode m) { return m == SessionMode::DownloadPlay ? "download-play" : "multi-rom"; }

bool parseSessionMode(const std::string& s, SessionMode& out) {
    if (s == "download-play") { out = SessionMode::DownloadPlay; return true; }
    if (s == "multi-rom") { out = SessionMode::MultiRom; return true; }
    return false;
}

bool validIPv4(const std::string& s) {
    std::uint32_t ip;
    return parseIPv4(s, ip);
}
bool validPort(unsigned long p) { return p >= 1024 && p <= 65535; }

KvMap advertToKv(const RoomAdvert& a) {
    KvMap m;
    m["proto"] = std::to_string(a.protocolVersion);
    m["app"] = a.appVersion;
    m["core"] = a.coreVersion;
    m["room"] = a.roomName;
    m["ip"] = a.hostIp;
    m["port"] = std::to_string(a.port);
    m["game"] = a.gameTitle;
    m["session"] = a.sessionId;
    m["host"] = a.hostDeviceId;
    m["mode"] = sessionModeName(a.mode);
    m["console"] = a.console;
    if (!a.romSha256.empty()) m["rom_sha"] = a.romSha256;
    m["players"] = std::to_string(a.players);
    m["max"] = std::to_string(a.maxPlayers);
    return m;
}

namespace {
bool getU(const KvMap& kv, const char* k, unsigned long& out) {
    auto it = kv.find(k);
    if (it == kv.end() || it->second.empty() || it->second.size() > 9) return false;
    unsigned long v = 0;
    for (char c : it->second) {
        if (c < '0' || c > '9') return false;
        v = v * 10 + unsigned(c - '0');
    }
    out = v;
    return true;
}
bool getS(const KvMap& kv, const char* k, std::string& out, bool required, std::size_t maxLen) {
    auto it = kv.find(k);
    if (it == kv.end()) return !required;
    if (it->second.size() > maxLen || (required && it->second.empty())) return false;
    out = it->second;
    return true;
}
}  // namespace

bool advertFromKv(const KvMap& kv, RoomAdvert& out) {
    RoomAdvert a;
    unsigned long proto, port, players, maxp;
    std::string mode;
    if (!getU(kv, "proto", proto) || !getU(kv, "port", port) || !getU(kv, "players", players) ||
        !getU(kv, "max", maxp))
        return false;
    if (!validPort(port) || maxp < 1 || maxp > 16 || players > maxp) return false;
    if (!getS(kv, "app", a.appVersion, true, 32) || !getS(kv, "core", a.coreVersion, true, 64) ||
        !getS(kv, "room", a.roomName, true, 48) || !getS(kv, "ip", a.hostIp, true, 15) ||
        !getS(kv, "game", a.gameTitle, false, 64) || !getS(kv, "session", a.sessionId, true, 32) ||
        !getS(kv, "host", a.hostDeviceId, true, 32) || !getS(kv, "mode", mode, true, 16) ||
        !getS(kv, "console", a.console, true, 8) || !getS(kv, "rom_sha", a.romSha256, false, 64))
        return false;
    if (!validIPv4(a.hostIp) || !parseSessionMode(mode, a.mode)) return false;
    if (a.console != "nds" && a.console != "dsi") return false;
    if (!a.romSha256.empty() && a.romSha256.size() != 64) return false;
    a.protocolVersion = std::uint32_t(proto);
    a.port = std::uint16_t(port);
    a.players = unsigned(players);
    a.maxPlayers = unsigned(maxp);
    out = a;
    return true;
}

static const char kAdvertMagic[] = "DSLINK-ADVERT/1\n";

std::string encodeAdvert(const RoomAdvert& a) { return std::string(kAdvertMagic) + kvEncode(advertToKv(a)); }

bool decodeAdvert(const std::string& wire, RoomAdvert& out) {
    const std::string magic(kAdvertMagic);
    if (wire.compare(0, magic.size(), magic) != 0) return false;
    KvMap kv;
    return kvDecode(wire.substr(magic.size()), kv) && advertFromKv(kv, out);
}

bool advertFitsTxt(const RoomAdvert& a) {
    std::size_t total = 0;
    for (const auto& [k, v] : advertToKv(a)) {
        std::size_t e = k.size() + 1 + v.size();
        if (e > 255) return false;
        total += e + 1;
    }
    return total <= 1300;
}

const char* compatCode(Compat c) {
    switch (c) {
        case Compat::Ok: return "OK";
        case Compat::ProtocolMismatch: return "PROTO_MISMATCH";
        case Compat::CoreMismatch: return "CORE_MISMATCH";
        case Compat::ConsoleMismatch: return "CONSOLE_MISMATCH";
        case Compat::ModeMismatch: return "MODE_MISMATCH";
        case Compat::RomMismatch: return "ROM_MISMATCH";
        case Compat::RoomFull: return "ROOM_FULL";
        case Compat::MacConflict: return "MAC_CONFLICT";
        case Compat::SelfConnect: return "SELF_CONNECT";
    }
    return "UNKNOWN";
}

std::string compatMessage(Compat c) {
    switch (c) {
        case Compat::Ok: return "Compatibile.";
        case Compat::ProtocolMismatch:
            return "Le due versioni di DSLink sono diverse.\nAggiorna il secondo dispositivo.";
        case Compat::CoreMismatch:
            return "I due dispositivi usano versioni diverse dell'emulatore.\nInstalla la stessa versione di DSLink su entrambi.";
        case Compat::ConsoleMismatch:
            return "Un dispositivo emula Nintendo DS e l'altro Nintendo DSi.\nUsa la stessa modalità su entrambi.";
        case Compat::ModeMismatch:
            return "La modalità di gioco della stanza non coincide con quella di questo dispositivo.";
        case Compat::RomMismatch:
            return "I due dispositivi hanno ROM diverse.\nCarica la stessa ROM su entrambi.";
        case Compat::RoomFull: return "La stanza è piena.";
        case Compat::MacConflict:
            return "Due giocatori hanno la stessa identità DS.\nDSLink la rigenera automaticamente: riprova.";
        case Compat::SelfConnect: return "Stai provando a entrare nella tua stessa stanza.";
    }
    return "Errore sconosciuto.";
}

Compat checkCompatibility(const RoomAdvert& room, const ClientInfo& c, const std::string& macOfClient,
                          const std::string* takenMacs, std::size_t takenCount) {
    if (c.deviceId == room.hostDeviceId) return Compat::SelfConnect;
    if (c.protocolVersion != room.protocolVersion) return Compat::ProtocolMismatch;
    if (c.coreVersion != room.coreVersion) return Compat::CoreMismatch;
    if (c.console != room.console) return Compat::ConsoleMismatch;
    if (c.mode != room.mode) return Compat::ModeMismatch;
    if (room.mode == SessionMode::MultiRom && !room.romSha256.empty() && c.romSha256 != room.romSha256)
        return Compat::RomMismatch;
    if (room.players >= room.maxPlayers) return Compat::RoomFull;
    for (std::size_t i = 0; i < takenCount; ++i)
        if (takenMacs[i] == macOfClient) return Compat::MacConflict;
    return Compat::Ok;
}

}  // namespace dslink
