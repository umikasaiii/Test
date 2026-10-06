#include "shm_sink.hpp"

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <cerrno>
#include <chrono>
#include <cstring>
#include <random>

namespace dsrt {
using namespace shm;

ShmSink::~ShmSink() { close(); }

bool ShmSink::open(const std::string& path, std::string& err) {
    // never O_TRUNC: a front end that still has the previous file mapped would take SIGBUS while the size is momentarily 0. The file only ever grows.
    fd_ = ::open(path.c_str(), O_RDWR | O_CREAT, 0600);
    if (fd_ < 0) { err = "shm open: " + std::string(strerror(errno)); return false; }
    struct stat st {};
    if (fstat(fd_, &st) == 0 && size_t(st.st_size) < kFileBytes && ftruncate(fd_, off_t(kFileBytes)) != 0) { err = "shm ftruncate: " + std::string(strerror(errno)); ::close(fd_); fd_ = -1; return false; }
    void* m = mmap(nullptr, kFileBytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd_, 0);
    if (m == MAP_FAILED) { err = "shm mmap: " + std::string(strerror(errno)); ::close(fd_); fd_ = -1; return false; }
    base_ = static_cast<uint8_t*>(m);
    std::memset(base_, 0, kHeaderBytes);
    hdr_ = reinterpret_cast<Header*>(base_);
    std::random_device rd;
    hdr_->version.store(kVersion);
    hdr_->session.store(rd() | 1u);
    hdr_->alive.store(1);
    hdr_->magic.store(kMagic, std::memory_order_release);  // last: readers only trust a header with the magic set
    return true;
}

void ShmSink::close() {
    if (hdr_) hdr_->alive.store(0);
    if (base_) munmap(base_, kFileBytes);
    base_ = nullptr;
    hdr_ = nullptr;
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
}

void ShmSink::pushVideo(const uint8_t* xrgb, unsigned w, unsigned h, size_t pitch) {
    if (!hdr_ || !xrgb || w == 0 || h == 0 || w > kMaxW || h > kMaxH) return;
    const uint32_t next = (hdr_->vlatest.load(std::memory_order_relaxed) + 1) % kSlots;
    auto& seq = hdr_->slotSeq[next];
    seq.fetch_add(1, std::memory_order_acq_rel);  // odd: being written
    uint8_t* dst = base_ + kVideoOffset + size_t(next) * kSlotBytes;
    if (pitch == size_t(w) * 4) std::memcpy(dst, xrgb, size_t(w) * h * 4);
    else for (unsigned y = 0; y < h; ++y) std::memcpy(dst + size_t(y) * w * 4, xrgb + y * pitch, size_t(w) * 4);
    seq.fetch_add(1, std::memory_order_release);  // even: complete
    hdr_->vw.store(w, std::memory_order_relaxed);
    hdr_->vh.store(h, std::memory_order_relaxed);
    hdr_->vlatest.store(next, std::memory_order_release);
    hdr_->vframes.fetch_add(1, std::memory_order_release);
}

void ShmSink::pushAudio(const int16_t* stereo, size_t frames, unsigned sampleRate) {
    if (!hdr_ || !stereo || !frames) return;
    hdr_->sampleRate.store(sampleRate, std::memory_order_relaxed);
    uint64_t w = hdr_->awpos.load(std::memory_order_relaxed);
    int16_t* ring = reinterpret_cast<int16_t*>(base_ + kAudioOffset);
    for (size_t i = 0; i < frames; ++i, ++w) {
        const size_t idx = size_t(w & (kAudioFrames - 1)) * 2;
        ring[idx] = stereo[2 * i];
        ring[idx + 1] = stereo[2 * i + 1];
    }
    hdr_->awpos.store(w, std::memory_order_release);
}

bool ShmSink::takeTouch(bool& down, float& x, float& y) {
    if (!hdr_) return false;
    const uint32_t s = hdr_->touchSeq.load(std::memory_order_acquire);
    if (s == lastTouchSeq_) return false;
    lastTouchSeq_ = s;
    unpackTouch(hdr_->touch.load(std::memory_order_relaxed), down, x, y);
    return true;
}

void ShmSink::publishStatus(double fps, double avgFrameMs, double slowestMs, unsigned mpPeers, uint64_t frames) {
    if (!hdr_) return;
    hdr_->fpsX100.store(uint32_t(fps * 100), std::memory_order_relaxed);
    hdr_->frameMsX100.store(uint32_t(avgFrameMs * 100), std::memory_order_relaxed);
    hdr_->slowestMsX100.store(uint32_t(slowestMs * 100), std::memory_order_relaxed);
    hdr_->mpPeers.store(mpPeers, std::memory_order_relaxed);
    hdr_->frames.store(frames, std::memory_order_relaxed);
}

}  // namespace dsrt
