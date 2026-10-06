#include "renderer.hpp"

#include <EGL/egl.h>
#include <GLES2/gl2.h>
#include <android/log.h>

#include <chrono>
#include <cstring>

#define TAG "dslink-render"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, TAG, __VA_ARGS__)

namespace dsfe {
namespace {
using Clock = std::chrono::steady_clock;

const char* kVs = "attribute vec2 aPos; attribute vec2 aUv; varying vec2 vUv; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); vUv = aUv; }";
// the Runtime's frame is XRGB8888 = bytes B,G,R,X in memory; uploaded as RGBA, so swap R and B here (no GL_BGRA extension needed)
const char* kFs = "precision mediump float; uniform sampler2D uTex; varying vec2 vUv; void main(){ vec4 t = texture2D(uTex, vUv); gl_FragColor = vec4(t.b, t.g, t.r, 1.0); }";

GLuint compile(GLenum type, const char* src) {
    GLuint s = glCreateShader(type);
    glShaderSource(s, 1, &src, nullptr);
    glCompileShader(s);
    GLint ok = 0;
    glGetShaderiv(s, GL_COMPILE_STATUS, &ok);
    if (!ok) { char b[512]; glGetShaderInfoLog(s, sizeof b, nullptr, b); LOGE("shader: %s", b); glDeleteShader(s); return 0; }
    return s;
}

struct Gl {
    EGLDisplay dpy = EGL_NO_DISPLAY;
    EGLContext ctx = EGL_NO_CONTEXT;
    EGLSurface surf = EGL_NO_SURFACE;
    GLuint prog = 0, tex = 0;
    GLint aPos = -1, aUv = -1, uTex = -1;
    uint32_t texW = 0, texH = 0;
    bool linear = true;
    int sw = 0, sh = 0;

