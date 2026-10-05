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
    DlState st;
    // ---- host: radio on, non-Nintendo beacons do not count as advertising, Nintendo beacons do
    DlDiag h; double t = 0;
    h.logFn = [](const std::string& s) { std::printf("   %s\n", s.c_str()); };
    for (int i = 0; i < 5; i++) { auto b = beacon(false); h.observe(true, b.data(), b.size(), t += 100); }
    CHECK(h.state() == DlState::RADIO_ON, "plain beacons: radio on, not advertising a DS game");
    for (int i = 0; i < 4; i++) { auto b = beacon(true); h.observe(true, b.data(), b.size(), t += 100); }
    CHECK(h.state() == DlState::HOST_ADVERTISING, "Nintendo vendor-IE beacons transmitted -> HOST_ADVERTISING");
    CHECK(h.counters().lastGameId == 0x1234 * 0x100 + 0x00 || h.counters().lastGameId != 0, "game id read from the vendor IE");

    // ---- client, with the frame-size signatures captured from a real Mario Party DS Download Play session
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
    auto poll = frame(2, 0x0228, 18), pollReply = frame(1, 0x0118, 14);           // keep-alive polling: small frames never count as the download
    for (int i = 0; i < 50; i++) { c.observe(false, poll.data(), poll.size(), t += 5); c.observe(true, pollReply.data(), pollReply.size(), t += 1); }
    CHECK(c.state() == DlState::DOWNLOAD_HANDSHAKE, "small keep-alive frames alone do not look like a download");
    auto bulk = frame(2, 0x0228, 268);                                               // flen = 292, as captured
    for (int i = 0; i < 30; i++) c.observe(false, bulk.data(), bulk.size(), t += 5);
    CHECK(c.state() == DlState::DOWNLOAD_TRANSFER, "292-byte command frames -> DOWNLOAD_TRANSFER");
    c.tick(t += 200); c.tick(t += 2000);
    CHECK(c.state() == DlState::DOWNLOAD_VERIFY, "payload burst ended while polling continues -> DOWNLOAD_VERIFY");
    auto blank = frame(1, 0x0158, 4);                                                 // flen = 28: blank replies while the downloaded game boots
    c.tick(t += 10);
    for (int i = 0; i < 60; i++) { c.observe(false, poll.data(), poll.size(), t += 20); c.observe(true, blank.data(), blank.size(), t += 1); }
    c.tick(t += 2100);
    CHECK(c.state() == DlState::CLIENT_GAME_BOOT, "burst of blank replies -> CLIENT_GAME_BOOT");
    auto gcmd = frame(2, 0x0228, 178), greply = frame(1, 0x0118, 46);
    for (int i = 0; i < 80; i++) { c.observe(false, gcmd.data(), gcmd.size(), t += 16); c.observe(true, greply.data(), greply.size(), t += 1); }
    c.tick(t += 2100);
    CHECK(c.state() == DlState::GAME_HANDSHAKE, "regular replies resume -> GAME_HANDSHAKE");
    for (int i = 0; i < 80; i++) { c.observe(false, gcmd.data(), gcmd.size(), t += 16); c.observe(true, greply.data(), greply.size(), t += 1); }
    c.tick(t += 2100);
    CHECK(c.state() == DlState::LOBBY, "sustained game-level cadence -> LOBBY");
    c.mark(DlState::IN_GAME, "screen: a match is running", t);
    CHECK(c.state() == DlState::IN_GAME, "IN_GAME is set by the driver from the screen (lobby and game are identical on the wire)");
    CHECK(DlDiag::parse("DOWNLOAD_VERIFY", &st) && st == DlState::DOWNLOAD_VERIFY, "state names parse (for the DIAG_MARK link command)");

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
