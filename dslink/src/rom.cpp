#include "dslink/rom.hpp"

#include <cstdio>
#include <vector>

#include "dslink/sha256.hpp"

namespace dslink {

std::uint16_t crc16Modbus(const std::uint8_t* d, std::size_t n) {
    std::uint16_t crc = 0xFFFF;
    for (std::size_t i = 0; i < n; ++i) {
        crc ^= d[i];
        for (int b = 0; b < 8; ++b) crc = (crc & 1) ? std::uint16_t((crc >> 1) ^ 0xA001) : std::uint16_t(crc >> 1);
    }
    return crc;
}

const char* romStatusCode(RomStatus s) {
    switch (s) {
        case RomStatus::Ok: return "OK";
        case RomStatus::Unreadable: return "UNREADABLE";
        case RomStatus::TooSmall: return "TOO_SMALL";
        case RomStatus::BadHeaderCrc: return "BAD_HEADER_CRC";
        case RomStatus::NotNds: return "DSI_ONLY";
    }
    return "?";
}

std::string romStatusMessage(RomStatus s) {
    switch (s) {
        case RomStatus::Ok: return "ROM valida.";
        case RomStatus::Unreadable: return "Impossibile leggere il file.";
        case RomStatus::TooSmall: return "Il file è troppo piccolo per essere una ROM Nintendo DS.";
        case RomStatus::BadHeaderCrc: return "Il file non sembra una ROM Nintendo DS valida (intestazione danneggiata).";
        case RomStatus::NotNds: return "Questo è un titolo DSiWare, non una ROM Nintendo DS.";
    }
    return "";
}

static std::string trimAscii(const std::uint8_t* p, std::size_t n) {
    std::string s;
    for (std::size_t i = 0; i < n && p[i]; ++i) s += (p[i] >= 0x20 && p[i] < 0x7f) ? char(p[i]) : '?';
    while (!s.empty() && s.back() == ' ') s.pop_back();
    return s;
}

RomInfo checkRomHeader(const std::uint8_t* d, std::size_t len, std::uint64_t fileSize) {
    RomInfo r;
    r.fileSize = fileSize;
    if (fileSize < 0x4000 || len < 0x200) { r.status = RomStatus::TooSmall; return r; }
    r.title = trimAscii(d, 12);
    r.gameCode = trimAscii(d + 0x0C, 4);
    r.unitCode = d[0x12];
    std::uint16_t stored = std::uint16_t(d[0x15E] | (d[0x15F] << 8));
    r.logoCrcOk = std::uint16_t(d[0x15C] | (d[0x15D] << 8)) == 0xCF56;
    if (crc16Modbus(d, 0x15E) != stored) { r.status = RomStatus::BadHeaderCrc; return r; }
    r.status = r.unitCode == 3 ? RomStatus::NotNds : RomStatus::Ok;
    return r;
}

RomInfo inspectRomFile(const std::string& path) {
    RomInfo r;
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) return r;
    std::vector<std::uint8_t> head(0x200);
    std::size_t got = std::fread(head.data(), 1, head.size(), f);
    Sha256 h;
    h.update(head.data(), got);
    std::uint64_t total = got;
    std::uint8_t buf[16384];
    std::size_t n;
    while ((n = std::fread(buf, 1, sizeof buf, f)) > 0) { h.update(buf, n); total += n; }
    bool err = std::ferror(f);
    std::fclose(f);
    if (err) return r;
    head.resize(got);
    if (total < 0x4000) { r.status = RomStatus::TooSmall; r.fileSize = total; return r; }
    r = checkRomHeader(head.data(), head.size(), total);
    r.sha256 = toHex(h.finish());
    return r;
}

}  // namespace dslink
