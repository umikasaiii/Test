#include "dslink/kv.hpp"

namespace dslink {

bool kvValidKey(const std::string& k) {
    if (k.empty() || k.size() > 32) return false;
    for (char c : k)
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) return false;
    return true;
}

bool kvValidValue(const std::string& v) {
    if (v.size() > 256) return false;
    for (char c : v)
        if (c == '\n' || c == '\r' || c == '\0') return false;
    return true;
}

std::string kvEncode(const KvMap& m) {
    std::string out;
    for (const auto& [k, v] : m) {
        if (!kvValidKey(k) || !kvValidValue(v)) continue;
        out += k; out += '='; out += v; out += '\n';
    }
    return out;
}

bool kvDecode(const std::string& text, KvMap& out) {
    out.clear();
    if (text.size() > 4096) return false;
    std::size_t pos = 0;
    while (pos < text.size()) {
        std::size_t end = text.find('\n', pos);
        if (end == std::string::npos) return false;  // every line must be terminated
        std::string line = text.substr(pos, end - pos);
        pos = end + 1;
        if (line.empty()) continue;
        std::size_t eq = line.find('=');
        if (eq == std::string::npos) return false;
        std::string k = line.substr(0, eq), v = line.substr(eq + 1);
        if (!kvValidKey(k) || !kvValidValue(v)) return false;
        if (!out.emplace(k, v).second) return false;
    }
    return true;
}

}  // namespace dslink
