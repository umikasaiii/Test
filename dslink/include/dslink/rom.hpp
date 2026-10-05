// DSLink - sanity check of a user-supplied .nds file (header only; the ROM is never uploaded or shipped).
#pragma once
#include <cstdint>
#include <string>

namespace dslink {

std::uint16_t crc16Modbus(const std::uint8_t* data, std::size_t len);  // init 0xFFFF, poly 0xA001 (NDS header CRC)

enum class RomStatus { Ok, Unreadable, TooSmall, BadHeaderCrc, NotNds /* DSi-only title */ };

struct RomInfo {
    RomStatus status = RomStatus::Unreadable;
    std::string title;     // header bytes 0x00..0x0B (trimmed)
    std::string gameCode;  // 4 chars at 0x0C
    std::uint8_t unitCode = 0;  // 0 = NDS, 2 = NDS+DSi enhanced, 3 = DSi exclusive
    bool logoCrcOk = false;     // retail carts have 0xCF56 at 0x15C; homebrew may not
    std::uint64_t fileSize = 0;
    std::string sha256;
};

const char* romStatusCode(RomStatus s);
std::string romStatusMessage(RomStatus s);  // Italian
// Header check on an in-memory buffer holding at least the first 0x200 bytes of a file of 'fileSize' bytes.
RomInfo checkRomHeader(const std::uint8_t* data, std::size_t len, std::uint64_t fileSize);
inline RomInfo checkRomHeader(const std::uint8_t* data, std::size_t len) { return checkRomHeader(data, len, len); }
// Reads the file, validates the header and fills the SHA-256 (streamed).
RomInfo inspectRomFile(const std::string& path);

}  // namespace dslink
