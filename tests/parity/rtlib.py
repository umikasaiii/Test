"""Test harness for dslink-runtime: spawns it, speaks the control-link protocol (runtime/src/link.hpp), reads PPM/WAV dumps."""
import json, math, os, socket, struct, subprocess, tempfile, threading, time, wave

L_VIDEO, L_AUDIO, L_LOG, L_STATUS = 1, 2, 3, 4
L_BUTTON, L_TOUCH, L_SNAPSHOT, L_QUIT, L_KEYFRAME, L_AUDIO_DUMP, L_SAVE = 10, 11, 12, 13, 14, 15, 16
# libretro RetroPad ids
B, Y, SELECT, START, UP, DOWN, LEFT, RIGHT, A, X, L, R = range(12)


class Runtime:
    def __init__(self, bin, core, content, workdir, name="rt", username="", opts="", mp=None, av=False, extra=()):
        self.dir = workdir
        os.makedirs(f"{workdir}/system/melonDS DS", exist_ok=True)
        os.makedirs(f"{workdir}/saves", exist_ok=True)
        self.sock = f"{workdir}/link.sock"
        self.logfile = f"{workdir}/runtime.log"
        cmd = [bin, "--core", core, "--system", f"{workdir}/system", "--save", f"{workdir}/saves", "--link", self.sock,
               "--name", name, "--log", self.logfile]
        if content: cmd += ["--content", content]
        if opts: cmd += ["--options", opts]
        if username: cmd += ["--username", username]
        if av: cmd += ["--av", "on"]
        if mp: cmd += ["--mp-role", mp[0], "--mp-path", mp[1]]
        cmd += list(extra)
        self.proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.status = {}
        self.video_frames = 0; self.video_keys = 0; self.audio_packets = 0; self.video_bytes = 0
        self.s = None
        for _ in range(100):
            if os.path.exists(self.sock):
                try:
                    self.s = socket.socket(socket.AF_UNIX); self.s.connect(self.sock); break
                except OSError: self.s.close(); self.s = None
            if self.proc.poll() is not None: break
            time.sleep(0.1)
        self._rx = threading.Thread(target=self._reader, daemon=True)
        if self.s: self._rx.start()

    def _reader(self):
        buf = b""
        while True:
            try: d = self.s.recv(65536)
            except OSError: return
            if not d: return
            buf += d
            while len(buf) >= 8:
                t, fl, _, n = struct.unpack_from("<BBHI", buf)
                if len(buf) < 8 + n: break
                p = buf[8:8 + n]; buf = buf[8 + n:]
                if t == L_STATUS:
                    try: self.status = json.loads(p)
                    except ValueError: pass
                elif t == L_VIDEO:
                    self.video_frames += 1; self.video_bytes += n; self.video_keys += fl & 1
                elif t == L_AUDIO: self.audio_packets += 1

    def send(self, t, payload=b""):
        self.s.sendall(struct.pack("<BBHI", t, 0, 0, len(payload)) + payload)

    def button(self, id, down, port=0): self.send(L_BUTTON, bytes([port, id, 1 if down else 0]))
    def touch(self, x, y, down): self.send(L_TOUCH, struct.pack("<ffB", x, y, 1 if down else 0))
    def keyframe(self): self.send(L_KEYFRAME)

    def snapshot(self, name="snap.ppm"):
        path = f"{self.dir}/{name}"
        if os.path.exists(path): os.remove(path)
        self.send(L_SNAPSHOT, path.encode())
        for _ in range(50):
            time.sleep(0.1)
            if os.path.exists(path) and os.path.getsize(path) > 100:
                time.sleep(0.05); return Image(path)
        return None

    def audio_dump(self, seconds=1.0, name="a.wav"):
        path = f"{self.dir}/{name}"
        if os.path.exists(path): os.remove(path)
        self.send(L_AUDIO_DUMP, struct.pack("<f", seconds) + path.encode())
        for _ in range(100):
            time.sleep(0.1)
            if os.path.exists(path) and os.path.getsize(path) > 44: time.sleep(0.1); return Wav(path)
        return None

    def log(self):
        try: return open(self.logfile).read()
        except OSError: return ""

    def stop(self, timeout=10):
        try:
            if self.s: self.send(L_QUIT)
        except OSError: pass
        try: self.proc.wait(timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill(); return -9
        return self.proc.returncode

    def kill(self):
        if self.proc.poll() is None: self.proc.kill()


class Image:
    def __init__(self, path):
        d = open(path, "rb").read()
        parts = d.split(b"\n", 3)
        self.w, self.h = map(int, parts[1].split())
        self.data = parts[3]

    def px(self, x, y):
        i = (y * self.w + x) * 3
        return tuple(self.data[i:i + 3])

    def count(self, pred, y0=0, y1=None):
        n = 0
        for y in range(y0, y1 or self.h):
            row = self.data[y * self.w * 3:(y + 1) * self.w * 3]
            for x in range(self.w):
                if pred(row[3 * x], row[3 * x + 1], row[3 * x + 2]): n += 1
        return n


class Wav:
    def __init__(self, path):
        w = wave.open(path)
        self.rate = w.getframerate(); n = w.getnframes()
        raw = w.readframes(n)
        self.samples = struct.unpack("<%dh" % (len(raw) // 2), raw)[::2]  # left channel

    def rms(self): return math.sqrt(sum(s * s for s in self.samples) / max(1, len(self.samples)))

    def freq(self):
        z = sum(1 for i in range(1, len(self.samples)) if self.samples[i - 1] < 0 <= self.samples[i])
        return z * self.rate / max(1, len(self.samples))


class T:
    def __init__(self): self.results = []
    def check(self, name, ok, detail=""):
        self.results.append((name, bool(ok)))
        print(("PASS  " if ok else "FAIL  ") + name + (("  -> " + str(detail)) if detail != "" else ""))
    def done(self):
        bad = [n for n, ok in self.results if not ok]
        print(f"\n{len(self.results) - len(bad)}/{len(self.results)} checks passed")
        return 1 if bad else 0
