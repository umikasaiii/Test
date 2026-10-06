// JNI surface of the DSLink Android app: com.dslink.app.Native.
// One Engine per process: the shared-memory reader (what the Runtime publishes / what the user does), the GL renderer, the AAudio output and a small
// watcher thread that (re)connects to the Runtime's channel and starts/stops audio with it. Also wraps the existing DSLink C++ validation of the user's
// private files (bios7/bios9/firmware/.nds) so Kotlin never re-implements it.
#include <android/log.h>
#include <android/native_window_jni.h>
#include <jni.h>

#include <atomic>
#include <chrono>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

#include "audio_out.hpp"
#include "dslink/firmware.hpp"
#include "dslink/rom.hpp"
#include "front_end.hpp"
#include "renderer.hpp"

#define TAG "dslink-jni"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)

namespace {

struct Engine {
    dsfe::ShmReader reader;
    dsfe::Renderer renderer{reader};
    dsfe::AudioOut audio{reader};
    std::string path;
    std::thread watcher;
    std::atomic<bool> running{false};
    std::atomic<bool> paused{false};
    std::mutex openMu;

    void start(const std::string& p) {
        path = p;
        running = true;
        renderer.start();
        watcher = std::thread([this] { watch(); });
    }
    void shutdown() {
        if (!running.exchange(false)) return;
        if (watcher.joinable()) watcher.join();
        audio.stop();
        renderer.stop();
        reader.close();
    }
    // keeps the channel open (the Runtime creates the file only when a game starts), runs audio while a Runtime is alive and has produced sound
    void watch() {
        while (running) {
            if (!reader.isOpen()) reader.open(path);
            const bool alive = reader.isOpen() && reader.alive();
            if (alive && !audio.running() && reader.sampleRate() > 0) audio.start(reader.sampleRate());
            if (!alive && audio.running()) audio.stop();
            if (alive && audio.running() && reader.sampleRate() != audio.rate() && reader.sampleRate() > 0) { audio.stop(); audio.start(reader.sampleRate()); }
            std::this_thread::sleep_for(std::chrono::milliseconds(200));
        }
    }
};

std::unique_ptr<Engine> g_engine;
std::mutex g_mu;

Engine* eng() { return g_engine.get(); }

std::string jstr(JNIEnv* env, jstring s) {
    if (!s) return "";
    const char* c = env->GetStringUTFChars(s, nullptr);
    std::string r = c ? c : "";
    if (c) env->ReleaseStringUTFChars(s, c);
    return r;
}

}  // namespace

