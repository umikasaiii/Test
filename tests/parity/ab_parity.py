#!/usr/bin/env python3
"""A/B parity: RetroArch + melonDS DS (reference) vs DSLink Runtime + the same core, same ROM, same options, same inputs.
usage: ab_parity.py <dslink-runtime> <core.so> <retroarch-x11> <rom.nds> <dslink_cfgtool>
needs: Xvfb :151 with a 512x768 screen (`Xvfb :151 -screen 0 512x768x24`), xdotool, ffmpeg and PulseAudio with a null sink named parity_ra (RetroArch's audio is recorded from it)."""
import os, re, signal, subprocess, sys, tempfile, time
from rtlib import *

rt_bin, core, ra_bin, rom, cfgtool = sys.argv[1:6]
t = T()
work = tempfile.mkdtemp(prefix="parity_")
dev = "aaaa0000000000000000000000000000"
tool = lambda what, role="host", content=rom: subprocess.check_output([cfgtool, role, work, core, content, "-", "56330", "Alice", dev, what], text=True)
nick, mac = tool("nick").strip(), tool("mac").strip()
opts_text = tool("opts")
env = dict(os.environ, XDG_RUNTIME_DIR="/tmp/dslink-parity-xdg", DISPLAY=":151")
os.makedirs(env["XDG_RUNTIME_DIR"], exist_ok=True)
sh = lambda *a, **k: subprocess.run(a, env=env, **k)


def norm_log(text):
    """core log lines, minus paths/addresses, for set comparison"""
    out = set()
    for l in text.splitlines():
        m = re.search(r"\[(?:libretro|core) (?:INFO|WARN|ERROR)\] (.*)", l)
        if not m: continue
        s = re.sub(r'"[^"]*"', '"<p>"', m.group(1))
        s = re.sub(r"0x[0-9a-f]+", "0x#", s)
        s = re.sub(r"\d+", "#", s)
        if any(k in s for k in ("Frontend", "Layout", "message", "Wi-fi", "WFC", "wfcsettings", "PCap", "VFS", "Microphone", "interface")): continue
        out.add(s.strip())
    return out


# ============================ A: RetroArch ============================
sh("pulseaudio", "--start", "--exit-idle-time=-1", "--disallow-exit", capture_output=True)
sh("pactl", "load-module", "module-null-sink", "sink_name=parity_ra", capture_output=True)
xv = subprocess.Popen(["Xvfb", ":151", "-screen", "0", "512x768x24", "-nolisten", "tcp"], stderr=subprocess.DEVNULL)
time.sleep(1.5)
a = f"{work}/A"
for d in ("system/melonDS DS", "saves", "states", "config"): os.makedirs(f"{a}/{d}", exist_ok=True)
open(f"{a}/config/melondsds.opt", "w").write(opts_text)
open(f"{a}/ra.cfg", "w").write(subprocess.check_output([cfgtool, "host", a, core, rom, "-", "56330", "Alice", dev, "cfg"], text=True) + '''video_driver = "gl"
audio_driver = "pulse"
input_driver = "x"
video_fullscreen = "false"
video_scale = "2.0"
video_scale_integer = "true"
video_window_show_decorations = "false"
input_auto_mouse_grab = "false"
notification_show_when_menu_is_alive = "false"
video_font_enable = "false"
''')
renv = dict(env, PULSE_SINK="parity_ra", HOME=a)
ra = subprocess.Popen([ra_bin, "-v", "-c", f"{a}/ra.cfg", "-L", core, rom, "--nick", nick], cwd=a, env=renv, stdout=open(f"{a}/ra.log", "w"), stderr=subprocess.STDOUT)
time.sleep(9)


def grab():
    p = f"{a}/grab.ppm"
    sh("ffmpeg", "-hide_banner", "-loglevel", "error", "-draw_mouse", "0", "-f", "x11grab", "-video_size", "512x768", "-i", ":151", "-frames:v", "1", "-y", p, capture_output=True)
    img = Image(p)
    # RetroArch renders integer 2x: take every 2nd pixel -> 256x384 like the core frame
    img.data = b"".join(img.data[(y * 512 + x) * 3:(y * 512 + x) * 3 + 3] for y in range(0, 768, 2) for x in range(0, 512, 2))
    img.w, img.h = 256, 384
    return img


