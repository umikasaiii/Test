// dslink-runtime: one emulator instance = libretro core + minimal host + A/V encoder + multiplayer bridge + control link.
#include <deque>
#include <mutex>
#include <signal.h>

#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <map>
#include <sstream>
#include <thread>

#include "av_pipeline.hpp"
#include "link.hpp"
#include "libretro_host.hpp"
#include "mp_bridge.hpp"
#include "dlplay_diag.hpp"
#include "session_mode.hpp"

using namespace dsrt;
using Clock = std::chrono::steady_clock;

namespace {
volatile sig_atomic_t g_quit = 0;
void onSig(int) { g_quit = 1; }

struct Args {
    std::map<std::string, std::string> kv;
    bool has(const char* k) const { return kv.count(k) != 0; }
    std::string get(const char* k, const std::string& d = "") const { auto i = kv.find(k); return i == kv.end() ? d : i->second; }
    int geti(const char* k, int d) const { return has(k) ? std::atoi(kv.at(k).c_str()) : d; }
};

Args parseArgs(int argc, char** argv) {
    Args a;
    for (int i = 1; i < argc; ++i) {
        std::string s = argv[i];
        if (s.rfind("--", 0) == 0) {
            std::string k = s.substr(2);
            if (i + 1 < argc && std::string(argv[i + 1]).rfind("--", 0) != 0) a.kv[k] = argv[++i]; else a.kv[k] = "1";
        }
    }
    return a;
}

std::string jsonEscape(const std::string& s) {
    std::string o;
    for (char c : s) { if (c == '"' || c == '\\') o += '\\'; if (c >= 0x20) o += c; }
    return o;
}

void writeWav(const std::string& path, const std::vector<int16_t>& pcm, unsigned rate) {
    std::ofstream f(path, std::ios::binary);
    uint32_t dataBytes = uint32_t(pcm.size() * 2), riff = 36 + dataBytes, fmtLen = 16, byteRate = rate * 4, srate = rate;
    uint16_t fmt = 1, ch = 2, align = 4, bits = 16;
    f.write("RIFF", 4); f.write(reinterpret_cast<char*>(&riff), 4); f.write("WAVEfmt ", 8);
    f.write(reinterpret_cast<char*>(&fmtLen), 4); f.write(reinterpret_cast<char*>(&fmt), 2); f.write(reinterpret_cast<char*>(&ch), 2);
    f.write(reinterpret_cast<char*>(&srate), 4); f.write(reinterpret_cast<char*>(&byteRate), 4);
    f.write(reinterpret_cast<char*>(&align), 2); f.write(reinterpret_cast<char*>(&bits), 2);
    f.write("data", 4); f.write(reinterpret_cast<char*>(&dataBytes), 4);
    f.write(reinterpret_cast<const char*>(pcm.data()), std::streamsize(dataBytes));
}

void writePpm(const std::string& path, const std::vector<uint8_t>& rgb, unsigned w, unsigned h) {
    std::ofstream f(path, std::ios::binary);
    f << "P6\n" << w << " " << h << "\n255\n";
    f.write(reinterpret_cast<const char*>(rgb.data()), std::streamsize(rgb.size()));
}
}  // namespace

