// DSLink Runtime <-> local front end shared-memory layout (Android app, desktop test harness).
// One memory-mapped file: the Runtime process creates it and writes video/audio/status; the front end (JNI renderer, AAudio, input) maps the same
// file and writes input/control. Nothing is copied through sockets, nothing is encoded: the front end reads the raw frame straight from here.
// Plain C++ with lock-free atomics only, so the same header is used by the Runtime (writer) and by the JNI library (reader).
#pragma once
#include <atomic>
#include <cstddef>
#include <cstdint>

namespace dsrt {
namespace shm {

constexpr uint32_t kMagic = 0x4B4C5344;  // "DSLK"
constexpr uint32_t kVersion = 1;
constexpr uint32_t kMaxW = 1024, kMaxH = 1536;                 // up to 4x the 256x384 DS frame
constexpr uint32_t kSlots = 3;                                  // video triple buffer
constexpr uint32_t kSlotBytes = kMaxW * kMaxH * 4;              // XRGB8888
constexpr uint32_t kAudioFrames = 1u << 15;                     // stereo frames in the ring (~0.68 s at 48 kHz)
constexpr size_t kHeaderBytes = 4096;

// bit i of Input::buttons = RETRO_DEVICE_ID_JOYPAD_i (port 0): B0 Y1 SELECT2 START3 UP4 DOWN5 LEFT6 RIGHT7 A8 X9 L10 R11 L2 12 R2 13
struct Header {
    // identity
    std::atomic<uint32_t> magic;
    std::atomic<uint32_t> version;
    std::atomic<uint32_t> session;        // changes every time a Runtime (re)creates the file: readers re-sync
    std::atomic<uint32_t> alive;          // 1 while the Runtime is running, 0 after an orderly stop

    // video (Runtime -> front end)
    std::atomic<uint32_t> vw, vh;         // frame size of the newest slot
    std::atomic<uint32_t> vlatest;        // index of the newest complete slot
    std::atomic<uint32_t> pad0;
    std::atomic<uint64_t> vframes;        // frames published since start
    std::atomic<uint32_t> slotSeq[kSlots];  // per-slot seqlock: odd = being written

    // audio (Runtime -> front end): interleaved s16 stereo ring; the writer owns wpos, the reader owns rpos (it clamps when it falls behind)
    std::atomic<uint32_t> sampleRate;
    std::atomic<uint32_t> pad1;
    std::atomic<uint64_t> awpos;          // total frames written
    std::atomic<uint64_t> arpos;          // total frames consumed (maintained by the reader)

    // input (front end -> Runtime)
    std::atomic<uint32_t> buttons;
    std::atomic<uint32_t> touchSeq;       // bumps on every touch change
    std::atomic<uint64_t> touch;          // bit 0 = down, bits 1..16 = x (0..65535 over the frame width), bits 17..32 = y (over the frame height)

    // control (front end -> Runtime)
    std::atomic<uint32_t> paused;         // 1 = do not run the emulator (app in the background)
    std::atomic<uint32_t> quit;           // 1 = shut down in an orderly way

    // status (Runtime -> front end), for the developer overlay only
    std::atomic<uint32_t> fpsX100;
    std::atomic<uint32_t> frameMsX100;    // average time spent in retro_run
    std::atomic<uint32_t> slowestMsX100;
    std::atomic<uint32_t> mpPeers;
    std::atomic<uint64_t> frames;
};

static_assert(sizeof(Header) <= kHeaderBytes, "header must fit its page");
static_assert(std::atomic<uint32_t>::is_always_lock_free && std::atomic<uint64_t>::is_always_lock_free, "lock-free atomics are required in shared memory");

constexpr size_t kVideoOffset = kHeaderBytes;
constexpr size_t kAudioOffset = kVideoOffset + size_t(kSlots) * kSlotBytes;
constexpr size_t kFileBytes = kAudioOffset + size_t(kAudioFrames) * 4;

inline uint64_t packTouch(bool down, float x, float y) {
    auto q = [](float v) { return uint64_t(v < 0 ? 0 : (v > 1 ? 65535 : v * 65535.0f + 0.5f)); };
    return (down ? 1ull : 0ull) | (q(x) << 1) | (q(y) << 17);
}
inline void unpackTouch(uint64_t t, bool& down, float& x, float& y) {
    down = (t & 1) != 0;
    x = float((t >> 1) & 0xFFFF) / 65535.0f;
    y = float((t >> 17) & 0xFFFF) / 65535.0f;
}

}  // namespace shm
}  // namespace dsrt
