#include "dslink/diagnostics.hpp"

#include <chrono>
#include <cstdio>
#include <ctime>

namespace dslink {

static bool isPathChar(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '/' || c == '.' ||
           c == '_' || c == '-' || c == ' ' || c == '~' || c == '+' || c == '(' || c == ')';
}

std::string sanitizeLogLine(const std::string& line) {
    std::string out;
    std::size_t i = 0;
    while (i < line.size()) {
        // A path starts at '/' preceded by start, space, quote or '=' and contains another '/'.
        bool boundary = i == 0 || line[i - 1] == ' ' || line[i - 1] == '"' || line[i - 1] == '=' || line[i - 1] == '\'';
        if (line[i] == '/' && boundary && i + 1 < line.size() && line[i + 1] != ' ') {
            std::size_t j = i;
            std::size_t lastSlash = i;
            while (j < line.size() && isPathChar(line[j]) && !(line[j] == ' ' && (j + 1 >= line.size() || line[j + 1] == '-'))) {
                if (line[j] == '/') lastSlash = j;
                ++j;
            }
            // Only treat as a path when it has >= 2 components (e.g. /a/b); "1/2" or "/s" stay as they are.
            if (lastSlash > i) {
                out += "<path>/";
                out.append(line, lastSlash + 1, j - lastSlash - 1);
                i = j;
                continue;
            }
        }
        out += line[i++];
    }
    // Drop opaque 64+ char blobs that are not SHA-256 hashes (exactly 64 hex is a hash and allowed).
    std::string res;
    std::size_t k = 0;
    while (k < out.size()) {
        std::size_t e = k;
        while (e < out.size() && ((out[e] >= '0' && out[e] <= '9') || (out[e] >= 'a' && out[e] <= 'f') ||
                                  (out[e] >= 'A' && out[e] <= 'F') || out[e] == '+' || out[e] == '=' ||
                                  (out[e] >= 'g' && out[e] <= 'z') || (out[e] >= 'G' && out[e] <= 'Z')))
            ++e;
        std::size_t len = e - k;
        if (len > 64) res += "<redacted>";
        else res.append(out, k, len == 0 ? 1 : len);
        k += len == 0 ? 1 : len;
    }
    return res;
}

void LogBuffer::add(const std::string& line) {
    auto now = std::chrono::system_clock::now();
    std::time_t t = std::chrono::system_clock::to_time_t(now);
    std::tm tm{};
#if defined(_WIN32)
    localtime_s(&tm, &t);
#else
    localtime_r(&t, &tm);
#endif
    char ts[16];
    std::snprintf(ts, sizeof ts, "%02d:%02d:%02d ", tm.tm_hour, tm.tm_min, tm.tm_sec);
    std::lock_guard<std::mutex> l(mu_);
    lines_.push_back(ts + sanitizeLogLine(line));
    while (lines_.size() > cap_) lines_.pop_front();
}

std::string LogBuffer::dump() const {
    std::lock_guard<std::mutex> l(mu_);
    std::string s;
    for (auto& x : lines_) { s += x; s += '\n'; }
    return s;
}

std::size_t LogBuffer::size() const {
    std::lock_guard<std::mutex> l(mu_);
    return lines_.size();
}

std::string DiagnosticsReport::render() const {
    auto row = [](const char* k, const std::string& v) { return std::string(k) + ": " + (v.empty() ? "-" : v) + "\n"; };
    std::string s;
    s += row("Piattaforma", platform);
    s += row("Versione DSLink", dslinkVersion);
    s += row("Versione RetroArch", retroarchVersion);
    s += row("Core melonDS DS", coreVersion);
    s += row("Player ID", playerId);
    s += row("MAC DS", mac);
    s += row("IPv4", ipv4);
    s += row("Subnet", subnet);
    s += row("Tipo connessione", connectionType);
    s += row("Ruolo", role);
    s += row("IP remoto", remoteIp);
    s += row("Porta", port);
    s += row("Discovery", discoveryState);
    s += row("Netplay", netplayState);
    s += row("Ping", ping);
    s += row("Jitter", jitter);
    s += row("Ultimo errore", lastError);
    s += row("Firmware presente", firmwarePresent ? "sì" : "no");
    s += row("ROM caricata", romLoaded ? "sì" : "no");
    if (romLoaded) s += row("ROM SHA-256", romSha256);
    return s;
}

}  // namespace dslink
