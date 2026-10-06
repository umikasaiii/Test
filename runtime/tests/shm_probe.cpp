// shm_probe: plays the part of the Android front end against a running dslink-runtime started with --shm.
// usage: shm_probe FILE SECONDS [--press-a] [--touch X Y] [--pause-test] [--dump-ppm OUT.ppm] [--quit]
// prints one JSON line with what it saw: frames, size, distinct frames, audio frames, fps, pause behaviour.
#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <string>
#include <thread>
#include <vector>

#include "shm_layout.hpp"

using namespace dsrt::shm;
using Clock = std::chrono::steady_clock;

static uint64_t fnv(const uint8_t* p, size_t n) { uint64_t h = 1469598103934665603ull; for (size_t i = 0; i < n; i += 61) h = (h ^ p[i]) * 1099511628211ull; return h; }

int main(int argc, char** argv) {
    if (argc == 2 && std::string(argv[1]) == "--offsets") {   // byte offsets of the input fields, for harnesses that write them with plain file I/O
        static Header probe;
        auto off = [&](const void* f) { return (long)(reinterpret_cast<const char*>(f) - reinterpret_cast<const char*>(&probe)); };
        std::printf("{\"buttons\":%ld,\"touchSeq\":%ld,\"touch\":%ld,\"paused\":%ld,\"quit\":%ld}\n", off(&probe.buttons), off(&probe.touchSeq), off(&probe.touch), off(&probe.paused), off(&probe.quit));
        return 0;
    }
    if (argc < 3) { std::fprintf(stderr, "usage: shm_probe FILE SECONDS [options]\n"); return 2; }
    const std::string path = argv[1];
    const double secs = std::atof(argv[2]);
    bool pressA = false, touch = false, pauseTest = false, quit = false, keepInput = false;
    float tx = 0, ty = 0;
    std::string ppm;
    for (int i = 3; i < argc; ++i) {
        std::string a = argv[i];
        if (a == "--press-a") pressA = true;
        else if (a == "--touch" && i + 2 < argc) { touch = true; tx = float(std::atof(argv[++i])); ty = float(std::atof(argv[++i])); }
        else if (a == "--pause-test") pauseTest = true;
        else if (a == "--dump-ppm" && i + 1 < argc) ppm = argv[++i];
        else if (a == "--quit") quit = true;
        else if (a == "--keep-input") keepInput = true;   // do not touch buttons/touch: somebody else (the page under test) drives them
    }
    int fd = -1;
    for (int i = 0; i < 100 && fd < 0; ++i) { fd = ::open(path.c_str(), O_RDWR); if (fd < 0) std::this_thread::sleep_for(std::chrono::milliseconds(100)); }
    if (fd < 0) { std::printf("{\"ok\":false,\"error\":\"no shm file\"}\n"); return 1; }
    void* m = mmap(nullptr, kFileBytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (m == MAP_FAILED) { std::printf("{\"ok\":false,\"error\":\"mmap\"}\n"); return 1; }
    auto* h = static_cast<Header*>(m);
    auto* base = static_cast<uint8_t*>(m);
    for (int i = 0; i < 100 && h->magic.load(std::memory_order_acquire) != kMagic; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(50));
    if (h->magic.load() != kMagic || h->version.load() != kVersion) { std::printf("{\"ok\":false,\"error\":\"bad header\"}\n"); return 1; }

    if (!keepInput) {
        h->buttons.store(pressA ? (1u << 8) : 0u);  // RETRO_DEVICE_ID_JOYPAD_A; every run sets the whole input state
        h->touch.store(packTouch(touch, tx, ty));
        h->touchSeq.fetch_add(1);
    }

    uint64_t lastFrames = 0, distinct = 0, lastHash = 0, audioSeen = 0, underrunLike = 0;
    uint32_t w = 0, hh = 0;
    uint64_t rpos = h->awpos.load();
    std::vector<uint8_t> frame(kSlotBytes);
    const auto t0 = Clock::now();
    uint64_t framesAtStart = h->vframes.load();
    double pausedFps = -1;
    bool pausedPhaseDone = false;
    while (std::chrono::duration<double>(Clock::now() - t0).count() < secs) {
        std::this_thread::sleep_for(std::chrono::milliseconds(4));
        const uint64_t f = h->vframes.load(std::memory_order_acquire);
        if (f != lastFrames) {
            lastFrames = f;
            const uint32_t idx = h->vlatest.load(std::memory_order_acquire);
            for (int tries = 0; tries < 5; ++tries) {   // seqlock read
                const uint32_t s0 = h->slotSeq[idx].load(std::memory_order_acquire);
                if (s0 & 1) continue;
                w = h->vw.load(); hh = h->vh.load();
                if (w == 0 || hh == 0 || w > kMaxW || hh > kMaxH) break;
                std::memcpy(frame.data(), base + kVideoOffset + size_t(idx) * kSlotBytes, size_t(w) * hh * 4);
                if (h->slotSeq[idx].load(std::memory_order_acquire) == s0) {
                    const uint64_t hash = fnv(frame.data(), size_t(w) * hh * 4);
                    if (hash != lastHash) { ++distinct; lastHash = hash; }
                    break;
                }
            }
        }
        const uint64_t wp = h->awpos.load(std::memory_order_acquire);
        if (wp - rpos > kAudioFrames) { ++underrunLike; rpos = wp - 2048; }   // reader fell behind: the real reader skips ahead like this
        audioSeen += wp - rpos; rpos = wp; h->arpos.store(rpos);
        if (pauseTest && !pausedPhaseDone && std::chrono::duration<double>(Clock::now() - t0).count() > secs * 0.5) {
            h->paused.store(1);
            std::this_thread::sleep_for(std::chrono::milliseconds(500));
            const uint64_t a = h->frames.load(), fa = h->vframes.load();
            std::this_thread::sleep_for(std::chrono::milliseconds(1500));
            pausedFps = double(h->vframes.load() - fa) / 1.5; (void)a;
            h->paused.store(0);
            pausedPhaseDone = true;
        }
    }
    if (!ppm.empty() && w) {
        std::ofstream o(ppm, std::ios::binary);
        o << "P6\n" << w << " " << hh << "\n255\n";
        for (size_t i = 0; i < size_t(w) * hh; ++i) { char px[3] = {char(frame[4 * i + 2]), char(frame[4 * i + 1]), char(frame[4 * i])}; o.write(px, 3); }
    }
    const double dur = std::chrono::duration<double>(Clock::now() - t0).count();
    if (quit) h->quit.store(1);
    std::printf("{\"ok\":true,\"w\":%u,\"h\":%u,\"frames\":%llu,\"distinct\":%llu,\"fps\":%.1f,\"audio_frames\":%llu,\"sample_rate\":%u,\"audio_overruns\":%llu,"
                "\"runtime_fps\":%.1f,\"frame_ms\":%.2f,\"paused_fps\":%.2f,\"alive\":%u,\"session\":%u}\n",
                w, hh, (unsigned long long)(lastFrames - framesAtStart), (unsigned long long)distinct, double(lastFrames - framesAtStart) / dur,
                (unsigned long long)audioSeen, h->sampleRate.load(), (unsigned long long)underrunLike, h->fpsX100.load() / 100.0, h->frameMsX100.load() / 100.0, pausedFps,
                h->alive.load(), h->session.load());
    return 0;
}
