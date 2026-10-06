#include "front_end.hpp"

#include <fcntl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <cstring>

namespace dsfe {
using namespace dsrt::shm;

int padId(const std::string& n) {
    static const struct { const char* name; int id; } T[] = {{"b", 0}, {"y", 1}, {"select", 2}, {"start", 3}, {"up", 4}, {"down", 5}, {"left", 6},
                                                              {"right", 7}, {"a", 8}, {"x", 9}, {"l", 10}, {"r", 11}, {"l2", 12}, {"r2", 13}};
    for (auto& e : T) if (n == e.name) return e.id;
    return -1;
}

bool ShmReader::open(const std::string& path) {
    close();
    int fd = ::open(path.c_str(), O_RDWR);
    if (fd < 0) return false;
    struct stat st {};
    if (fstat(fd, &st) != 0 || size_t(st.st_size) < kFileBytes) { ::close(fd); return false; }
    void* m = mmap(nullptr, kFileBytes, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (m == MAP_FAILED) { ::close(fd); return false; }
    fd_ = fd;
    base_ = static_cast<uint8_t*>(m);
    auto* hp = reinterpret_cast<Header*>(base_);
    lastFrame_ = 0;
    vSession_ = aSession_ = hp->session.load();
    primed_ = false;
    hdr_.store(hp, std::memory_order_release);
    return true;
}

void ShmReader::close() {
    hdr_.store(nullptr, std::memory_order_release);
    if (base_) munmap(base_, kFileBytes);
    base_ = nullptr;
    if (fd_ >= 0) ::close(fd_);
    fd_ = -1;
}

bool ShmReader::valid() const { return H() && H()->magic.load(std::memory_order_acquire) == kMagic && H()->version.load() == kVersion; }
uint32_t ShmReader::session() const { return H() ? H()->session.load() : 0; }
bool ShmReader::alive() const { return valid() && H()->alive.load() != 0; }
uint64_t ShmReader::framesPublished() const { return H() ? H()->vframes.load(std::memory_order_acquire) : 0; }
uint32_t ShmReader::sampleRate() const { return H() ? H()->sampleRate.load() : 0; }

bool ShmReader::peekLatest(std::vector<uint8_t>& out, uint32_t& w, uint32_t& h) const {
    if (!valid()) return false;
    const uint32_t idx = H()->vlatest.load(std::memory_order_acquire) % kSlots;
    for (int tries = 0; tries < 8; ++tries) {
        const uint32_t s0 = H()->slotSeq[idx].load(std::memory_order_acquire);
        if (s0 & 1) continue;
        const uint32_t fw = H()->vw.load(), fh = H()->vh.load();
        if (fw == 0 || fh == 0 || fw > kMaxW || fh > kMaxH) return false;
        out.resize(size_t(fw) * fh * 4);
        std::memcpy(out.data(), base_ + kVideoOffset + size_t(idx) * kSlotBytes, out.size());
        if (H()->slotSeq[idx].load(std::memory_order_acquire) == s0) { w = fw; h = fh; return true; }
    }
    return false;
}

bool ShmReader::copyLatest(std::vector<uint8_t>& out, uint32_t& w, uint32_t& h) {
    if (!valid()) return false;
    const uint32_t sess = H()->session.load();
    if (sess != vSession_) { vSession_ = sess; lastFrame_ = 0; }   // a new Runtime: start over
    const uint64_t f = H()->vframes.load(std::memory_order_acquire);
    if (f == lastFrame_) return false;
    if (!peekLatest(out, w, h)) return false;   // the writer lapped us while copying: the next call gets the newer frame
    lastFrame_ = f;
    return true;
}

size_t ShmReader::pullAudio(int16_t* out, size_t frames) {
    if (!valid()) { std::memset(out, 0, frames * 4); return 0; }
    uint64_t w = H()->awpos.load(std::memory_order_acquire), r = H()->arpos.load(std::memory_order_relaxed);
    if (H()->session.load() != aSession_) { aSession_ = H()->session.load(); r = w; primed_ = false; }
    if (w < r) r = w;   // the channel was re-created
    uint64_t avail = w - r;
    if (avail > kMaxLag) { r = w - kTarget; avail = kTarget; ++stats_.skips; }   // far behind: jump ahead instead of playing old sound late
    if (!primed_) {
        if (avail < kPrefill) { std::memset(out, 0, frames * 4); H()->arpos.store(r, std::memory_order_relaxed); return 0; }
        primed_ = true;
    }
    const size_t n = size_t(std::min<uint64_t>(avail, frames));
    const int16_t* ring = reinterpret_cast<const int16_t*>(base_ + kAudioOffset);
    for (size_t i = 0; i < n; ++i) {
        const size_t idx = size_t((r + i) & (kAudioFrames - 1)) * 2;
        out[2 * i] = ring[idx];
        out[2 * i + 1] = ring[idx + 1];
    }
    if (n < frames) { std::memset(out + 2 * n, 0, (frames - n) * 4); ++stats_.underruns; primed_ = false; }
    stats_.pulled += n;
    H()->arpos.store(r + n, std::memory_order_release);
    return n;
}

void ShmReader::resetAudio() { primed_ = false; if (H()) H()->arpos.store(H()->awpos.load()); }

void ShmReader::setButton(int id, bool down) {
    if (!H() || id < 0 || id > 31) return;
    if (down) H()->buttons.fetch_or(1u << id); else H()->buttons.fetch_and(~(1u << id));
}

void ShmReader::setTouch(float x, float y, bool down) {
    if (!H()) return;
    H()->touch.store(packTouch(down, x, y), std::memory_order_relaxed);
    H()->touchSeq.fetch_add(1, std::memory_order_release);
}

void ShmReader::setPaused(bool p) { if (H()) H()->paused.store(p ? 1 : 0); }
void ShmReader::requestQuit() { if (H()) H()->quit.store(1); }
uint32_t ShmReader::buttons() const { return H() ? H()->buttons.load() : 0; }

ShmReader::Debug ShmReader::debug() const {
    Debug d;
    if (!H()) return d;
    d.paused = H()->paused.load(); d.session = H()->session.load(); d.vframes = H()->vframes.load(); d.awpos = H()->awpos.load(); d.arpos = H()->arpos.load();
    return d;
}

RuntimeStatus ShmReader::status() const {
    RuntimeStatus s;
    if (!H()) return s;
    s.fps = H()->fpsX100.load() / 100.0;
    s.frameMs = H()->frameMsX100.load() / 100.0;
    s.slowestMs = H()->slowestMsX100.load() / 100.0;
    s.peers = H()->mpPeers.load();
    s.frames = H()->frames.load();
    s.alive = alive();
    return s;
}

}  // namespace dsfe
