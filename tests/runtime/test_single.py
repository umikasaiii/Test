#!/usr/bin/env python3
"""melonDS DS directly under DSLink Runtime (no RetroArch): boot, video, audio, input, touch, save, firmware, no-cartridge, MAC, shutdown.
usage: test_single.py <dslink-runtime> <core.so> <rom1.nds> <dslink_cfgtool>"""
import re, subprocess, sys, tempfile, time
from rtlib import *

rt_bin, core, rom, cfgtool = sys.argv[1:5]
t = T()
work = tempfile.mkdtemp(prefix="rt_single_")
dev = "aaaa0000000000000000000000000000"
nick = subprocess.check_output([cfgtool, "host", work, "x", "-", "-", "56300", "Alice", dev, "nick"], text=True).strip()
mac = subprocess.check_output([cfgtool, "host", work, "x", "-", "-", "56300", "Alice", dev, "mac"], text=True).strip()
opts = f"{work}/opts.cfg"
open(opts, "w").write(subprocess.check_output([cfgtool, "host", work, "x", rom, "-", "56300", "Alice", dev, "opts"], text=True))

r = Runtime(rt_bin, core, rom, work + "/a", name="A", username=nick, opts=opts, av=True)
time.sleep(4)
t.check("core loaded and ROM booted under DSLink Runtime", r.status.get("frames", 0) > 60, f"frames={r.status.get('frames')}")
t.check("emulation runs at ~60 fps (pacing)", 55 <= r.status.get("fps", 0) <= 65, f"{r.status.get('fps')}")
img = r.snapshot()
t.check("framebuffer is the core's 256x384 (two stacked DS screens)", img and (img.w, img.h) == (256, 384), f"{img and (img.w, img.h)}")
bg = img.px(130, 125)
t.check("video: top screen shows the ROM's blue background", bg[2] > bg[0] + 40, bg)
t.check("video: bottom screen is the DS's white", img.px(100, 300) == (255, 255, 255), img.px(100, 300))
wav = r.audio_dump(1.0)
t.check("audio: 440 Hz tone from the ROM's ARM7", wav and abs(wav.freq() - 440) < 10 and wav.rms() > 1000, wav and f"{wav.freq():.0f} Hz rms {wav.rms():.0f}")
r.button(A, True); time.sleep(0.4)
i2 = r.snapshot("a.ppm")
c = i2.px(214, 74)
t.check("input: RetroPad A reaches the core (A square lit)", c[0] > 200 and c[1] < 120, c)
r.button(A, False); r.button(UP, True); time.sleep(0.4)
i3 = r.snapshot("u.ppm")
c = i3.px(54, 50)
t.check("input: D-pad Up reaches the core", c[0] > 200 and c[2] > 200, c)
r.button(UP, False)
before = img.count(lambda r_, g, b: r_ > 230 and g > 230 and b > 230, 0, 192)
r.touch(0.5, 0.75, True); time.sleep(0.6)
i4 = r.snapshot("t.ppm")
after = i4.count(lambda r_, g, b: r_ > 230 and g > 230 and b > 230, 0, 192)
t.check("touch: pointer on the bottom screen is read by the ARM7 touch panel (crosshair on top screen)", after - before > 15, f"white px {before} -> {after}")
r.touch(0.5, 0.75, False)
log = r.log()
m = re.search(r"\[melonDS\] MAC: ([0-9A-F:]{17})", log)
t.check("MAC derived by the core from the DSLink identity == DSLink's derivation", m and m.group(1) == mac, f"{m and m.group(1)} vs {mac}")
t.check("H.264 + Opus encoded in-process (no screen capture): keyframes and audio packets on the link", r.video_frames > 100 and r.video_keys >= 3 and r.audio_packets > 100, f"v={r.video_frames} keys={r.video_keys} a={r.audio_packets}")
t.check("system/save directories honoured by the core", f"{work}/a/system/melonDS DS" in log and f"{work}/a/saves" in log)
r.send(L_SAVE)
rc = r.stop()
t.check("clean shutdown (exit 0, core unloaded, deinit)", rc == 0 and "stopped cleanly" in r.log() and "retro_deinit" in r.log(), f"rc={rc}")

# boot without content (Download-Play-client style): the core runs and reports it needs bootable firmware (none supplied here)
n = Runtime(rt_bin, core, "", work + "/n", name="N", username=nick, opts=opts)
time.sleep(4)
t.check("boot WITHOUT content is accepted by the core (support_no_game)", n.status.get("frames", 0) > 30, f"frames={n.status.get('frames')}")
t.check("without firmware the core reports it cannot boot the DS menu (same as RetroArch)", "can't be used to boot to the DS menu" in n.log())
n.stop()
sys.exit(t.done())
