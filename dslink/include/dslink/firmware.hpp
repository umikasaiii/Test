// DSLink - validation of the user's own Nintendo DS system files (bios7.bin, bios9.bin, firmware.bin).
// DSLink never ships these files; they stay on the device. Validation = size + structure + "not blank".
// The melonDS DS core does the final bootability check itself (nds_firmware_not_bootable_exception).
#pragma once
#include <cstdint>
#include <string>

namespace dslink {

enum class SysFileKind { Bios7, Bios9, Firmware };
enum class SysFileStatus { Missing, Unreadable, WrongSize, Blank, BadHeader, LooksLikeOtherFile, Ok };

struct SysFileResult {
    SysFileKind kind;
    SysFileStatus status = SysFileStatus::Missing;
    std::uint64_t size = 0;
    std::string sha256;  // filled when readable
};

const char* sysFileName(SysFileKind k);  // "bios7.bin" ...
const char* sysFileStatusCode(SysFileStatus s);
std::string sysFileStatusMessage(SysFileKind k, SysFileStatus s);  // Italian

// Pure content check (used by tests and by validateSysFile).
SysFileStatus checkSysFileContent(SysFileKind k, const std::uint8_t* data, std::size_t len);
SysFileResult validateSysFile(SysFileKind k, const std::string& path);

struct SystemFiles {
    SysFileResult bios7, bios9, firmware;
    bool ready() const {
        return bios7.status == SysFileStatus::Ok && bios9.status == SysFileStatus::Ok &&
               firmware.status == SysFileStatus::Ok;
    }
};
// Looks for the three files in 'dir' (the core's "system/melonDS DS" folder).
SystemFiles validateSystemDir(const std::string& dir);

}  // namespace dslink
