// Developer tool: prints the RetroArch config / core options / command line DSLink would use for a plan.
// Used by tests/integration/linux_netplay_smoke.sh so the real RetroArch + melonDS DS consume DSLink's output.
//   dslink_cfgtool <host|client> <workdir> <core.so> <content|-> <hostip|-> <port> <name> <deviceId> <what>
// what: cfg | opts | args | mac | nick
#include <iostream>

#include "dslink/launch.hpp"

using namespace dslink;

int main(int argc, char** argv) {
    if (argc < 10) { std::cerr << "usage: see source\n"; return 2; }
    LaunchPlan p;
    p.role = std::string(argv[1]) == "client" ? Role::Client : Role::Host;
    std::string wd = argv[2];
    p.corePath = argv[3];
    p.contentPath = std::string(argv[4]) == "-" ? "" : argv[4];
    p.hostIp = std::string(argv[5]) == "-" ? "" : argv[5];
    p.port = std::uint16_t(std::stoi(argv[6]));
    p.identity.playerName = argv[7];
    p.identity.deviceId = argv[8];
    p.systemDir = wd + "/system";
    p.saveDir = wd + "/saves";
    p.stateDir = wd + "/states";
    p.configDir = wd + "/config";
    std::string what = argv[9];
    if (what == "cfg") std::cout << buildRetroArchConfig(p);
    else if (what == "mac") std::cout << macToString(p.identity.mac()) << "\n";
    else if (what == "nick") std::cout << p.identity.netplayNick() << "\n";
    else if (what == "opts") std::cout << buildCoreOptions(p);
    else for (auto& a : buildCommandLine(p, wd + "/retroarch.cfg")) std::cout << a << "\n";
    return 0;
}
