// DSLink - IPv4 helpers: parsing, subnet maths and picking the address that other phones can reach.
#pragma once
#include <cstdint>
#include <string>
#include <vector>

namespace dslink {

bool parseIPv4(const std::string& s, std::uint32_t& hostOrder);  // strict dotted quad, no leading zeros
std::string formatIPv4(std::uint32_t hostOrder);

struct NetInterface {
    std::string name;  // "wlan0", "en0", "ap0", "rmnet_data0", "tun0"...
    std::uint32_t ip = 0;       // host byte order
    std::uint32_t netmask = 0;  // host byte order
    bool up = true;
    bool isLoopback = false;
};

enum class LinkKind { Wifi, Hotspot, Ethernet, Cellular, Vpn, Other };
LinkKind classifyInterface(const std::string& name);
const char* linkKindName(LinkKind k);

bool isLinkLocal(std::uint32_t ip);  // 169.254/16
bool isPrivate(std::uint32_t ip);    // 10/8, 172.16/12, 192.168/16
bool sameSubnet(std::uint32_t a, std::uint32_t b, std::uint32_t mask);
unsigned prefixLength(std::uint32_t mask);  // 0 for a non-contiguous mask

struct IPv4Choice {
    bool found = false;
    NetInterface iface;
    LinkKind kind = LinkKind::Other;
    bool vpnPresent = false;  // a VPN-looking interface is up (we warn, DS wireless needs a real LAN)
};
// Prefers Wi-Fi / hotspot / ethernet private addresses; never loopback, link-local, cellular or VPN.
IPv4Choice selectBestIPv4(const std::vector<NetInterface>& ifaces);
// Enumerates the machine's interfaces with getifaddrs() (POSIX).
std::vector<NetInterface> enumerateInterfaces();

// Port handling. 'ok' means both TCP (RetroArch netplay) and UDP (DSLink control channel) were free.
bool parsePort(const std::string& s, std::uint16_t& out);
bool portIsFree(std::uint16_t port);  // tries to bind TCP+UDP on 0.0.0.0
// Returns 'preferred' if free, otherwise the first free port in the next 'span' ports, or 0.
std::uint16_t pickPort(std::uint16_t preferred, unsigned span = 32);

}  // namespace dslink
