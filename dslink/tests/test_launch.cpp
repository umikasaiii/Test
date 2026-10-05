#include <unistd.h>
#include "dslink/diagnostics.hpp"
#include "dslink/dslink_c.h"
#include "dslink/launch.hpp"
#include "dslink/netaddr.hpp"
#include <algorithm>
#include "testing.hpp"

using namespace dslink;

namespace {
LaunchPlan plan(Role r) {
    LaunchPlan p;
    p.role = r;
    p.contentPath = r == Role::Host ? "/data/roms/game.nds" : "";
    p.corePath = "/data/cores/melondsds_libretro_android.so";
    p.systemDir = "/data/system"; p.saveDir = "/data/saves"; p.stateDir = "/data/states"; p.configDir = "/data/config";
    p.identity.deviceId = "aaaa0000000000000000000000000000";
    p.identity.playerName = "Simone";
    p.hostIp = "192.168.1.20";
    p.port = 55435;
    return p;
}
}  // namespace

TEST(launch_config_is_lan_only_and_carries_identity) {
    std::string c = buildRetroArchConfig(plan(Role::Host));
    CHECK(c.find("netplay_use_mitm_server = \"false\"") != std::string::npos);
    CHECK(c.find("netplay_nat_traversal = \"false\"") != std::string::npos);
    CHECK(c.find("netplay_public_announce = \"false\"") != std::string::npos);
    CHECK(c.find("netplay_nickname = \"" + plan(Role::Host).identity.netplayNick() + "\"") != std::string::npos);
    CHECK(c.find("netplay_ip_port = \"55435\"") != std::string::npos);
    CHECK(c.find("netplay_ip_address") == std::string::npos);  // host only
    CHECK(c.find("pause_nonactive = \"false\"") != std::string::npos);
    std::string cl = buildRetroArchConfig(plan(Role::Client));
    CHECK(cl.find("netplay_ip_address = \"192.168.1.20\"") != std::string::npos);
}

TEST(launch_core_options_derive_mac_from_nick_and_boot_native_without_card) {
    CHECK(buildCoreOptions(plan(Role::Host)).find("melonds_mac_address_mode = \"from-username\"") != std::string::npos);
    CHECK(buildCoreOptions(plan(Role::Host)).find("melonds_boot_mode = \"direct\"") != std::string::npos);
    CHECK(buildCoreOptions(plan(Role::Client)).find("melonds_boot_mode = \"native\"") != std::string::npos);
    LaunchPlan d = plan(Role::Client); d.dsi = true;
    CHECK(buildCoreOptions(d).find("melonds_console_mode = \"dsi\"") != std::string::npos);
}

TEST(launch_values_cannot_inject_config_lines) {
    LaunchPlan p = plan(Role::Host);
    p.identity.playerName = "x\"\nnetplay_use_mitm_server = \"true";
    std::string c = buildRetroArchConfig(p);
    CHECK(c.find("netplay_use_mitm_server = \"true\"") == std::string::npos);
    CHECK_EQ(cfgQuote("a\"b\nc"), std::string("\"abc\""));
}

TEST(launch_command_line_and_android_extra) {
    auto h = buildCommandLine(plan(Role::Host), "/x/dslink.cfg");
    CHECK(std::find(h.begin(), h.end(), "-H") != h.end());
    CHECK_EQ(h.back(), std::string("/data/roms/game.nds"));
    auto c = buildCommandLine(plan(Role::Client), "");
    auto it = std::find(c.begin(), c.end(), "-C");
    CHECK(it != c.end() && *(it + 1) == "192.168.1.20");
    CHECK(std::find(c.begin(), c.end(), "/data/roms/game.nds") == c.end());  // no content: DS boots with no cartridge
    CHECK_EQ(buildNetplayExtra(plan(Role::Host)), std::string("host;55435;") + plan(Role::Host).identity.netplayNick());
    CHECK_EQ(buildNetplayExtra(plan(Role::Client)), std::string("client;192.168.1.20;55435;") + plan(Role::Client).identity.netplayNick());
}

TEST(log_sanitizer_strips_paths_and_blobs) {
    std::string s = sanitizeLogLine("loaded rom from /storage/emulated/0/Download/My Game.nds ok");
    CHECK(s.find("/storage") == std::string::npos);
    CHECK(s.find("My Game.nds") != std::string::npos);
    CHECK(sanitizeLogLine("path=/var/mobile/Containers/Data/x/firmware.bin").find("/var/mobile") == std::string::npos);
    CHECK(sanitizeLogLine(std::string(200, 'A')).find("<redacted>") != std::string::npos);
    std::string hash(64, 'a');
    CHECK(sanitizeLogLine("rom sha256 " + hash).find(hash) != std::string::npos);  // a SHA-256 is allowed
    CHECK_EQ(sanitizeLogLine("ping 12.5 ms 3/4"), std::string("ping 12.5 ms 3/4"));
}

TEST(log_buffer_caps_lines) {
    LogBuffer b(3);
    for (int i = 0; i < 10; ++i) b.add("line " + std::to_string(i));
    CHECK_EQ(b.size(), std::size_t(3));
    CHECK(b.dump().find("line 9") != std::string::npos);
    CHECK(b.dump().find("line 0") == std::string::npos);
}

