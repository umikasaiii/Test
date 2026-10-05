// Session architecture, as three independent choices (docs/DISTRIBUTED_MODE.md):
//   SessionMode      DISTRIBUTED  every device runs its own Runtime + melonDS; only the emulated DS radio crosses the network
//                    HOSTED       one device runs every melonDS instance and streams video/audio to the others, which only send input
//   RadioTransport   LOCAL        the bridge between two instances on the same machine (Unix socket)
//                    LAN          DSLink Radio Protocol over UDP between devices (radio_lan.hpp)
//   StreamTransport  NONE         no game stream leaves the device (Distributed)
//                    WEBRTC       encoded video/audio + input over WebRTC (Hosted, and the future cloud path)
#pragma once
#include <string>

namespace dsrt {
enum class SessionMode { Distributed, Hosted };
enum class RadioTransport { Local, Lan };
enum class StreamTransport { None, WebRtc };

inline const char* name(SessionMode m) { return m == SessionMode::Distributed ? "distributed" : "hosted"; }
inline const char* name(RadioTransport t) { return t == RadioTransport::Lan ? "lan" : "local"; }
inline const char* name(StreamTransport t) { return t == StreamTransport::None ? "none" : "webrtc"; }

struct SessionPlan { SessionMode mode = SessionMode::Hosted; RadioTransport radio = RadioTransport::Local; StreamTransport stream = StreamTransport::WebRtc; };

// "auto" = distributed first (hosted stays a manual fallback: no automatic probing yet, by design - collect data first)
inline bool planFor(const std::string& mode, SessionPlan& p, std::string& err) {
    if (mode == "distributed" || mode == "auto") p = {SessionMode::Distributed, RadioTransport::Lan, StreamTransport::None};
    else if (mode == "hosted" || mode.empty()) p = {SessionMode::Hosted, RadioTransport::Local, StreamTransport::WebRtc};
    else { err = "unknown session mode '" + mode + "' (auto|distributed|hosted)"; return false; }
    return true;
}
}  // namespace dsrt
