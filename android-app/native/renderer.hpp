// EGL/GLES2 renderer of the Runtime's raw frames onto the app's SurfaceView (Android only).
// The touch-controls engine (web) lays the picture out exactly as before and hands over two rectangles in device pixels: the clip (what is visible)
// and the video (where the whole 2:3 DS frame goes; larger than the clip in FOCUS views). Everything else is black.
#pragma once
#include <android/native_window.h>

#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <vector>

#include "front_end.hpp"

namespace dsfe {

struct RenderMetrics {
    double fps = 0;
    uint64_t frames = 0, uploads = 0;
    uint32_t w = 0, h = 0;   // size of the last uploaded frame
    uint32_t surfaceW = 0, surfaceH = 0;
};

class Renderer {
public:
    explicit Renderer(ShmReader& reader) : reader_(reader) {}
    ~Renderer() { stop(); }
    void start();
    void stop();
    void setWindow(ANativeWindow* w);                   // takes a reference; nullptr = the surface is gone
    void setLayout(const float rects[8], bool linear);  // clip l,t,r,b then video l,t,r,b (device px, origin top-left of the surface)
    void setVisible(bool v);
    RenderMetrics metrics() const;

private:
    void loop();
    ShmReader& reader_;
    std::thread th_;
    std::atomic<bool> running_{false};
    mutable std::mutex mu_;
    std::condition_variable cv_;
    ANativeWindow* window_ = nullptr;
    uint64_t windowGen_ = 0;
    bool visible_ = false, haveLayout_ = false, linear_ = true, layoutDirty_ = true;
    float rects_[8] = {0};
    RenderMetrics m_;
};

}  // namespace dsfe
