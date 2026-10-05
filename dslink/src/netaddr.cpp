#include "dslink/netaddr.hpp"

#include <arpa/inet.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cstring>

namespace dslink {

bool parseIPv4(const std::string& s, std::uint32_t& out) {
    std::uint32_t v = 0;
    int parts = 0;
    std::size_t i = 0;
    while (i <= s.size()) {
        std::size_t start = i;
        unsigned n = 0;
        while (i < s.size() && s[i] >= '0' && s[i] <= '9') { n = n * 10 + unsigned(s[i] - '0'); if (n > 255) return false; ++i; }
        std::size_t digits = i - start;
        if (digits == 0 || digits > 3 || (digits > 1 && s[start] == '0')) return false;
        v = (v << 8) | n;
        ++parts;
        if (i == s.size()) break;
        if (s[i] != '.') return false;
        ++i;
        if (i == s.size()) return false;  // trailing dot
    }
    if (parts != 4) return false;
    out = v;
    return true;
}

std::string formatIPv4(std::uint32_t ip) {
    return std::to_string(ip >> 24) + "." + std::to_string((ip >> 16) & 255) + "." + std::to_string((ip >> 8) & 255) +
           "." + std::to_string(ip & 255);
}

namespace {
bool startsWith(const std::string& s, const char* p) { return s.rfind(p, 0) == 0; }
}  // namespace

LinkKind classifyInterface(const std::string& n) {
    if (startsWith(n, "tun") || startsWith(n, "tap") || startsWith(n, "ppp") || startsWith(n, "wg") ||
        startsWith(n, "utun") || startsWith(n, "ipsec") || startsWith(n, "tailscale") || startsWith(n, "zt"))
        return LinkKind::Vpn;
    if (startsWith(n, "rmnet") || startsWith(n, "ccmni") || startsWith(n, "pdp") || startsWith(n, "pdp_ip"))
        return LinkKind::Cellular;
    // Android hotspot: ap0 / swlan0 / wlan1 ; iOS Personal Hotspot host side: bridge100
    if (startsWith(n, "ap") || startsWith(n, "swlan") || startsWith(n, "softap") || startsWith(n, "bridge"))
        return LinkKind::Hotspot;
    if (startsWith(n, "wlan") || startsWith(n, "en0") || startsWith(n, "wifi")) return LinkKind::Wifi;
    if (startsWith(n, "eth") || startsWith(n, "en") || startsWith(n, "usb")) return LinkKind::Ethernet;
    return LinkKind::Other;
}

const char* linkKindName(LinkKind k) {
    switch (k) {
        case LinkKind::Wifi: return "wifi";
        case LinkKind::Hotspot: return "hotspot";
        case LinkKind::Ethernet: return "ethernet";
        case LinkKind::Cellular: return "cellular";
        case LinkKind::Vpn: return "vpn";
        case LinkKind::Other: return "other";
    }
    return "other";
}

bool isLinkLocal(std::uint32_t ip) { return (ip >> 16) == 0xA9FE; }
bool isPrivate(std::uint32_t ip) {
    return (ip >> 24) == 10 || (ip >> 20) == 0xAC1 || (ip >> 16) == 0xC0A8;
}
bool sameSubnet(std::uint32_t a, std::uint32_t b, std::uint32_t m) { return (a & m) == (b & m); }
unsigned prefixLength(std::uint32_t m) {
    unsigned n = 0;
    while (n < 32 && (m & (0x80000000u >> n))) ++n;
    return (n == 32 ? m == 0xFFFFFFFFu : (m << n) == 0) ? n : 0;
}

IPv4Choice selectBestIPv4(const std::vector<NetInterface>& ifaces) {
    IPv4Choice best;
    int bestScore = -1;
    for (const auto& i : ifaces) {
        LinkKind k = classifyInterface(i.name);
        if (i.up && !i.isLoopback && k == LinkKind::Vpn) best.vpnPresent = true;
        if (!i.up || i.isLoopback || i.ip == 0 || isLinkLocal(i.ip) || (i.ip >> 24) == 127) continue;
        if (k == LinkKind::Vpn || k == LinkKind::Cellular) continue;
        int score = 0;
        switch (k) {
            case LinkKind::Wifi: score = 40; break;
            case LinkKind::Hotspot: score = 35; break;
            case LinkKind::Ethernet: score = 30; break;
            default: score = 10; break;
        }
        if (isPrivate(i.ip)) score += 20;
        if (score > bestScore) { bestScore = score; best.found = true; best.iface = i; best.kind = k; }
    }
    return best;
}

std::vector<NetInterface> enumerateInterfaces() {
    std::vector<NetInterface> out;
    ifaddrs* list = nullptr;
    if (getifaddrs(&list) != 0) return out;
    for (ifaddrs* p = list; p; p = p->ifa_next) {
        if (!p->ifa_addr || p->ifa_addr->sa_family != AF_INET || !p->ifa_netmask) continue;
        NetInterface n;
        n.name = p->ifa_name;
        n.ip = ntohl(reinterpret_cast<sockaddr_in*>(p->ifa_addr)->sin_addr.s_addr);
        n.netmask = ntohl(reinterpret_cast<sockaddr_in*>(p->ifa_netmask)->sin_addr.s_addr);
        n.up = (p->ifa_flags & IFF_UP) && (p->ifa_flags & IFF_RUNNING);
        n.isLoopback = (p->ifa_flags & IFF_LOOPBACK) != 0;
        out.push_back(n);
    }
    freeifaddrs(list);
    return out;
}

bool parsePort(const std::string& s, std::uint16_t& out) {
    if (s.empty() || s.size() > 5) return false;
    unsigned long v = 0;
    for (char c : s) {
        if (c < '0' || c > '9') return false;
        v = v * 10 + unsigned(c - '0');
    }
    if (v < 1024 || v > 65535) return false;
    out = std::uint16_t(v);
    return true;
}

bool portIsFree(std::uint16_t port) {
    for (int type : {SOCK_STREAM, SOCK_DGRAM}) {
        int fd = ::socket(AF_INET, type, 0);
        if (fd < 0) return false;
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_ANY);
        a.sin_port = htons(port);
        bool ok = ::bind(fd, reinterpret_cast<sockaddr*>(&a), sizeof a) == 0;
        ::close(fd);
        if (!ok) return false;
    }
    return true;
}

std::uint16_t pickPort(std::uint16_t preferred, unsigned span) {
    for (unsigned i = 0; i < span; ++i) {
        unsigned p = unsigned(preferred) + i;
        if (p > 65535) break;
        if (portIsFree(std::uint16_t(p))) return std::uint16_t(p);
    }
    return 0;
}

}  // namespace dslink
