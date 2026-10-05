// DSLink - SHA-256 (public-domain style implementation, FIPS 180-4).
#pragma once
#include <array>
#include <cstddef>
#include <cstdint>
#include <string>

namespace dslink {

using Sha256Digest = std::array<std::uint8_t, 32>;

class Sha256 {
public:
    Sha256() noexcept;
    void update(const void* data, std::size_t len) noexcept;
    Sha256Digest finish() noexcept;

private:
    void block(const std::uint8_t* p) noexcept;
    std::uint32_t h_[8];
    std::uint8_t buf_[64];
    std::uint64_t total_ = 0;
    std::size_t fill_ = 0;
};

Sha256Digest sha256(const void* data, std::size_t len) noexcept;
Sha256Digest sha256(const std::string& s) noexcept;
std::string toHex(const std::uint8_t* data, std::size_t len);
std::string toHex(const Sha256Digest& d);
// Streams the file; returns false when it cannot be read. Never loads the file in memory.
bool sha256File(const std::string& path, std::string& hexOut);

}  // namespace dslink