int main(int argc, char** argv) {
    Args args = parseArgs(argc, argv);
    if (!args.has("core")) {
        std::cerr << "usage: dslink-runtime --core core.so [--content rom.nds] --system DIR --save DIR [--options FILE] [--username NAME]\n"
                     "       [--link SOCK] [--av on] [--mp-role host|client --mp-path SOCK] [--frames N] [--name LABEL] [--log FILE]\n";
        return 2;
    }
    signal(SIGINT, onSig);
    signal(SIGTERM, onSig);
    const std::string name = args.get("name", "runtime");
    const std::string name_ = name;
    std::ofstream logf;
    if (args.has("log")) logf.open(args.get("log"), std::ios::app);
    Link link;
    std::mutex logMu;
    std::deque<std::string> logHist;
    auto log = [&](const std::string& s) {
        std::string line = "[" + name + "] " + s;
        if (logf.is_open()) logf << line << "\n" << std::flush; else std::cerr << line << "\n";
        { std::lock_guard<std::mutex> lk(logMu); logHist.push_back(line); if (logHist.size() > 400) logHist.pop_front(); }
        link.send(L_LOG, 0, line.data(), line.size());
    };

    LibretroHost host;
    host.onLog = [&](int lvl, const std::string& s) { static const char* L[] = {"DEBUG", "INFO", "WARN", "ERROR"}; log(std::string("[core ") + L[lvl & 3] + "] " + s); };
    std::string err;
    if (!host.loadCore(args.get("core"), err)) { log("FATAL: " + err); return 3; }
    HostConfig cfg;
    cfg.corePath = args.get("core");
    cfg.contentPath = args.get("content");
    cfg.systemDir = args.get("system", "system");
    cfg.saveDir = args.get("save", "saves");
    cfg.optionsFile = args.get("options");
    cfg.username = args.get("username");
    log("core loaded: " + std::string(host.sysinfo.library_name ? host.sysinfo.library_name : "?"));

    std::string linkPath = args.get("link");
    if (!linkPath.empty() && !link.listen(linkPath, err)) { log("FATAL: " + err); return 3; }

    AvPipeline av;
    bool avOn = args.get("av") == "on";
    std::vector<int16_t> audioDump;
    bool dumping = false;
    uint64_t dumpUntilFrame = 0;

    host.onVideo = [&](const uint8_t* d, unsigned w, unsigned h, size_t p) { av.pushVideo(d, w, h, p); };  // pushVideo also keeps the raw frame
    host.onAudio = [&](const int16_t* d, size_t n) {
        if (avOn) av.pushAudio(d, n);
        if (dumping) audioDump.insert(audioDump.end(), d, d + n * 2);
    };

    if (!host.start(cfg, err)) { log("FATAL: " + err); return 4; }
    log("started: " + std::to_string(host.av.geometry.base_width) + "x" + std::to_string(host.av.geometry.base_height) + " @ " +
        std::to_string(host.av.timing.fps) + " fps, audio " + std::to_string(host.av.timing.sample_rate) + " Hz, SRAM " + std::to_string(host.sramSize()) + " bytes");

    if (avOn) {
        AvConfig ac;
        ac.outW = unsigned(args.geti("out-w", 512));
        ac.outH = unsigned(args.geti("out-h", 768));
        ac.vp8 = args.get("codec", "h264") == "vp8";
        if (!av.open(ac, host.av.timing.sample_rate, err)) { log("FATAL: " + err); return 5; }
        av.onVideo = [&](const uint8_t* d, size_t n, bool key, uint64_t pts) { link.send(L_VIDEO, key ? 1 : 0, &pts, 8, d, n); };
        av.onAudio = [&](const uint8_t* d, size_t n, uint64_t pts) { link.send(L_AUDIO, 0, &pts, 8, d, n); };
    }

    MpBridge mp;
    DlDiag dl;
    dl.logFn = [&](const std::string& s) { log(s); };
    mp.setDiag(&dl);
    SessionPlan plan;
    if (!planFor(args.get("session-mode", args.get("radio-transport") == "lan" ? "distributed" : "hosted"), plan, err)) { log("FATAL: " + err); return 2; }
    if (args.get("radio-transport") == "lan") plan.radio = RadioTransport::Lan; else if (args.get("radio-transport") == "local") plan.radio = RadioTransport::Local;
    if (args.has("stream-transport")) plan.stream = args.get("stream-transport") == "none" ? StreamTransport::None : StreamTransport::WebRtc;
    log(std::string("session: mode=") + dsrt::name(plan.mode) + " radio=" + dsrt::name(plan.radio) + " stream=" + dsrt::name(plan.stream));
    LanConfig lc;
    std::string lanUri;
    auto parseImpair = [](const std::string& s) {
        LanImpair im; std::stringstream ss(s); std::string kv;
        while (std::getline(ss, kv, ',')) { auto e = kv.find('='); if (e == std::string::npos) continue; double v = std::atof(kv.c_str() + e + 1); auto k = kv.substr(0, e);
            if (k == "delay") im.delayMs = v; else if (k == "jitter") im.jitterMs = v; else if (k == "loss") im.lossPct = v; }
        return im; };
    if (plan.radio == RadioTransport::Lan) {
        lc.code = args.get("lan-code"); lc.secretHex = args.get("lan-secret"); lc.bindAddr = args.get("lan-bind", "0.0.0.0");
        lc.port = args.geti("lan-port", 0); lc.discoveryPort = args.geti("lan-discovery-port", 47531); lc.discoveryAddr = args.get("lan-discovery-addr", "255.255.255.255");
        lc.hostAddr = args.get("lan-host"); lc.name = args.get("lan-name", name_); lc.reorderMs = args.geti("lan-reorder-ms", 8);
        lc.impair = parseImpair(args.get("lan-impair")); lc.maxPeers = args.geti("lan-max-peers", 3);
        if (args.has("lan-uri") && !LanLink::parseUri(args.get("lan-uri"), lc)) { log("FATAL: bad --lan-uri"); return 2; }
    }
    if (args.get("mp-role") == "host" || args.get("lan-role") == "host") {
        if (plan.radio == RadioTransport::Lan) {
            if (!mp.startLanHost(host, lc, err)) { log("FATAL: " + err); return 6; }
            lanUri = mp.lan()->joinUri(args.get("lan-advertise-ip", "127.0.0.1"));
            log("multiplayer bridge: host (LAN) code " + lc.code + " port " + std::to_string(mp.lan()->port()));
        } else {
            if (!mp.startHost(host, args.get("mp-path"), err)) { log("FATAL: " + err); return 6; }
            log("multiplayer bridge: host");
        }
    } else if (args.get("mp-role") == "client" || args.get("lan-role") == "guest") {
        if (plan.radio == RadioTransport::Lan) {
            if (!mp.startLanClient(host, lc, args.geti("mp-timeout", 20000), err)) { log("FATAL: " + err); return 6; }
            log("multiplayer bridge: guest (LAN) id " + std::to_string(mp.clientId()));
        } else {
            if (!mp.startClient(host, args.get("mp-path"), args.geti("mp-timeout", 20000), err)) { log("FATAL: " + err); return 6; }
            log("multiplayer bridge: client id " + std::to_string(mp.clientId()));
        }
    }

    const double fps = host.av.timing.fps > 1 ? host.av.timing.fps : 60.0;
    const auto frameDur = std::chrono::duration_cast<Clock::duration>(std::chrono::duration<double>(1.0 / fps));
    const uint64_t maxFrames = uint64_t(args.geti("frames", 0));
    auto next = Clock::now();
    auto lastStatus = Clock::now();
    uint64_t lastFrames = 0;
    double slowest = 0;

    auto onCmd = [&](uint8_t type, const uint8_t* p, size_t n) {
        switch (type) {
            case 255: {
                av.requestKeyframe();
                std::deque<std::string> h;  // lines logged before the peer attached (MAC, multiplayer start...) are replayed
                { std::lock_guard<std::mutex> lk(logMu); h = logHist; }
                for (auto& l : h) link.send(L_LOG, 0, l.data(), l.size());
                log("peer connected");
                break;
            }
            case L_BUTTON:
                if (n >= 3 && p[0] < LibretroHost::kPorts && p[1] < 16) {
                    auto& b = host.input[p[0]].buttons;
                    if (p[2]) b |= (1u << p[1]); else b &= ~(1u << p[1]);
                }
                break;
            case L_TOUCH:
                if (n >= 9) {
                    float x, y;
                    std::memcpy(&x, p, 4); std::memcpy(&y, p + 4, 4);
                    auto cl = [](float v) { return v < 0 ? 0.f : (v > 1 ? 1.f : v); };
                    host.input[0].pointerX = int((cl(x) * 2 - 1) * 32767);
                    host.input[0].pointerY = int((cl(y) * 2 - 1) * 32767);
                    host.input[0].pointerDown = p[8] != 0;
                }
                break;
            case L_SNAPSHOT: {
                std::vector<uint8_t> rgb; unsigned w = 0, h = 0;
                if (av.latestRgb(rgb, w, h)) writePpm(std::string(reinterpret_cast<const char*>(p), n), rgb, w, h);
                break;
            }
            case L_KEYFRAME: av.requestKeyframe(); break;
            case L_SAVE: host.saveSram(); break;
            case L_DIAG_MARK: {
                std::string s(reinterpret_cast<const char*>(p), n);
                auto bar = s.find('|');
                DlState st;
                if (DlDiag::parse(s.substr(0, bar), &st)) dl.mark(st, bar == std::string::npos ? "screen" : "screen: " + s.substr(bar + 1), std::chrono::duration<double, std::milli>(Clock::now().time_since_epoch()).count() - dl.baseMs());
                break;
            }
            case L_AUDIO_DUMP:
                if (n > 4) {
                    float sec; std::memcpy(&sec, p, 4);
                    audioDump.clear(); dumping = true;
                    dumpUntilFrame = host.metrics.frames + uint64_t(sec * fps);
                    // path is stored for the end of the dump
                    static std::string path; path.assign(reinterpret_cast<const char*>(p + 4), n - 4);
                    args.kv["_dumppath"] = path;
                }
                break;
            case L_QUIT: g_quit = 1; break;
        }
    };

    while (!g_quit && !host.shutdownRequested()) {
        link.poll(onCmd);
        mp.pump();
        auto t0 = Clock::now();
        host.runFrame();
        double ms = std::chrono::duration<double, std::milli>(Clock::now() - t0).count();
        if (ms > slowest) slowest = ms;
        if (dumping && host.metrics.frames >= dumpUntilFrame) {
            dumping = false;
            writeWav(args.get("_dumppath"), audioDump, unsigned(host.av.timing.sample_rate + 0.5));
            log("audio dump written");
        }
        if (maxFrames && host.metrics.frames >= maxFrames) break;
        if (Clock::now() - lastStatus >= std::chrono::seconds(1)) {
            double secs = std::chrono::duration<double>(Clock::now() - lastStatus).count();
            host.metrics.fps = double(host.metrics.frames - lastFrames) / secs;
            lastFrames = host.metrics.frames;
            lastStatus = Clock::now();
            dl.tick(std::chrono::duration<double, std::milli>(Clock::now().time_since_epoch()).count());
            std::ostringstream js;
            js << "{\"name\":\"" << jsonEscape(name) << "\",\"frames\":" << host.metrics.frames.load() << ",\"fps\":" << host.metrics.fps.load()
               << ",\"width\":" << host.metrics.width.load() << ",\"height\":" << host.metrics.height.load()
               << ",\"slowest_frame_ms\":" << slowest << ",\"mp_active\":" << (mp.sessionActive() ? "true" : "false")
               << ",\"mp_role\":\"" << (mp.role() == MpBridge::Role::Host ? "host" : mp.role() == MpBridge::Role::Client ? "client" : "none")
               << "\",\"mp_peers\":" << mp.peers() << ",\"mp_in\":" << mp.packetsIn() << ",\"mp_out\":" << mp.packetsOut()
               << ",\"session_mode\":\"" << dsrt::name(plan.mode) << "\",\"radio\":\"" << mp.transportName() << "\",\"stream\":\"" << dsrt::name(plan.stream) << "\""
               << (mp.lan() ? ",\"lan\":" + mp.lan()->json() : std::string()) << (lanUri.empty() ? std::string() : ",\"lan_code\":\"" + lc.code + "\",\"lan_join_uri\":\"" + lanUri + "\"")
               << ",\"video_frames\":" << av.videoFrames() << ",\"video_bytes\":" << av.videoBytes() << ",\"audio_packets\":" << av.audioPackets()
               << ",\"env_unhandled\":" << host.metrics.envUnhandled.load() << "," << dl.json() << "}";
            std::string s = js.str();
            link.send(L_STATUS, 0, s.data(), s.size());
            slowest = 0;
        }
        next += frameDur;
        auto now = Clock::now();
        if (next < now - std::chrono::milliseconds(200)) next = now;  // fell behind: do not try to catch up in a burst
        std::this_thread::sleep_until(next);
    }
    log("shutting down");
    mp.stop();
    av.flush();
    host.stop();
    log("stopped cleanly");
    return 0;
}
