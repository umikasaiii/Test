#!/usr/bin/env python3
"""The Android data path on the desktop: dslink-runtime built WITHOUT FFmpeg, started with --shm and no control link; shm_probe plays the front end
(what the JNI renderer / AAudio / input code does on the phone): raw frames, audio ring, buttons, touch, pause, quit.
usage: test_shm_frontend.py <runtime-noffmpeg> <core.so> <shm_probe> <test_rom.nds>"""
import json, os, shutil, subprocess, sys, tempfile, time

rt, core, probe, rom = sys.argv[1:5]
d = tempfile.mkdtemp(prefix="dsshm_")
os.makedirs(f"{d}/sys"); os.makedirs(f"{d}/sav")
shm = f"{d}/av.shm"
res = []
def check(name, ok, detail=""):
    res.append(bool(ok)); print(("PASS  " if ok else "FAIL  ") + name + (f"  -> {detail}" if detail else ""), flush=True)

def ppm(path):
    b = open(path, "rb").read(); i = b.index(b"255\n") + 4
    w, h = [int(x) for x in b[:i].split()[1:3]]
    return w, h, b[i:]
def px(im, x, y): w, _, b = im; o = (y * w + x) * 3; return tuple(b[o:o + 3])
def run_probe(secs, *opts):
    out = subprocess.run([probe, shm, str(secs), *opts], capture_output=True, text=True, timeout=60).stdout.strip().splitlines()
    return json.loads(out[-1]) if out else {"ok": False}

p = subprocess.Popen([rt, "--core", core, "--system", f"{d}/sys", "--save", f"{d}/sav", "--content", rom, "--shm", shm, "--log", f"{d}/rt.log"],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
try:
    r = run_probe(3, "--dump-ppm", f"{d}/base.ppm")
    check("front end maps the file the Runtime created (magic/version ok)", r.get("ok"), r)
    check("video: 256x384 frames arrive at ~60 fps with no encoder and no control link", r.get("ok") and (r["w"], r["h"]) == (256, 384) and r["fps"] > 50, f"{r.get('w')}x{r.get('h')} {r.get('fps')} fps")
    check("video: frames change over time (not a frozen buffer)", r.get("distinct", 0) > 5, r.get("distinct"))
    im = ppm(f"{d}/base.ppm")
    bg = px(im, 130, 125)
    check("video: top screen is the ROM's blue, bottom the DS white (XRGB8888 channel order right)", bg[2] > bg[0] + 40 and px(im, 100, 300) == (255, 255, 255), (bg, px(im, 100, 300)))
    check("audio: the ring carries the core's stereo samples at its native rate (~32.7 kHz)", r.get("audio_frames", 0) > 80000 and 30000 < r.get("sample_rate", 0) < 36000, f"{r.get('audio_frames')} frames @ {r.get('sample_rate')}")
    check("audio: the reader never fell behind by a whole ring (no runaway)", r.get("audio_overruns") == 0, r.get("audio_overruns"))
    r = run_probe(1.5, "--press-a", "--dump-ppm", f"{d}/a.ppm")
    c = px(ppm(f"{d}/a.ppm"), 214, 74)
    check("input: a button written into shared memory reaches the core (A square lit)", c[0] > 200 and c[1] < 120, c)
    r = run_probe(1.5, "--touch", "0.5", "0.75", "--dump-ppm", f"{d}/t.ppm")
    white = lambda im: sum(1 for i in range(0, 256 * 192 * 3, 3) if im[2][i] > 230 and im[2][i + 1] > 230 and im[2][i + 2] > 230)
    before, after = white(ppm(f"{d}/base.ppm")), white(ppm(f"{d}/t.ppm"))
    check("touch: a touch written into shared memory is read by the ARM7 touch panel (crosshair on the top screen)", after - before > 15, f"white px {before} -> {after}")
    r = run_probe(6, "--pause-test")
    check("pause: with paused=1 the emulator stops publishing frames, and resumes afterwards", r.get("paused_fps", 9) < 1 and r.get("fps", 0) > 10, f"paused {r.get('paused_fps')} fps")
    r = run_probe(1, "--quit")
    time.sleep(2.5)
    check("quit: quit=1 shuts the Runtime down in an orderly way (exit code 0)", p.poll() == 0, p.poll())
    log = open(f"{d}/rt.log").read()
    check("no FFmpeg, no link: the Runtime says nothing about an encoder and stops cleanly", "stopped cleanly" in log and "FATAL" not in log)
finally:
    if p.poll() is None: p.kill()
    shutil.rmtree(d, ignore_errors=True)
print(f"{sum(res)}/{len(res)} checks passed")
sys.exit(0 if all(res) else 1)
