// WebAssembly build: the browser has no packet capture (and DSLink's PWA runs no Wi-Fi emulation in this milestone). melonDS DS compiles its "direct mode" networking against
// melonDS's Net_PCap, which needs BSD/POSIX interface APIs that do not exist under Emscripten. This stub keeps the core's link contract and reports "no adapters".
#include "Net_PCap.h"

namespace melonDS
{
std::optional<LibPCap> LibPCap::New() noexcept { return std::nullopt; }
LibPCap::LibPCap(LibPCap&&) noexcept = default;
LibPCap& LibPCap::operator=(LibPCap&&) noexcept = default;
std::unique_ptr<Net_PCap> LibPCap::Open(std::string_view, const Platform::SendPacketCallback&) const noexcept { return nullptr; }
std::unique_ptr<Net_PCap> LibPCap::Open(const AdapterData&, const Platform::SendPacketCallback&) const noexcept { return nullptr; }
std::vector<AdapterData> LibPCap::GetAdapters() const noexcept { return {}; }
bool LibPCap::TryLoadPCap(LibPCap&, Platform::DynamicLibrary*) noexcept { return false; }

Net_PCap::~Net_PCap() noexcept = default;
Net_PCap::Net_PCap(Net_PCap&&) noexcept = default;
Net_PCap& Net_PCap::operator=(Net_PCap&&) noexcept = default;
int Net_PCap::SendPacket(u8*, int) noexcept { return 0; }
void Net_PCap::RecvCheck() noexcept {}
}  // namespace melonDS
