#include <cstdio>
#include <unistd.h>
#include <vector>

#include "dslink/firmware.hpp"
#include "testing.hpp"

using namespace dslink;

namespace {
std::vector<std::uint8_t> noise(std::size_t n, std::uint8_t seed = 7) {
    std::vector<std::uint8_t> v(n);
    for (std::size_t i = 0; i < n; ++i) v[i] = std::uint8_t((i * 31 + seed) ^ (i >> 3));
    return v;
}
std::vector<std::uint8_t> fw(std::size_t n) {
    auto v = noise(n);
    v[8] = 'M'; v[9] = 'A'; v[10] = 'C'; v[11] = 'h';
    return v;
}
void write(const std::string& p, const std::vector<std::uint8_t>& d) {
    std::FILE* f = std::fopen(p.c_str(), "wb");
    std::fwrite(d.data(), 1, d.size(), f);
    std::fclose(f);
}
}  // namespace

TEST(firmware_content_checks) {
    auto b7 = noise(0x4000), b9 = noise(0x1000);
    CHECK(checkSysFileContent(SysFileKind::Bios7, b7.data(), b7.size()) == SysFileStatus::Ok);
    CHECK(checkSysFileContent(SysFileKind::Bios9, b9.data(), b9.size()) == SysFileStatus::Ok);
    // swapped files are detected with a specific message
    CHECK(checkSysFileContent(SysFileKind::Bios7, b9.data(), b9.size()) == SysFileStatus::LooksLikeOtherFile);
    CHECK(checkSysFileContent(SysFileKind::Bios9, b7.data(), b7.size()) == SysFileStatus::LooksLikeOtherFile);
    auto odd = noise(1234);
    CHECK(checkSysFileContent(SysFileKind::Bios7, odd.data(), odd.size()) == SysFileStatus::WrongSize);
    std::vector<std::uint8_t> blank(0x4000, 0xFF);
    CHECK(checkSysFileContent(SysFileKind::Bios7, blank.data(), blank.size()) == SysFileStatus::Blank);
    for (std::size_t sz : {0x20000u, 0x40000u, 0x80000u}) {
        auto f = fw(sz);
        CHECK(checkSysFileContent(SysFileKind::Firmware, f.data(), f.size()) == SysFileStatus::Ok);
    }
    auto nohdr = noise(0x20000);
    nohdr[8] = 0;
    CHECK(checkSysFileContent(SysFileKind::Firmware, nohdr.data(), nohdr.size()) == SysFileStatus::BadHeader);
    auto wrongsz = fw(0x20001);
    CHECK(checkSysFileContent(SysFileKind::Firmware, wrongsz.data(), wrongsz.size()) == SysFileStatus::WrongSize);
}

TEST(firmware_directory_validation) {
    std::string dir = "/tmp/dslink_fw_" + std::to_string(getpid());
    std::string cmd = "mkdir -p '" + dir + "'";
    CHECK(std::system(cmd.c_str()) == 0);
    SystemFiles none = validateSystemDir(dir);
    CHECK(!none.ready());
    CHECK(none.bios7.status == SysFileStatus::Missing);
    write(dir + "/bios7.bin", noise(0x4000));
    write(dir + "/bios9.bin", noise(0x1000, 9));
    write(dir + "/firmware.bin", fw(0x40000));
    SystemFiles all = validateSystemDir(dir);
    CHECK(all.ready());
    CHECK_EQ(all.bios7.sha256.size(), std::size_t(64));
    CHECK_EQ(all.firmware.size, std::uint64_t(0x40000));
    write(dir + "/bios9.bin", noise(0x4000));  // user imported bios7 under the bios9 name
    SystemFiles swapped = validateSystemDir(dir);
    CHECK(!swapped.ready());
    CHECK(swapped.bios9.status == SysFileStatus::LooksLikeOtherFile);
    CHECK(sysFileStatusMessage(SysFileKind::Bios9, swapped.bios9.status).find("scambiati") != std::string::npos);
    cmd = "rm -rf '" + dir + "'";
    CHECK(std::system(cmd.c_str()) == 0);
}