    bool init(ANativeWindow* win) {
        dpy = eglGetDisplay(EGL_DEFAULT_DISPLAY);
        if (dpy == EGL_NO_DISPLAY || !eglInitialize(dpy, nullptr, nullptr)) { LOGE("eglInitialize failed"); return false; }
        const EGLint cfgAttr[] = {EGL_RENDERABLE_TYPE, EGL_OPENGL_ES2_BIT, EGL_SURFACE_TYPE, EGL_WINDOW_BIT, EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_NONE};
        EGLConfig cfg; EGLint n = 0;
        if (!eglChooseConfig(dpy, cfgAttr, &cfg, 1, &n) || n < 1) { LOGE("eglChooseConfig failed"); return false; }
        const EGLint ctxAttr[] = {EGL_CONTEXT_CLIENT_VERSION, 2, EGL_NONE};
        ctx = eglCreateContext(dpy, cfg, EGL_NO_CONTEXT, ctxAttr);
        surf = eglCreateWindowSurface(dpy, cfg, reinterpret_cast<EGLNativeWindowType>(win), nullptr);
        if (ctx == EGL_NO_CONTEXT || surf == EGL_NO_SURFACE) { LOGE("EGL context/surface failed (0x%x)", eglGetError()); return false; }
        if (!eglMakeCurrent(dpy, surf, surf, ctx)) { LOGE("eglMakeCurrent failed"); return false; }
        eglSwapInterval(dpy, 1);
        GLuint vs = compile(GL_VERTEX_SHADER, kVs), fs = compile(GL_FRAGMENT_SHADER, kFs);
        if (!vs || !fs) return false;
        prog = glCreateProgram();
        glAttachShader(prog, vs); glAttachShader(prog, fs);
        glLinkProgram(prog);
        GLint ok = 0; glGetProgramiv(prog, GL_LINK_STATUS, &ok);
        if (!ok) { LOGE("program link failed"); return false; }
        glDeleteShader(vs); glDeleteShader(fs);
        aPos = glGetAttribLocation(prog, "aPos"); aUv = glGetAttribLocation(prog, "aUv"); uTex = glGetUniformLocation(prog, "uTex");
        glGenTextures(1, &tex);
        glBindTexture(GL_TEXTURE_2D, tex);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
        setFilter(true);
        glDisable(GL_DEPTH_TEST); glDisable(GL_BLEND);
        return true;
    }
    void setFilter(bool lin) {
        linear = lin;
        glBindTexture(GL_TEXTURE_2D, tex);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, lin ? GL_LINEAR : GL_NEAREST);
        glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, lin ? GL_LINEAR : GL_NEAREST);
    }
    void upload(const uint8_t* px, uint32_t w, uint32_t h) {
        glBindTexture(GL_TEXTURE_2D, tex);
        if (w != texW || h != texH) { glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, GLsizei(w), GLsizei(h), 0, GL_RGBA, GL_UNSIGNED_BYTE, px); texW = w; texH = h; }
        else glTexSubImage2D(GL_TEXTURE_2D, 0, 0, 0, GLsizei(w), GLsizei(h), GL_RGBA, GL_UNSIGNED_BYTE, px);
    }
    void draw(const float r[8], bool haveLayout) {
        EGLint w = 0, h = 0;
        eglQuerySurface(dpy, surf, EGL_WIDTH, &w); eglQuerySurface(dpy, surf, EGL_HEIGHT, &h);
        sw = w; sh = h;
        if (w <= 0 || h <= 0) return;
        glViewport(0, 0, w, h);
        float cl, ct, cr, cb, vl, vt, vr, vb;
        if (haveLayout) { cl = r[0]; ct = r[1]; cr = r[2]; cb = r[3]; vl = r[4]; vt = r[5]; vr = r[6]; vb = r[7]; }
        else {   // before the page has laid anything out: the whole 2:3 frame, centred and as large as fits
            const float ar = 2.0f / 3.0f;
            float vh = float(h), vw = vh * ar;
            if (vw > float(w)) { vw = float(w); vh = vw / ar; }
            vl = (float(w) - vw) / 2; vr = vl + vw; vt = (float(h) - vh) / 2; vb = vt + vh; cl = vl; ct = vt; cr = vr; cb = vb;
        }
        glDisable(GL_SCISSOR_TEST);
        glClearColor(0, 0, 0, 1);
        glClear(GL_COLOR_BUFFER_BIT);
        glEnable(GL_SCISSOR_TEST);
        const int sx = int(cl + 0.5f), sy = int(float(h) - cb + 0.5f), sW = int(cr - cl + 0.5f), sH = int(cb - ct + 0.5f);
        if (sW <= 0 || sH <= 0) { glDisable(GL_SCISSOR_TEST); return; }
        glScissor(sx, sy, sW, sH);
        const float x0 = vl / float(w) * 2 - 1, x1 = vr / float(w) * 2 - 1, y0 = 1 - vt / float(h) * 2, y1 = 1 - vb / float(h) * 2;
        const GLfloat pos[] = {x0, y0, x1, y0, x0, y1, x1, y1};
        const GLfloat uv[] = {0, 0, 1, 0, 0, 1, 1, 1};
        glUseProgram(prog);
        glActiveTexture(GL_TEXTURE0);
        glBindTexture(GL_TEXTURE_2D, tex);
        glUniform1i(uTex, 0);
        glEnableVertexAttribArray(GLuint(aPos)); glEnableVertexAttribArray(GLuint(aUv));
        glVertexAttribPointer(GLuint(aPos), 2, GL_FLOAT, GL_FALSE, 0, pos);
        glVertexAttribPointer(GLuint(aUv), 2, GL_FLOAT, GL_FALSE, 0, uv);
        glDrawArrays(GL_TRIANGLE_STRIP, 0, 4);
        glDisable(GL_SCISSOR_TEST);
    }
    void destroy() {
        if (dpy != EGL_NO_DISPLAY) {
            eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
            if (surf != EGL_NO_SURFACE) eglDestroySurface(dpy, surf);
            if (ctx != EGL_NO_CONTEXT) eglDestroyContext(dpy, ctx);
            eglTerminate(dpy);
        }
        *this = Gl{};
    }
};
}  // namespace

void Renderer::start() {
    if (running_.exchange(true)) return;
    th_ = std::thread([this] { loop(); });
}

