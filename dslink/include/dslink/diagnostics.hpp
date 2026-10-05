// DSLink - diagnostics report and privacy-preserving log buffer.
#pragma once
#include <deque>
#include <mutex>
#include <string>

namespace dslink {

// Collapses file-system paths to their last component and drops anything that could carry system-file or ROM
// content (long hex/base64-looking blobs). Logs never contain ROM, BIOS or firmware data.
std::string sanitizeLogLine(const std::string& line);

class LogBuffer {
public:
    explicit LogBuffer(std::size_t cap = 500) : cap_(cap) {}
    void add(const std::string& line);  // timestamps + sanitises
    std::string dump() const;
    std::size_t size() const;

private:
    std::size_t cap_;
    mutable std::mutex mu_;
    std::deque<std::string> lines_;
};

struct DiagnosticsReport {
    std::string platform, dslinkVersion, retroarchVersion, coreVersion;
    std::string playerId, mac;
    std::string ipv4, subnet, connectionType;
    std::string role, remoteIp, port;
    std::string discoveryState, netplayState;
    std::string ping, jitter;
    std::string lastError;
    bool firmwarePresent = false, romLoaded = false;
    std::string romSha256;
    std::string render() const;  // "Label: value" lines, ready for "Copia log"
};

}  // namespace dslink
