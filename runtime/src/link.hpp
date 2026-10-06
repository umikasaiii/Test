// Control/media link between a runtime and its gateway (Unix-domain stream socket, one peer).
// Frame: u8 type | u8 flags | u16 reserved | u32 length | payload   (little endian)
//   runtime -> peer: 1 VIDEO(flags&1=key; u64 pts_us + H.264 Annex-B AU)  2 AUDIO(u64 pts_us + Opus packet)  3 LOG(text)  4 STATUS(JSON)
//   peer -> runtime: 10 BUTTON(u8 port,u8 retropad id,u8 down)  11 TOUCH(f32 x,f32 y,u8 down; x,y in 0..1 over the whole frame)
//                    12 SNAPSHOT(path)  13 QUIT  14 KEYFRAME  15 AUDIO_DUMP(f32 seconds, path)  16 SAVE  17 DIAG_MARK(\"STATE|reason\": a driver that looked at the screen annotates the Download Play state machine)
#pragma once
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

namespace dsrt {

enum LinkType : uint8_t { L_VIDEO = 1, L_AUDIO = 2, L_LOG = 3, L_STATUS = 4, L_BUTTON = 10, L_TOUCH = 11, L_SNAPSHOT = 12, L_QUIT = 13, L_KEYFRAME = 14, L_AUDIO_DUMP = 15, L_SAVE = 16, L_DIAG_MARK = 17, L_MP_STOP = 18 };

class Link {
public:
    ~Link();
    bool listen(const std::string& path, std::string& err);
    void poll(const std::function<void(uint8_t type, const uint8_t* p, size_t n)>& onCmd);  // accept + read, non-blocking
    void send(uint8_t type, uint8_t flags, const void* a, size_t an, const void* b = nullptr, size_t bn = 0);
    bool connected() const { return peer_ >= 0; }

private:
    int lfd_ = -1, peer_ = -1;
    std::recursive_mutex sendMu_;  // the stream encoder sends from its own thread: one frame at a time on the socket (poll() holds it too: its callbacks log through send())
    std::string path_;
    std::vector<uint8_t> rx_;
};

}  // namespace dsrt
