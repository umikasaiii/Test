#include <cstdio>
#include <unistd.h>
#include <vector>

#include "dslink/rom.hpp"
#include "dslink/sha256.hpp"
#include "testing.hpp"

using namespace dslink;

namespace {
// Synthetic header (NOT a real game): valid CRCs, arbitrary title.
std::vector<std::uint8_t> fakeRom(std::uint8_t unit = 0, bool badCrc = false, std::size_t size = 0x8000) {
    std::vector<std::uint8_t> r(size, 0);
    const char* title = "TESTROM";
    for (int i = 0; title[i]; ++i) r[std::size_t(i)] = std::uint8_t(title[i]);
    const char* code = "TEST";
    for (int i = 0; i < 4; ++i) r[0x0C + std::size_t(i)] = std::uint8_t(code[i]);
    r[0x12] = unit;
    r[0x15C] = 0x56; r[0x15D] = 0xCF;
    std::uint16_t crc = crc16Modbus(r.data(), 0x15E);
    if (badCrc) crc ^= 0x1234;
    r[0x15E] = std::uint8_t(crc & 255); r[0x15F] = std::uint8_t(crc >> 8);
    return r;
}
}  // namespace

TEST(crc16_modbus_check_value) {
    const char* s = "123456789";
    CHECK_EQ(int(crc16Modbus(reinterpret_cast<const std::uint8_t*>(s), 9)), 0x4B37);
}

TEST(rom_header_validation) {
    auto ok = fakeRom();
    RomInfo i = checkRomHeader(ok.data(), ok.size());
    CHECK(i.status == RomStatus::Ok);
    CHECK_EQ(i.title, std::string("TESTROM"));
    CHECK_EQ(i.gameCode, std::string("TEST"));
    CHECK(i.logoCrcOk);
    auto bad = fakeRom(0, true);
    CHECK(checkRomHeader(bad.data(), bad.size()).status == RomStatus::BadHeaderCrc);
    auto dsi = fakeRom(3);
    CHECK(checkRomHeader(dsi.data(), dsi.size()).status == RomStatus::NotNds);
    auto small = fakeRom(0, false, 0x1000);
    CHECK(checkRomHeader(small.data(), small.size()).status == RomStatus::TooSmall);
    auto enhanced = fakeRom(2);
    CHECK(checkRomHeader(enhanced.data(), enhanced.size()).status == RomStatus::Ok);
}

TEST(rom_file_inspection_hashes_whole_file) {
    std::string p = "/tmp/dslink_rom_" + std::to_string(getpid()) + ".nds";
    auto rom = fakeRom();
    std::FILE* f = std::fopen(p.c_str(), "wb");
    std::fwrite(rom.data(), 1, rom.size(), f);
    std::fclose(f);
    RomInfo i = inspectRomFile(p);
    CHECK(i.status == RomStatus::Ok);
    CHECK_EQ(i.fileSize, std::uint64_t(rom.size()));
    CHECK_EQ(i.sha256.size(), std::size_t(64));
    CHECK(i.sha256 == toHex(sha256(rom.data(), rom.size())));
    std::remove(p.c_str());
    CHECK(inspectRomFile("/nonexistent/x.nds").status == RomStatus::Unreadable);
}