TEST(diagnostics_report_lists_required_fields) {
    DiagnosticsReport r;
    r.platform = "Android 14"; r.dslinkVersion = "1.0.0"; r.mac = "00:08:BF:01:02:03"; r.romLoaded = true;
    r.romSha256 = std::string(64, 'b');
    std::string t = r.render();
    for (const char* k : {"Piattaforma", "Versione DSLink", "Versione RetroArch", "Core melonDS DS", "Player ID", "MAC DS",
                          "IPv4", "Subnet", "Tipo connessione", "IP remoto", "Porta", "Discovery", "Netplay", "Ping",
                          "Jitter", "Ultimo errore", "Firmware presente", "ROM caricata", "ROM SHA-256"})
        CHECK(t.find(k) != std::string::npos);
}

TEST(c_api_end_to_end_host_client_handshake) {
    char* best = dslink_best_ipv4();
    CHECK(best != nullptr);
    dslink_free(best);
    const char* advert =
        "proto=1\napp=1.0.0\ncore=c1\nroom=Stanza\nip=127.0.0.1\nport=55435\ngame=G\nsession=s1\n"
        "host=aaaa0000000000000000000000000000\nmode=download-play\nconsole=nds\nplayers=1\nmax=4\n";
    int port = dslink_pick_port(50000);
    CHECK(port > 0);
    void* host = dslink_host_start(advert, "HostNick", "00:08:BF:11:11:11", port, 0);
    CHECK(host != nullptr);
    char* r = dslink_hello("127.0.0.1", port,
                           "proto=1\napp=1.0.0\ncore=c1\nconsole=nds\nmode=download-play\n"
                           "device=bbbb0000000000000000000000000000\nnick=Nick-bbbb\n",
                           "00:08:BF:22:22:22");
    CHECK(r != nullptr);
    std::string res = r ? r : "";
    dslink_free(r);
    CHECK(res.find("ok=1") != std::string::npos);
    char* peers = dslink_host_peers(host);
    CHECK(peers && std::string(peers).find("count=1") != std::string::npos);
    dslink_free(peers);
    char* probe = dslink_probe("127.0.0.1", port, 5);
    CHECK(probe && std::string(probe).find("received=5") != std::string::npos);
    dslink_free(probe);
    dslink_host_stop(host);

    void* sm = dslink_sm_new();
    CHECK(dslink_sm_event(sm, "StartHost", "", -1) == 1);
    CHECK(dslink_sm_event(sm, "BootDS", "", -1) == 0);
    CHECK(dslink_sm_event(sm, "NoSuchEvent", "", -1) == 0);
    char* st = dslink_sm_state(sm);
    CHECK(st && std::string(st).find("state=Preparing") != std::string::npos);
    dslink_free(st);
    dslink_sm_free(sm);
    CHECK(dslink_advert_normalize("garbage") == nullptr);
}

TEST(launch_core_options_screen_layouts_follow_orientation) {
    LaunchPlan p = plan(Role::Host);
    std::string port = buildCoreOptions(p);
    CHECK(port.find("melonds_screen_layout1 = \"top-bottom\"") != std::string::npos);
    CHECK(port.find("melonds_screen_layout2 = \"left-right\"") != std::string::npos);
    p.landscape = true;
    std::string land = buildCoreOptions(p);
    CHECK(land.find("melonds_screen_layout1 = \"left-right\"") != std::string::npos);
    CHECK(land.find("melonds_number_of_screen_layouts = \"2\"") != std::string::npos);
    CHECK(land.find("melonds_show_cursor = \"disabled\"") != std::string::npos);
}

TEST(launch_config_points_retroarch_at_core_info_and_core_dir) {
    LaunchPlan p = plan(Role::Host);
    p.infoDir = "/data/info";
    std::string c = buildRetroArchConfig(p);
    CHECK(c.find("libretro_info_path = \"/data/info\"") != std::string::npos);
    CHECK(c.find("libretro_directory = \"/data/cores\"") != std::string::npos);
    CHECK(c.find("system_directory = \"/data/system\"") != std::string::npos);
    CHECK(c.find("autosave_interval = \"10\"") != std::string::npos);
    CHECK(c.find("global_core_options = \"true\"") != std::string::npos);
    CHECK(c.find("game_specific_options = \"false\"") != std::string::npos);
}

TEST(c_api_identity_rename_and_bump_salt_change_mac) {
    std::string path = "/tmp/dslink_capi_id_" + std::to_string(getpid());
    std::remove(path.c_str());
    char* a = dslink_identity_load_or_create(path.c_str());
    CHECK(a != nullptr);
    std::string first = a ? a : "";
    dslink_free(a);
    char* r = dslink_identity_rename(path.c_str(), "Simone");
    CHECK(r && std::string(r).find("player_name=Simone") != std::string::npos);
    dslink_free(r);
    CHECK(dslink_identity_rename(path.c_str(), "") == nullptr);                 // invalid name rejected
    CHECK(dslink_identity_rename(path.c_str(), std::string(40, 'x').c_str()) == nullptr);
    char* b = dslink_identity_bump_salt(path.c_str());
    CHECK(b && std::string(b).find("nick_salt=1") != std::string::npos);
    auto macOf = [](const std::string& s) { auto p = s.find("mac="); return s.substr(p, 21); };
    CHECK(macOf(first) != macOf(b ? b : ""));
    dslink_free(b);
    std::remove(path.c_str());
}

TEST(c_api_nds_info_rejects_non_roms) {
    char* r = dslink_nds_info("/nonexistent/file.nds");
    CHECK(r && std::string(r).find("status=UNREADABLE") != std::string::npos);
    dslink_free(r);
}
