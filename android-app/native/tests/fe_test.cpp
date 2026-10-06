// Unit test of the platform-neutral front end against a SYNTHETIC channel (writer = ShmSink, the Runtime's own writer class) and against a real Runtime
// when a shm file path is given (tests/runtime/test_android_frontend.py drives that).
#include <fcntl.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <thread>
#include <vector>

#include "front_end.hpp"
#include "shm_sink.hpp"

static int fails = 0, total = 0;
#define CHECK(cond, msg) do { ++total; if (!(cond)) { ++fails; std::printf("FAIL  %s\n", msg); } else std::printf("PASS  %s\n", msg); } while (0)

int main() {
    const std::string path = "/tmp/dsfe_test.shm";
    unlink(path.c_str());
    dsfe::ShmReader rd;
    CHECK(!rd.open(path), "no file yet: open() fails cleanly");
    dsrt::ShmSink wr;
    std::string err;
    CHECK(wr.open(path, err), "Runtime-side writer creates the channel");
    CHECK(rd.open(path) && rd.valid() && rd.alive(), "reader maps it: magic/version valid, Runtime alive");

    // video: a 256x384 frame with a recognisable pattern, XRGB (B,G,R,X in memory)
    std::vector<uint8_t> f(256 * 384 * 4);
    for (size_t i = 0; i < 256 * 384; ++i) { f[4 * i] = uint8_t(i); f[4 * i + 1] = uint8_t(i >> 8); f[4 * i + 2] = 0x7F; f[4 * i + 3] = 0; }
    std::vector<uint8_t> out; uint32_t w = 0, h = 0;
    CHECK(!rd.copyLatest(out, w, h), "no frame published yet: nothing to copy");
    wr.pushVideo(f.data(), 256, 384, 256 * 4);
    CHECK(rd.copyLatest(out, w, h) && w == 256 && h == 384 && out == f, "frame arrives bit-exact (size + pixels)");
    CHECK(!rd.copyLatest(out, w, h), "the same frame is not delivered twice");
    f[0] ^= 0xFF; wr.pushVideo(f.data(), 256, 384, 256 * 4);
    CHECK(rd.copyLatest(out, w, h) && out[0] == f[0], "the next frame replaces it");
    std::vector<uint8_t> big(512 * 768 * 4, 9);   // resolution change (core upscaling) is carried by w/h
    wr.pushVideo(big.data(), 512, 768, 512 * 4);
    CHECK(rd.copyLatest(out, w, h) && w == 512 && h == 768 && out.size() == big.size(), "a bigger frame size is handled");

    // audio ring: priming, normal pull, underrun, runaway
    std::vector<int16_t> a(2 * 600);
    for (size_t i = 0; i < 600; ++i) { a[2 * i] = int16_t(i); a[2 * i + 1] = int16_t(-int(i)); }
    std::vector<int16_t> o(2 * 480);
    wr.pushAudio(a.data(), 600, 32728);
    CHECK(rd.sampleRate() == 32728, "sample rate is published");
    CHECK(rd.pullAudio(o.data(), 480) == 0 && o[0] == 0 && rd.audioStats().underruns == 0, "priming: below the pre-fill cushion it plays silence and does NOT count an underrun");
    wr.pushAudio(a.data(), 600, 32728);   // 1200 frames available >= prefill
    CHECK(rd.pullAudio(o.data(), 480) == 480 && o[2 * 5] == 5 && o[2 * 5 + 1] == -5, "after priming it delivers the samples in order, left/right intact");
    rd.pullAudio(o.data(), 480); rd.pullAudio(o.data(), 480);   // drain: 240 left, then short
    CHECK(rd.audioStats().underruns == 1, "running dry is counted as ONE underrun and re-primes");
    std::vector<int16_t> flood(2 * 20000, 3);
    wr.pushAudio(flood.data(), 20000, 32728);
    rd.pullAudio(o.data(), 480);
    CHECK(rd.audioStats().skips == 1, "a reader that fell more than the max lag behind jumps ahead (no runaway latency)");
    wr.pushAudio(flood.data(), 4000, 32728);
    size_t before = rd.audioStats().pulled; rd.pullAudio(o.data(), 480);
    CHECK(rd.audioStats().pulled - before == 480, "and keeps playing normally afterwards");

    // input / control
    rd.setButton(8, true); rd.setButton(4, true); rd.setButton(8, false);
    CHECK(rd.buttons() == (1u << 4), "buttons set/clear individually (A released, UP still held)");
    rd.setTouch(0.5f, 0.75f, true);
    bool d; float x, y;
    CHECK(wr.takeTouch(d, x, y) && d && x > 0.499f && x < 0.501f && y > 0.749f && y < 0.751f, "touch reaches the Runtime side, quantised to 16 bit");
    CHECK(!wr.takeTouch(d, x, y), "an unchanged touch is not re-delivered");
    rd.setPaused(true); CHECK(wr.paused(), "pause flag"); rd.setPaused(false); CHECK(!wr.paused(), "resume");
    rd.requestQuit(); CHECK(wr.quitRequested(), "quit request");
    CHECK(dsfe::padId("a") == 8 && dsfe::padId("up") == 4 && dsfe::padId("l2") == 12 && dsfe::padId("start") == 3 && dsfe::padId("nope") == -1, "touch-control button names map to libretro pad ids");

    // status + restart: a new Runtime re-creates the channel without truncating the file the reader has mapped
    wr.publishStatus(59.9, 1.5, 4.0, 1, 1234);
    auto st = rd.status();
    CHECK(st.alive && st.fps > 59.8 && st.fps < 60 && st.peers == 1 && st.frames == 1234, "status block (fps, frame time, peers) readable for the developer overlay");
    uint32_t s1 = rd.session();
    wr.close();
    CHECK(!rd.alive(), "after an orderly stop alive == false");
    dsrt::ShmSink wr2;
    CHECK(wr2.open(path, err), "a second Runtime re-opens the same file (no truncation, no SIGBUS for the mapped reader)");
    CHECK(rd.alive() && rd.session() != s1, "reader sees a new session and re-syncs");
    wr2.pushVideo(f.data(), 256, 384, 256 * 4);
    CHECK(rd.copyLatest(out, w, h) && w == 256, "frames flow again after the restart");
    unlink(path.c_str());
    std::printf("%d/%d checks passed\n", total - fails, total);
    return fails ? 1 : 0;
}
