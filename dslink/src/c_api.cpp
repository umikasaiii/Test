#include <cstdlib>
#include <cstring>
#include <memory>

#include "dslink/advert.hpp"
#include "dslink/control.hpp"
#include "dslink/diagnostics.hpp"
#include "dslink/dslink_c.h"
#include "dslink/firmware.hpp"
#include "dslink/identity.hpp"
#include "dslink/kv.hpp"
#include "dslink/launch.hpp"
#include "dslink/netaddr.hpp"
#include "dslink/session_machine.hpp"
#include "dslink/sha256.hpp"

using namespace dslink;

namespace {
thread_local std::string g_err;
LogBuffer& logBuf() { static LogBuffer b; return b; }

char* dup(const std::string& s) {
    char* p = static_cast<char*>(std::malloc(s.size() + 1));
    if (!p) return nullptr;
    std::memcpy(p, s.c_str(), s.size() + 1);
    return p;
}
char* fail(const std::string& e) { g_err = e; return nullptr; }
KvMap parse(const char* s) {
    KvMap m;
    if (s) kvDecode(s, m);
    return m;
}
std::string get(const KvMap& m, const char* k, const std::string& d = {}) {
    auto it = m.find(k);
    return it == m.end() ? d : it->second;
}
std::string idKv(const DeviceIdentity& id, bool created) {
    return kvEncode({{"device_id", id.deviceId}, {"player_name", id.playerName}, {"nick", id.netplayNick()},
                     {"mac", macToString(id.mac())}, {"created", created ? "1" : "0"}});
}

LaunchPlan planFrom(const KvMap& m) {
    LaunchPlan p;
    p.role = get(m, "role") == "client" ? Role::Client : Role::Host;
    parseSessionMode(get(m, "mode", "download-play"), p.mode);
    p.contentPath = get(m, "content");
    p.corePath = get(m, "core_path");
    p.systemDir = get(m, "system_dir");
    p.saveDir = get(m, "save_dir");
    p.stateDir = get(m, "state_dir");
    p.configDir = get(m, "config_dir");
    p.overlayPath = get(m, "overlay");
    p.identity.deviceId = get(m, "device_id", "00000000000000000000000000000000");
    p.identity.playerName = get(m, "player_name", "player");
    try { p.identity.nickSalt = std::uint32_t(std::stoul(get(m, "nick_salt", "0"))); } catch (...) {}
    p.hostIp = get(m, "host_ip");
    std::uint16_t port;
    if (parsePort(get(m, "port"), port)) p.port = port;
    try { p.maxPlayers = unsigned(std::stoul(get(m, "max_players", "4"))); } catch (...) {}
    p.dsi = get(m, "console") == "dsi";
    return p;
}

struct Host {
    std::unique_ptr<ControlServer> server;
    BeaconAnnouncer beacon;
};
struct Sm { SessionMachine m{[](const std::string& l) { logBuf().add(l); }}; };
}  // namespace

