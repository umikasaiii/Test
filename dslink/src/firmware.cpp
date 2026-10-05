#include "dslink/firmware.hpp"

#include <cstdio>
#include <vector>

#include "dslink/sha256.hpp"

namespace dslink {
namespace {
constexpr std::size_t kBios7Size = 0x4000;  // 16 KiB
constexpr std::size_t kBios9Size = 0x1000;  // 4 KiB
bool firmwareSizeOk(std::size_t n) { return n == 0x20000 || n == 0x40000 || n == 0x80000; }  // 128/256/512 KiB

bool uniform(const std::uint8_t* d, std::size_t n) {
    for (std::size_t i = 1; i < n; ++i)
        if (d[i] != d[0]) return false;
    return true;
}
}  // namespace

const char* sysFileName(SysFileKind k) {
    switch (k) {
        case SysFileKind::Bios7: return "bios7.bin";
        case SysFileKind::Bios9: return "bios9.bin";
        case SysFileKind::Firmware: return "firmware.bin";
    }
    return "?";
}

const char* sysFileStatusCode(SysFileStatus s) {
    switch (s) {
        case SysFileStatus::Missing: return "MISSING";
        case SysFileStatus::Unreadable: return "UNREADABLE";
        case SysFileStatus::WrongSize: return "WRONG_SIZE";
        case SysFileStatus::Blank: return "BLANK";
        case SysFileStatus::BadHeader: return "BAD_HEADER";
        case SysFileStatus::LooksLikeOtherFile: return "OTHER_FILE";
        case SysFileStatus::Ok: return "OK";
    }
    return "?";
}

std::string sysFileStatusMessage(SysFileKind k, SysFileStatus s) {
    std::string n = sysFileName(k);
    switch (s) {
        case SysFileStatus::Ok: return n + " valido.";
        case SysFileStatus::Missing: return n + " non trovato. Importalo da Impostazioni → File di sistema.";
        case SysFileStatus::Unreadable: return n + " non è leggibile.";
        case SysFileStatus::WrongSize: return n + " ha una dimensione errata: il file non proviene da un Nintendo DS.";
        case SysFileStatus::Blank: return n + " è vuoto o corrotto.";
        case SysFileStatus::BadHeader: return n + " non ha l'intestazione di un firmware DS.";
        case SysFileStatus::LooksLikeOtherFile: return n + " sembra un altro file di sistema: controlla di non averli scambiati.";
    }
    return n;
}

SysFileStatus checkSysFileContent(SysFileKind k, const std::uint8_t* d, std::size_t n) {
    switch (k) {
        case SysFileKind::Bios7:
            if (n == kBios9Size) return SysFileStatus::LooksLikeOtherFile;
            if (n != kBios7Size) return n > 0x10000 ? SysFileStatus::LooksLikeOtherFile : SysFileStatus::WrongSize;
            return uniform(d, n) ? SysFileStatus::Blank : SysFileStatus::Ok;
        case SysFileKind::Bios9:
            if (n == kBios7Size) return SysFileStatus::LooksLikeOtherFile;
            if (n != kBios9Size) return n > 0x10000 ? SysFileStatus::LooksLikeOtherFile : SysFileStatus::WrongSize;
            return uniform(d, n) ? SysFileStatus::Blank : SysFileStatus::Ok;
        case SysFileKind::Firmware:
            if (n == kBios7Size || n == kBios9Size) return SysFileStatus::LooksLikeOtherFile;
            if (!firmwareSizeOk(n)) return SysFileStatus::WrongSize;
            if (uniform(d, n)) return SysFileStatus::Blank;
            // DS firmware header: bytes 0x08..0x0A are the ASCII tag "MAC" (followed by a hardware letter).
            if (d[8] != 'M' || d[9] != 'A' || d[10] != 'C') return SysFileStatus::BadHeader;
            return SysFileStatus::Ok;
    }
    return SysFileStatus::Blank;
}

SysFileResult validateSysFile(SysFileKind k, const std::string& path) {
    SysFileResult r;
    r.kind = k;
    std::FILE* f = std::fopen(path.c_str(), "rb");
    if (!f) { r.status = SysFileStatus::Missing; return r; }
    std::vector<std::uint8_t> buf;
    std::uint8_t chunk[8192];
    std::size_t got;
    while ((got = std::fread(chunk, 1, sizeof chunk, f)) > 0) {
        buf.insert(buf.end(), chunk, chunk + got);
        if (buf.size() > (1u << 20)) break;  // nothing legit is this big
    }
    bool err = std::ferror(f);
    std::fclose(f);
    if (err) { r.status = SysFileStatus::Unreadable; return r; }
    r.size = buf.size();
    r.sha256 = toHex(sha256(buf.data(), buf.size()));
    r.status = checkSysFileContent(k, buf.data(), buf.size());
    return r;
}

SystemFiles validateSystemDir(const std::string& dir) {
    std::string d = dir.empty() || dir.back() == '/' ? dir : dir + "/";
    SystemFiles s;
    s.bios7 = validateSysFile(SysFileKind::Bios7, d + sysFileName(SysFileKind::Bios7));
    s.bios9 = validateSysFile(SysFileKind::Bios9, d + sysFileName(SysFileKind::Bios9));
    s.firmware = validateSysFile(SysFileKind::Firmware, d + sysFileName(SysFileKind::Firmware));
    return s;
}

}  // namespace dslink
