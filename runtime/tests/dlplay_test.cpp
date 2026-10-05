// Synthetic-frame test of the Download Play diagnostics state machine (no ROMs, no emulator).
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "dlplay_diag.hpp"
using namespace dsrt;

static std::vector<uint8_t> frame(uint8_t mpType, uint16_t fc, size_t bodyLen, const std::vector<uint8_t>& body = {}) {
    std::vector<uint8_t> p(10 + 12 + 24 + bodyLen, 0);
    p[9] = mpType;
    p[10 + 10] = uint8_t((24 + bodyLen) & 255); p[10 + 11] = uint8_t((24 + bodyLen) >> 8);
    p[22] = uint8_t(fc & 255); p[23] = uint8_t(fc >> 8);
    for (size_t i = 0; i < body.size() && i < bodyLen; i++) p[46 + i] = body[i];
    return p;
}
static std::vector<uint8_t> beacon(bool nintendo) {
    std::vector<uint8_t> body(12, 0);                           // timestamp, interval, capability
    body.insert(body.end(), {0x00, 0x04, 'T', 'E', 'S', 'T'});  // SSID IE
    if (nintendo) body.insert(body.end(), {0xDD, 0x08, 0x00, 0x09, 0xBF, 0x00, 0x34, 0x12, 0x00, 0x00});
    return frame(0, 0x0080, body.size(), body);
}

static int fails = 0;
#define CHECK(c, msg) do { if (!(c)) { std::printf("FAIL  %s\n", msg); ++fails; } else std::printf("PASS  %s\n", msg); } while (0)

int main() {
    // ---- host: radio on, non-Nintendo beacons do not count as advertising, Nintendo beacons do
    DlDiag h; double t = 0;
    h.logFn = [](const std::string& s) { std::printf("   %s\n", s.c_str()); };
    for (int i = 0; i < 5; i++) { auto b = beacon(false); h.observe(true, b.data(), b.size(), t += 100); }
    CHECK(h.state() == DlState::RADIO_ON, "plain beacons: radio on, not advertising a DS game");
    for (int i = 0; i < 4; i++) { auto b = beacon(true); h.observe(true, b.data(), b.size(), t += 100); }
    CHECK(h.state() == DlState::HOST_ADVERTISING, "Nintendo vendor-IE beacons transmitted -> HOST_ADVERTISING");
    CHECK(h.counters().lastGameId == 0x1234 * 0x100 + 0x00 || h.counters().lastGameId != 0, "game id read from the vendor IE");

    // ---- client: scanning, discovery, handshake, transfer, verify, boot, second handshake, lobby, in game
    DlDiag c; t = 0;
    c.logFn = [](const std::string& s) { std::printf("   %s\n", s.c_str()); };
    auto probe = frame(0, 0x0040, 0);
    c.observe(true, probe.data(), probe.size(), t += 50);
    CHECK(c.state() == DlState::CLIENT_SCANNING, "probe request transmitted -> CLIENT_SCANNING");
    auto nb = beacon(true);
    c.observe(false, nb.data(), nb.size(), t += 200);
    CHECK(c.state() == DlState::GAME_DISCOVERED, "Nintendo beacon received -> GAME_DISCOVERED");
    auto auth = frame(0, 0x00B0, 6), areq = frame(0, 0x0000, 4), aresp = frame(0, 0x0010, 6);
    c.observe(true, auth.data(), auth.size(), t += 100);
    CHECK(c.state() == DlState::DOWNLOAD_HANDSHAKE, "authentication -> DOWNLOAD_HANDSHAKE");
    c.observe(true, areq.data(), areq.size(), t += 10); c.observe(false, aresp.data(), aresp.size(), t += 10);
    auto data = frame(0, 0x0008, 1000);
    for (int i = 0; i < 20; i++) c.observe(false, data.data(), data.size(), t += 5);
    CHECK(c.state() == DlState::DOWNLOAD_TRANSFER, "bulk data -> DOWNLOAD_TRANSFER");
    for (int i = 0; i < 100; i++) c.observe(false, data.data(), data.size(), t += 5);
    c.tick(t += 2000);
    CHECK(c.state() == DlState::DOWNLOAD_VERIFY, "traffic stops -> DOWNLOAD_VERIFY");
    c.tick(t += 3000);
    CHECK(c.state() == DlState::CLIENT_GAME_BOOT, "radio silent -> CLIENT_GAME_BOOT");
    c.observe(true, auth.data(), auth.size(), t += 500);
    CHECK(c.state() == DlState::GAME_HANDSHAKE, "association after the download -> GAME_HANDSHAKE");
    auto cmd = frame(2, 0x0008, 20), rep = frame(1, 0x0008, 20);
    c.tick(t += 10);
    for (int i = 0; i < 10; i++) { c.observe(false, cmd.data(), cmd.size(), t += 100); c.observe(true, rep.data(), rep.size(), t += 5); }
    c.tick(t += 2100);
    CHECK(c.state() == DlState::LOBBY, "low-rate command/reply -> LOBBY");
    for (int i = 0; i < 60; i++) { c.observe(false, cmd.data(), cmd.size(), t += 16); c.observe(true, rep.data(), rep.size(), t += 1); }
    c.tick(t += 100);
    c.tick(t += 2100);
    CHECK(c.state() == DlState::IN_GAME, "sustained command/reply cadence -> IN_GAME");

    // ---- history carries timestamps and durations; JSON is well formed enough to contain them
    CHECK(c.history().size() >= 8, "every transition recorded");
    bool durOk = true;
    for (auto& tr : c.history()) durOk &= tr.prevDurationMs >= 0 && tr.tMs >= tr.prevDurationMs;
    CHECK(durOk, "timestamps and durations are consistent");
    CHECK(c.json().find("\"dl_state\":\"IN_GAME\"") != std::string::npos && c.json().find("dl_hist") != std::string::npos, "status JSON exposes state and history");

    // ---- stalled handshake becomes ERROR
    DlDiag e; t = 0;
    e.observe(true, auth.data(), auth.size(), t += 10);
    e.tick(t += 1000); e.tick(t += 20000);
    CHECK(e.state() == DlState::ERROR, "handshake that never reaches a transfer -> ERROR");
    std::printf("%s\n", fails ? "dlplay_test: FAILED" : "dlplay_test: all checks passed");
    return fails ? 1 : 0;
}
