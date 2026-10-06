#include "link.hpp"

#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

#include <cerrno>
#include <cstring>

namespace dsrt {

Link::~Link() {
    if (peer_ >= 0) ::close(peer_);
    if (lfd_ >= 0) { ::close(lfd_); ::unlink(path_.c_str()); }
}

bool Link::listen(const std::string& path, std::string& err) {
    path_ = path;
    ::unlink(path.c_str());
    lfd_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
    sockaddr_un a{};
    a.sun_family = AF_UNIX;
    std::strncpy(a.sun_path, path.c_str(), sizeof a.sun_path - 1);
    if (lfd_ < 0 || ::bind(lfd_, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0 || ::listen(lfd_, 2) != 0) {
        err = std::string("link listen: ") + std::strerror(errno);
        return false;
    }
    fcntl(lfd_, F_SETFL, fcntl(lfd_, F_GETFL, 0) | O_NONBLOCK);
    return true;
}

void Link::send(uint8_t type, uint8_t flags, const void* a, size_t an, const void* b, size_t bn) {
    std::lock_guard<std::recursive_mutex> lk(sendMu_);
    if (peer_ < 0) return;
    std::vector<uint8_t> f(8 + an + bn);
    uint32_t len = uint32_t(an + bn);
    f[0] = type; f[1] = flags; f[2] = f[3] = 0;
    std::memcpy(f.data() + 4, &len, 4);
    if (an) std::memcpy(f.data() + 8, a, an);
    if (bn) std::memcpy(f.data() + 8 + an, b, bn);
    size_t off = 0;
    int stalls = 0;
    while (off < f.size()) {
        ssize_t w = ::send(peer_, f.data() + off, f.size() - off, MSG_NOSIGNAL | MSG_DONTWAIT);
        if (w < 0) {
            if ((errno == EAGAIN || errno == EWOULDBLOCK) && ++stalls < 50) { pollfd p{peer_, POLLOUT, 0}; ::poll(&p, 1, 2); continue; }
            if (errno == EAGAIN || errno == EWOULDBLOCK) return;  // slow consumer: drop this frame rather than stall emulation
            if (errno == EINTR) continue;
            ::close(peer_); peer_ = -1; rx_.clear();
            return;
        }
        off += size_t(w);
    }
}

void Link::poll(const std::function<void(uint8_t, const uint8_t*, size_t)>& onCmd) {
    std::lock_guard<std::recursive_mutex> lk(sendMu_);
    if (lfd_ >= 0) {
        int fd = ::accept(lfd_, nullptr, nullptr);
        if (fd >= 0) {
            if (peer_ >= 0) ::close(peer_);
            peer_ = fd;
            fcntl(peer_, F_SETFL, fcntl(peer_, F_GETFL, 0) | O_NONBLOCK);
            rx_.clear();
            uint8_t zero = 0;
            onCmd(255, &zero, 0);  // 255 = peer connected
        }
    }
    if (peer_ < 0) return;
    uint8_t buf[4096];
    for (;;) {
        ssize_t r = ::recv(peer_, buf, sizeof buf, 0);
        if (r > 0) { rx_.insert(rx_.end(), buf, buf + r); continue; }
        if (r == 0 || (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR)) { ::close(peer_); peer_ = -1; rx_.clear(); return; }
        break;
    }
    size_t off = 0;
    while (rx_.size() - off >= 8) {
        uint32_t len;
        std::memcpy(&len, rx_.data() + off + 4, 4);
        if (len > (1u << 20)) { ::close(peer_); peer_ = -1; rx_.clear(); return; }
        if (rx_.size() - off < 8 + len) break;
        onCmd(rx_[off], rx_.data() + off + 8, len);
        off += 8 + len;
    }
    rx_.erase(rx_.begin(), rx_.begin() + long(off));
}

}  // namespace dsrt