extern "C" {

void dslink_free(char* p) { std::free(p); }
const char* dslink_last_error(void) { return g_err.c_str(); }

char* dslink_identity_load_or_create(const char* path) {
    if (!path) return fail("null path");
    bool created = false;
    DeviceIdentity id = loadOrCreateIdentity(path, systemRandom(), &created);
    return dup(idKv(id, created));
}

char* dslink_identity_rename(const char* path, const char* name) {
    if (!path || !name || !validPlayerName(name)) return fail("invalid player name");
    DeviceIdentity id = loadOrCreateIdentity(path, systemRandom());
    id.playerName = name;
    if (!saveIdentity(path, id)) return fail("cannot save identity");
    return dup(idKv(id, false));
}

char* dslink_best_ipv4(void) {
    IPv4Choice c = selectBestIPv4(enumerateInterfaces());
    if (!c.found) return dup(kvEncode({{"found", "0"}, {"vpn", c.vpnPresent ? "1" : "0"}}));
    return dup(kvEncode({{"found", "1"}, {"ip", formatIPv4(c.iface.ip)}, {"iface", c.iface.name},
                         {"kind", linkKindName(c.kind)}, {"prefix", std::to_string(prefixLength(c.iface.netmask))},
                         {"vpn", c.vpnPresent ? "1" : "0"}}));
}

int dslink_pick_port(int preferred) {
    if (preferred < 1024 || preferred > 65535) preferred = kDefaultPort;
    return pickPort(std::uint16_t(preferred));
}

char* dslink_sha256_file(const char* path) {
    std::string hex;
    if (!path || !sha256File(path, hex)) return fail("cannot read file");
    return dup(hex);
}

char* dslink_validate_system_dir(const char* dir) {
    SystemFiles s = validateSystemDir(dir ? dir : "");
    KvMap m;
    auto add = [&](const char* key, const SysFileResult& r) {
        m[key] = sysFileStatusCode(r.status);
        m[std::string(key) + "_msg"] = sysFileStatusMessage(r.kind, r.status);
    };
    add("bios7", s.bios7); add("bios9", s.bios9); add("firmware", s.firmware);
    m["ready"] = s.ready() ? "1" : "0";
    return dup(kvEncode(m));
}

char* dslink_advert_normalize(const char* kv) {
    RoomAdvert a;
    if (!advertFromKv(parse(kv), a)) return fail("invalid advert");
    return dup(encodeAdvert(a));
}
char* dslink_advert_decode(const char* wire) {
    RoomAdvert a;
    if (!wire || !decodeAdvert(wire, a)) return fail("invalid advert");
    return dup(kvEncode(advertToKv(a)));
}
char* dslink_compat_message(const char* code) {
    for (Compat c : {Compat::Ok, Compat::ProtocolMismatch, Compat::CoreMismatch, Compat::ConsoleMismatch,
                     Compat::ModeMismatch, Compat::RomMismatch, Compat::RoomFull, Compat::MacConflict,
                     Compat::SelfConnect})
        if (code && std::string(code) == compatCode(c)) return dup(compatMessage(c));
    return dup("Impossibile connettersi alla stanza.");
}

void* dslink_host_start(const char* advertKv, const char* nick, const char* mac, int port, int beacon) {
    RoomAdvert a;
    if (!advertFromKv(parse(advertKv), a)) { fail("invalid advert"); return nullptr; }
    auto h = std::make_unique<Host>();
    h->server = std::make_unique<ControlServer>(a, nick ? nick : "", mac ? mac : "");
    std::string err;
    h->server->setOnPeerJoined([](const PeerRecord& p) { logBuf().add("[host] peer joined " + p.nick + " " + p.ip); });
    h->server->setOnPeerLeft([](const PeerRecord& p) { logBuf().add("[host] peer left " + p.nick); });
    if (!h->server->start(std::uint16_t(port), err)) { fail(err); return nullptr; }
    logBuf().add("[host] control server listening on udp port " + std::to_string(h->server->port()));
    if (beacon) {
        Host* raw = h.get();
        std::vector<std::string> targets{"255.255.255.255"};
        IPv4Choice c = selectBestIPv4(enumerateInterfaces());
        if (c.found) targets.push_back(formatIPv4(c.iface.ip | ~c.iface.netmask));
        raw->beacon.start([raw] { return raw->server->room(); }, targets);
    }
    return h.release();
}

char* dslink_host_peers(void* hp) {
    auto* h = static_cast<Host*>(hp);
    if (!h) return fail("null host");
    auto peers = h->server->peers();
    KvMap m{{"count", std::to_string(peers.size())}};
    for (std::size_t i = 0; i < peers.size(); ++i) {
        std::string p = "peer" + std::to_string(i) + "_";
        m[p + "nick"] = peers[i].nick; m[p + "mac"] = peers[i].mac; m[p + "ip"] = peers[i].ip;
    }
    return dup(kvEncode(m));
}

void dslink_host_stop(void* hp) {
    auto* h = static_cast<Host*>(hp);
    if (!h) return;
    h->beacon.stop();
    h->server->stop();
    delete h;
}

char* dslink_hello(const char* ip, int port, const char* infoKv, const char* mac) {
    ClientInfo ci; std::string m2 = mac ? mac : "";
    KvMap kv = parse(infoKv);
    kv["mac"] = m2;
    if (!ip || port < 1024 || port > 65535 || !clientInfoFromKv(kv, ci, m2)) return fail("invalid client info");
    HelloResult r = sendHello(ip, std::uint16_t(port), ci, m2);
    logBuf().add(std::string("[client] hello -> ") + ip + ":" + std::to_string(port) + " ok=" + (r.ok ? "1" : "0") +
                 " code=" + r.error);
    return dup(kvEncode({{"ok", r.ok ? "1" : "0"}, {"reachable", r.reachable ? "1" : "0"}, {"code", r.error},
                         {"message", r.ok ? "" : (r.reachable ? compatMessage(r.compat)
                                                              : "Host non raggiungibile. Controlla di essere sulla stessa rete Wi-Fi.")},
                         {"host_nick", r.hostNick}, {"host_mac", r.hostMac}, {"session", r.sessionId}}));
}

void dslink_bye(const char* ip, int port, const char* deviceId) {
    if (ip && deviceId && port >= 1024 && port <= 65535) sendBye(ip, std::uint16_t(port), deviceId);
}

char* dslink_probe(const char* ip, int port, int count) {
    if (!ip || port < 1024 || port > 65535) return fail("bad target");
    LatencyStats s = probeLatency(ip, std::uint16_t(port), count > 0 ? count : 20);
    Quality q = classify(s);
    auto f = [](double v) { char b[32]; std::snprintf(b, sizeof b, "%.1f", v); return std::string(b); };
    return dup(kvEncode({{"sent", std::to_string(s.sent)}, {"received", std::to_string(s.received)},
                         {"avg_ms", f(s.avgMs)}, {"min_ms", f(s.minMs)}, {"max_ms", f(s.maxMs)},
                         {"jitter_ms", f(s.jitterMs)}, {"loss_pct", f(s.lossPercent)},
                         {"quality", qualityCode(q)}, {"quality_label", qualityLabel(q)}}));
}

void* dslink_beacon_listen(void) {
    auto* l = new BeaconListener();
    std::string err;
    if (!l->start(kBeaconPort, err)) { g_err = err; delete l; return nullptr; }
    return l;
}
char* dslink_beacon_rooms(void* h) {
    auto* l = static_cast<BeaconListener*>(h);
    if (!l) return fail("null listener");
    auto rooms = l->rooms();
    KvMap m{{"count", std::to_string(rooms.size())}};
    for (std::size_t i = 0; i < rooms.size(); ++i) {
        std::string p = "room" + std::to_string(i) + "_";
        for (auto& [k, v] : advertToKv(rooms[i].advert)) m[p + k] = v;
        m[p + "src"] = rooms[i].sourceIp;
    }
    return dup(kvEncode(m));
}
void dslink_beacon_stop(void* h) { delete static_cast<BeaconListener*>(h); }

void* dslink_sm_new(void) { return new Sm(); }
void dslink_sm_free(void* h) { delete static_cast<Sm*>(h); }

int dslink_sm_event(void* h, const char* name, const char* info, int remaining) {
    auto* s = static_cast<Sm*>(h);
    if (!s || !name) return 0;
    for (int i = 0; i <= int(Event::Reset); ++i)
        if (std::string(eventName(Event(i))) == name) return s->m.handle(Event(i), info ? info : "", remaining) ? 1 : 0;
    return 0;
}

char* dslink_sm_state(void* h) {
    auto* s = static_cast<Sm*>(h);
    if (!s) return fail("null machine");
    return dup(kvEncode({{"state", stateName(s->m.state())}, {"role", roleName(s->m.role())},
                         {"peers", std::to_string(s->m.peers())}, {"last_error", s->m.lastError()},
                         {"last_disconnect", s->m.lastDisconnectReason()}, {"can_retry", s->m.canRetry() ? "1" : "0"}}));
}

char* dslink_launch_config(const char* k) { return dup(buildRetroArchConfig(planFrom(parse(k)))); }
char* dslink_launch_core_options(const char* k) { return dup(buildCoreOptions(planFrom(parse(k)))); }
char* dslink_launch_netplay_extra(const char* k) { return dup(buildNetplayExtra(planFrom(parse(k)))); }

void dslink_log(const char* line) { if (line) logBuf().add(line); }
char* dslink_log_dump(void) { return dup(logBuf().dump()); }

char* dslink_diagnostics(const char* k) {
    KvMap m = parse(k);
    DiagnosticsReport r;
    r.platform = get(m, "platform"); r.dslinkVersion = get(m, "dslink_version");
    r.retroarchVersion = get(m, "retroarch_version"); r.coreVersion = get(m, "core_version");
    r.playerId = get(m, "player_id"); r.mac = get(m, "mac"); r.ipv4 = get(m, "ipv4"); r.subnet = get(m, "subnet");
    r.connectionType = get(m, "connection_type"); r.role = get(m, "role"); r.remoteIp = get(m, "remote_ip");
    r.port = get(m, "port"); r.discoveryState = get(m, "discovery"); r.netplayState = get(m, "netplay");
    r.ping = get(m, "ping"); r.jitter = get(m, "jitter"); r.lastError = get(m, "last_error");
    r.firmwarePresent = get(m, "firmware") == "1"; r.romLoaded = get(m, "rom_loaded") == "1";
    r.romSha256 = get(m, "rom_sha256");
    return dup(r.render() + "\n--- log ---\n" + logBuf().dump());
}

}  // extern "C"