extern "C" {

JNIEXPORT void JNICALL Java_com_dslink_app_Native_nativeInit(JNIEnv* env, jclass, jstring shmPath) {
    std::lock_guard<std::mutex> l(g_mu);
    if (g_engine) return;
    g_engine = std::make_unique<Engine>();
    g_engine->start(jstr(env, shmPath));
    LOGI("engine started");
}

JNIEXPORT void JNICALL Java_com_dslink_app_Native_nativeShutdown(JNIEnv*, jclass) {
    std::lock_guard<std::mutex> l(g_mu);
    if (g_engine) { g_engine->shutdown(); g_engine.reset(); }
}

JNIEXPORT void JNICALL Java_com_dslink_app_Native_nativeSetSurface(JNIEnv* env, jclass, jobject surface) {
    if (!eng()) return;
    ANativeWindow* w = surface ? ANativeWindow_fromSurface(env, surface) : nullptr;
    eng()->renderer.setWindow(w);   // takes its own reference
    if (w) ANativeWindow_release(w);
}

JNIEXPORT void JNICALL Java_com_dslink_app_Native_nativeSetLayout(JNIEnv*, jclass, jfloat cl, jfloat ct, jfloat cr, jfloat cb, jfloat vl, jfloat vt, jfloat vr, jfloat vb, jboolean linear) {
    if (!eng()) return;
    const float r[8] = {cl, ct, cr, cb, vl, vt, vr, vb};
    eng()->renderer.setLayout(r, linear == JNI_TRUE);
}

JNIEXPORT void JNICALL Java_com_dslink_app_Native_nativeSetVisible(JNIEnv*, jclass, jboolean v) { if (eng()) eng()->renderer.setVisible(v == JNI_TRUE); }

JNIEXPORT void JNICALL Java_com_dslink_app_Native_nativeButton(JNIEnv*, jclass, jint id, jboolean down) { if (eng()) eng()->reader.setButton(id, down == JNI_TRUE); }
JNIEXPORT void JNICALL Java_com_dslink_app_Native_nativeTouch(JNIEnv*, jclass, jfloat x, jfloat y, jboolean down) { if (eng()) eng()->reader.setTouch(x, y, down == JNI_TRUE); }
JNIEXPORT void JNICALL Java_com_dslink_app_Native_nativeReleaseAll(JNIEnv*, jclass) {
    if (!eng()) return;
    for (int i = 0; i < 16; ++i) eng()->reader.setButton(i, false);
    eng()->reader.setTouch(0, 0, false);
}

JNIEXPORT void JNICALL Java_com_dslink_app_Native_nativeSetPaused(JNIEnv*, jclass, jboolean p) {
    if (!eng()) return;
    eng()->paused = p == JNI_TRUE;
    eng()->reader.setPaused(p == JNI_TRUE);
    eng()->audio.setPaused(p == JNI_TRUE);
}

JNIEXPORT void JNICALL Java_com_dslink_app_Native_nativeRequestQuit(JNIEnv*, jclass) { if (eng()) eng()->reader.requestQuit(); }

JNIEXPORT jint JNICALL Java_com_dslink_app_Native_nativePadId(JNIEnv* env, jclass, jstring name) { return dsfe::padId(jstr(env, name)); }

// [renderFps, uploads, surfaceW, surfaceH, frameW, frameH, audioRunning, audioRate, audioUnderruns, audioSkips, aaudioXruns, audioLatencyMs, runtimeFps, runtimeFrameMs, runtimeSlowestMs, runtimePeers, runtimeAlive]
JNIEXPORT jdoubleArray JNICALL Java_com_dslink_app_Native_nativeMetrics(JNIEnv* env, jclass) {
    double v[17] = {0};
    if (eng()) {
        auto r = eng()->renderer.metrics();
        auto a = eng()->audio.metrics();
        auto s = eng()->reader.status();
        v[0] = r.fps; v[1] = double(r.uploads); v[2] = r.surfaceW; v[3] = r.surfaceH; v[4] = r.w; v[5] = r.h;
        v[6] = a.running ? 1 : 0; v[7] = a.rate; v[8] = double(a.underruns); v[9] = double(a.skips); v[10] = double(a.xruns); v[11] = a.latencyMs;
        v[12] = s.fps; v[13] = s.frameMs; v[14] = s.slowestMs; v[15] = s.peers; v[16] = s.alive ? 1 : 0;
    }
    jdoubleArray out = env->NewDoubleArray(17);
    env->SetDoubleArrayRegion(out, 0, 17, v);
    return out;
}

// private-file validation = the DSLink C++ code the desktop tools use. kind: 0 bios7, 1 bios9, 2 firmware. Returns "code|message|sha256".
JNIEXPORT jstring JNICALL Java_com_dslink_app_Native_nativeCheckSysFile(JNIEnv* env, jclass, jint kind, jstring path) {
    using namespace dslink;
    const SysFileKind k = kind == 0 ? SysFileKind::Bios7 : kind == 1 ? SysFileKind::Bios9 : SysFileKind::Firmware;
    SysFileResult r = validateSysFile(k, jstr(env, path));
    std::string s = std::string(sysFileStatusCode(r.status)) + "|" + sysFileStatusMessage(k, r.status) + "|" + (r.status == SysFileStatus::Ok ? r.sha256.substr(0, 12) : "");
    return env->NewStringUTF(s.c_str());
}

// .nds header check. Returns "code|message|title|gamecode".
JNIEXPORT jstring JNICALL Java_com_dslink_app_Native_nativeInspectRom(JNIEnv* env, jclass, jstring path) {
    using namespace dslink;
    RomInfo r = inspectRomFile(jstr(env, path));
    std::string s = std::string(romStatusCode(r.status)) + "|" + romStatusMessage(r.status) + "|" + r.title + "|" + r.gameCode;
    return env->NewStringUTF(s.c_str());
}

}  // extern "C"