void Renderer::stop() {
    if (!running_.exchange(false)) return;
    cv_.notify_all();
    if (th_.joinable()) th_.join();
    std::lock_guard<std::mutex> l(mu_);
    if (window_) { ANativeWindow_release(window_); window_ = nullptr; }
}

void Renderer::setWindow(ANativeWindow* w) {
    std::lock_guard<std::mutex> l(mu_);
    if (window_) ANativeWindow_release(window_);
    window_ = w;
    if (w) ANativeWindow_acquire(w);
    ++windowGen_;
    layoutDirty_ = true;
    cv_.notify_all();
}

void Renderer::setLayout(const float r[8], bool linear) {
    std::lock_guard<std::mutex> l(mu_);
    std::memcpy(rects_, r, sizeof rects_);
    haveLayout_ = true; linear_ = linear; layoutDirty_ = true;
}

void Renderer::setVisible(bool v) {
    std::lock_guard<std::mutex> l(mu_);
    visible_ = v;
    layoutDirty_ = true;
    cv_.notify_all();
}

RenderMetrics Renderer::metrics() const { std::lock_guard<std::mutex> l(mu_); return m_; }

void Renderer::loop() {
    std::vector<uint8_t> buf;
    uint32_t fw = 0, fh = 0;
    while (running_) {
        ANativeWindow* win = nullptr; uint64_t gen = 0;
        {
            std::unique_lock<std::mutex> l(mu_);
            cv_.wait(l, [&] { return !running_ || (window_ && visible_); });
            if (!running_) break;
            win = window_; gen = windowGen_;
            if (win) ANativeWindow_acquire(win);
        }
        Gl gl;
        if (!gl.init(win)) { LOGE("GL init failed, retrying"); gl.destroy(); ANativeWindow_release(win); std::this_thread::sleep_for(std::chrono::milliseconds(500)); continue; }
        LOGI("renderer up");
        auto lastDraw = Clock::now() - std::chrono::seconds(1), lastFps = Clock::now();
        uint64_t drawn = 0;
        bool haveFrame = false;
        while (running_) {
            float rects[8]; bool haveLayout, linear, dirty;
            {
                std::lock_guard<std::mutex> l(mu_);
                if (!window_ || !visible_ || windowGen_ != gen) break;
                std::memcpy(rects, rects_, sizeof rects); haveLayout = haveLayout_; linear = linear_; dirty = layoutDirty_; layoutDirty_ = false;
            }
            if (reader_.isOpen() && reader_.copyLatest(buf, fw, fh)) {
                gl.upload(buf.data(), fw, fh); haveFrame = true;
                std::lock_guard<std::mutex> l(mu_); ++m_.uploads; m_.w = fw; m_.h = fh;
            } else if (!dirty && Clock::now() - lastDraw < std::chrono::milliseconds(100)) {
                std::this_thread::sleep_for(std::chrono::milliseconds(2));
                continue;
            } else if (!dirty && !haveFrame) {
                std::this_thread::sleep_for(std::chrono::milliseconds(5));
                continue;
            }
            if (linear != gl.linear) gl.setFilter(linear);
            gl.draw(rects, haveLayout);
            if (!eglSwapBuffers(gl.dpy, gl.surf)) { LOGE("eglSwapBuffers failed (0x%x): surface lost", eglGetError()); break; }
            lastDraw = Clock::now();
            ++drawn;
            if (lastDraw - lastFps >= std::chrono::seconds(1)) {
                const double s = std::chrono::duration<double>(lastDraw - lastFps).count();
                std::lock_guard<std::mutex> l(mu_);
                m_.fps = double(drawn) / s; m_.frames += drawn; m_.surfaceW = uint32_t(gl.sw); m_.surfaceH = uint32_t(gl.sh);
                drawn = 0; lastFps = lastDraw;
            }
        }
        gl.destroy();
        ANativeWindow_release(win);
        LOGI("renderer down");
        // surface lost / hidden: wait for the next one (the wait at the top of the loop)
        std::unique_lock<std::mutex> l(mu_);
        cv_.wait_for(l, std::chrono::milliseconds(50), [&] { return !running_; });
    }
}

}  // namespace dsfe
