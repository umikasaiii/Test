// DSLink - tiny, strict key=value text codec used for adverts, control payloads and identity files.
#pragma once
#include <map>
#include <string>

namespace dslink {

using KvMap = std::map<std::string, std::string>;

// Keys: [a-z0-9_]+ (max 32). Values: no '\n' or '\r' (max 256). Anything else is rejected.
bool kvValidKey(const std::string& k);
bool kvValidValue(const std::string& v);
// Serialises as "key=value\n" lines in key order. Invalid entries are skipped.
std::string kvEncode(const KvMap& m);
// Parses lines; returns false on any malformed line, oversized input (> 4096 bytes) or duplicate key.
bool kvDecode(const std::string& text, KvMap& out);

}  // namespace dslink