ra_img = grab()
sh("ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "pulse", "-i", "parity_ra.monitor", "-t", "1", "-ac", "2", "-ar", "32768", "-y", f"{a}/a.wav", capture_output=True)
ra_wav = Wav(f"{a}/a.wav")
sh("xdotool", "keydown", "x"); time.sleep(0.5); ra_a = grab().px(214, 74); sh("xdotool", "keyup", "x")
sh("xdotool", "keydown", "Up"); time.sleep(0.5); ra_up = grab().px(54, 50); sh("xdotool", "keyup", "Up")
wh = lambda r_, g, b: r_ > 230 and g > 230 and b > 230
ra_before = ra_img.count(wh, 0, 192)
sh("xdotool", "mousemove", "256", "576", "mousedown", "1"); time.sleep(0.8); ra_touch_img = grab(); sh("xdotool", "mouseup", "1")
ra.send_signal(signal.SIGTERM); ra_rc = ra.wait(15)
ra_log = open(f"{a}/ra.log").read()
ra_files = set(os.listdir(f"{a}/saves/melonDS DS")) if os.path.isdir(f"{a}/saves/melonDS DS") else set()

# no-content run under RetroArch
n = f"{work}/AN"
for d in ("system/melonDS DS", "saves", "states", "config"): os.makedirs(f"{n}/{d}", exist_ok=True)
open(f"{n}/config/melondsds.opt", "w").write(subprocess.check_output([cfgtool, "client", n, core, "-", "127.0.0.1", "56330", "Alice", dev, "opts"], text=True))
open(f"{n}/ra.cfg", "w").write(open(f"{a}/ra.cfg").read().replace(a, n).replace('netplay_ip_address', '#'))
ran = subprocess.Popen([ra_bin, "-v", "-c", f"{n}/ra.cfg", "-L", core, "--nick", nick], cwd=n, env=dict(renv, HOME=n), stdout=open(f"{n}/ra.log", "w"), stderr=subprocess.STDOUT)
time.sleep(7); ran.send_signal(signal.SIGTERM); ran.wait(15)
ra_nolog = open(f"{n}/ra.log").read()
xv.terminate()

# ============================ B: DSLink Runtime ============================
rt = Runtime(rt_bin, core, rom, f"{work}/B", name="B", username=nick, opts=f"{a}/config/melondsds.opt")
time.sleep(5)
rt_img = rt.snapshot()
rt_wav = rt.audio_dump(1.0)
rt.button(A, True); time.sleep(0.5); rt_a = rt.snapshot("a.ppm").px(214, 74); rt.button(A, False)
rt.button(UP, True); time.sleep(0.5); rt_up = rt.snapshot("u.ppm").px(54, 50); rt.button(UP, False)
rt.touch(0.5, 0.75, True); time.sleep(0.8); rt_touch_img = rt.snapshot("t.ppm"); rt.touch(0.5, 0.75, False)
rt_rc = rt.stop()
rt_log = rt.log()
rt_files = set(os.listdir(f"{work}/B/saves/melonDS DS")) if os.path.isdir(f"{work}/B/saves/melonDS DS") else set()
rn = Runtime(rt_bin, core, "", f"{work}/BN", name="BN", username=nick, opts=f"{n}/config/melondsds.opt")
time.sleep(5); rn_rc = rn.stop(); rn_log = rn.log()

# ============================ compare ============================
print(f"(RetroArch: {len(norm_log(ra_log))} distinct core log lines; DSLink Runtime: {len(norm_log(rt_log))})\n")
la, lb = norm_log(ra_log), norm_log(rt_log)
t.check("core initialization: every core INFO/WARN/ERROR line RetroArch got, the Runtime got too (loader/runtime-neutral)", la <= lb | {"melonDS DS #.#.#"} or not (la - lb), sorted(la - lb)[:3])
t.check("core initialization: Runtime adds no unexpected core errors", not [x for x in (lb - la) if "ERROR" in x or "failed" in x.lower()], sorted(lb - la)[:3])
t.check("ROM loading: same ROM-entry and boot lines from the core", all(k in ra_log and k in rt_log for k in ("ROM entry not found for gamecode", "Game is now booting")))
d_img = sum(abs(a1 - b1) for a1, b1 in zip(ra_img.data[:256 * 190 * 3], rt_img.data[:256 * 190 * 3])) / (256 * 190 * 3)
t.check("framebuffer (top screen, 256x190): mean |RetroArch - Runtime| < 1 level", d_img < 1.0, f"{d_img:.3f}")
t.check("framebuffer: bottom screen identical (white)", ra_img.px(100, 300) == rt_img.px(100, 300) == (255, 255, 255))
t.check("audio: same tone frequency (440 Hz)", abs(ra_wav.freq() - rt_wav.freq()) < 8 and abs(rt_wav.freq() - 440) < 10, f"RA {ra_wav.freq():.0f} / Runtime {rt_wav.freq():.0f}")
t.check("input: A and Up produce identical pixels", ra_a == rt_a and ra_up == rt_up, f"A {ra_a}/{rt_a} Up {ra_up}/{rt_up}")
def centroid(img):
    pts = [(x, y) for y in range(0, 192) for x in range(256) if wh(*img.px(x, y))]
    return (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts), len(pts)) if pts else (0, 0, 0)
ca, cb = centroid(ra_touch_img), centroid(rt_touch_img)
t.check("touch: same stylus position seen by the ARM7 (crosshair centroid within 3 px)", ca[2] > 15 and cb[2] > 15 and abs(ca[0] - cb[0]) < 3 and abs(ca[1] - cb[1]) < 3, f"RA {ca} / Runtime {cb}")
sysdir = lambda l: sorted(set(re.findall(r"system subdirectory: \"[^\"]*/(melonDS DS)\"", l)))
t.check("system directory: core resolved the same 'melonDS DS' subdirectory", sysdir(ra_log) == sysdir(rt_log) == ["melonDS DS"])
sz = lambda base, files: {f: os.path.getsize(f"{base}/saves/melonDS DS/{f}") for f in files}
t.check("save: same files and sizes written (8 KiB .srm from the core's SRAM; SD images are created lazily by the core)", ra_files == rt_files and sz(a, ra_files) == sz(f"{work}/B", rt_files), f"{sz(a, ra_files)} / {sz(f'{work}/B', rt_files)}")
t.check("boot without content: same core outcome (cannot boot DS menu without firmware)", "can't be used to boot to the DS menu" in ra_nolog and "can't be used to boot to the DS menu" in rn_log)
mra = re.search(r"MAC: ([0-9A-F:]{17})", ra_log); mrt = re.search(r"MAC: ([0-9A-F:]{17})", rt_log)
t.check("MAC/config: core derives the same MAC from the same identity", mra and mrt and mra.group(1) == mrt.group(1) == mac, f"{mra and mra.group(1)} / {mrt and mrt.group(1)} / dslink {mac}")
t.check("shutdown: both stop the emulated console and exit cleanly", "Stopping emulated console" in ra_log and "Stopping emulated console" in rt_log and ra_rc in (0, -15) and rt_rc == 0 and rn_rc == 0, f"RA rc={ra_rc} Runtime rc={rt_rc}/{rn_rc}")
sys.exit(t.done())
