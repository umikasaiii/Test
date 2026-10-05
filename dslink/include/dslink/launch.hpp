// DSLink - turns a session description into the RetroArch / melonDS DS configuration that implements it.
// Users never see any of this; it lives behind Settings -> Advanced / Diagnostics.
#pragma once
#include <string>
#include <vector>

#include "dslink/advert.hpp"
#include "dslink/identity.hpp"
#include "dslink/session_machine.hpp"

namespace dslink {

struct LaunchPlan {
    Role role = Role::Host;
    SessionMode mode = SessionMode::DownloadPlay;
    std::string contentPath;       // host: the .nds. client in DownloadPlay mode: empty (DS boots with no cartridge)
    std::string corePath;          // melondsds_libretro (.so / static on iOS)
    std::string systemDir;         // contains "melonDS DS/bios7.bin" ...
    std::string saveDir, stateDir, configDir;
    std::string overlayPath;       // touch overlay .cfg (empty = none)
    DeviceIdentity identity;
    std::string hostIp;            // client only
    std::uint16_t port = kDefaultPort;
    unsigned maxPlayers = 4;
    bool dsi = false;
};

// Text of an extra retroarch.cfg ("--appendconfig" / CONFIGFILE). Values are sanitised (no quotes/newlines).
std::string buildRetroArchConfig(const LaunchPlan& p);
// Text of the core-options file ("core_options_path").
std::string buildCoreOptions(const LaunchPlan& p);
// Desktop/CLI form: [-L core] [-H | -C ip] --port N --nick NAME [--appendconfig f] [content]. Netplay is in the
// config so iOS / Android can reuse it; this is used by tests and by the Linux smoke runner.
std::vector<std::string> buildCommandLine(const LaunchPlan& p, const std::string& appendConfigPath);
// Value of the "DSLINK_NETPLAY" intent extra read by the patched RetroArch Android frontend
// (patches/0001-android-netplay-extra.patch): "host;PORT;NICK" or "client;IP;PORT;NICK".
std::string buildNetplayExtra(const LaunchPlan& p);

std::string cfgQuote(const std::string& v);  // strips '"', '\n', '\r'

}  // namespace dslink
