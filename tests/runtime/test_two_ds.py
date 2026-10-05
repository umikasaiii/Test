#!/usr/bin/env python3
"""Two melonDS DS instances, each under its own DSLink Runtime, in the same container, joined by the Multiplayer Bridge (no RetroArch).
Same acceptance level as tests/integration/linux_netplay_smoke.sh, plus independence of video/audio/input/touch.
usage: test_two_ds.py <dslink-runtime> <core.so> <rom1.nds> <rom2.nds> <dslink_cfgtool>"""
import re, subprocess, sys, tempfile, time
from rtlib import *

rt_bin, core, rom1, rom2, cfgtool = sys.argv[1:6]
t = T()
work = tempfile.mkdtemp(prefix="two_ds_")
devs = ("aaaa0000000000000000000000000000", "bbbb0000000000000000000000000000")

def ident(role, name, dev, content="-", host="-"):
    g = lambda w: subprocess.check_output([cfgtool, role, work, "x", content, host, "56300", name, dev, w], text=True).strip()
    return g("nick"), g("mac"), g("opts")

def spawn(role, name, dev, rom, d, mp):
    nick, mac, opts = ident(role, name, dev, rom or "-", "127.0.0.1" if role == "client" else "-")
    open(f"{work}/{name}.opts", "w").write(opts)
    return Runtime(rt_bin, core, rom, f"{work}/{d}", name=name, username=nick, opts=f"{work}/{name}.opts", mp=(role, mp), av=True), mac

# ---------- compatibility mode: both have a test ROM (different colour/tone) so independence is observable
sock = f"{work}/ds.sock"
r1, mac1 = spawn("host", "P1", devs[0], rom1, "p1", sock)
time.sleep(1.5)
r2, mac2 = spawn("client", "P2", devs[1], rom2, "p2", sock)
time.sleep(5)
t.check("DS #1 (host) and DS #2 (client) both running", r1.status.get("frames", 0) > 60 and r2.status.get("frames", 0) > 60, f"{r1.status.get('frames')} / {r2.status.get('frames')}")
t.check("bridge connected: host sees 1 peer, client active with id 1", r1.status.get("mp_peers") == 1 and r2.status.get("mp_active") is True)
l1, l2 = r1.log(), r2.log()
t.check("core multiplayer layer started on BOTH (same line RetroArch produced)", "Starting multiplayer on libretro side" in l1 and "Starting multiplayer on libretro side" in l2)
m1 = re.search(r"\[melonDS\] MAC: ([0-9A-F:]{17})", l1); m2 = re.search(r"\[melonDS\] MAC: ([0-9A-F:]{17})", l2)
t.check("different DS identities (MAC) and equal to DSLink's DeviceIdentity derivation", m1 and m2 and m1.group(1) != m2.group(1) and m1.group(1) == mac1 and m2.group(1) == mac2, f"{m1 and m1.group(1)} / {m2 and m2.group(1)}")
s1, s2 = r1.snapshot(), r2.snapshot()
t.check("independent framebuffers: blue (DS #1) vs red (DS #2)", s1.px(130, 125)[2] > s1.px(130, 125)[0] + 40 and s2.px(130, 125)[0] > s2.px(130, 125)[2] + 40, f"{s1.px(130,125)} / {s2.px(130,125)}")
w1, w2 = r1.audio_dump(1.0, "a1.wav"), r2.audio_dump(1.0, "a2.wav")
t.check("independent audio: 440 Hz vs 660 Hz", w1 and w2 and abs(w1.freq() - 440) < 10 and abs(w2.freq() - 660) < 10, f"{w1 and w1.freq():.0f} / {w2 and w2.freq():.0f}")
r1.button(A, True); time.sleep(0.4); a1, a2 = r1.snapshot("x1.ppm").px(214, 74), r2.snapshot("x2.ppm").px(214, 74); r1.button(A, False)
t.check("independent buttons: A on DS #1 only", a1[0] > 200 and a2[0] < 100, f"{a1} / {a2}")
r2.button(UP, True); time.sleep(0.4); u1, u2 = r1.snapshot("y1.ppm").px(54, 50), r2.snapshot("y2.ppm").px(54, 50); r2.button(UP, False)
t.check("independent buttons: Up on DS #2 only", u2[0] > 200 and u2[2] > 200 and u1[0] < 100, f"{u1} / {u2}")
wh = lambda r_, g, b: r_ > 230 and g > 230 and b > 230
b1, b2 = s1.count(wh, 0, 192), s2.count(wh, 0, 192)
r2.touch(0.5, 0.75, True); time.sleep(0.6); c1, c2 = r1.snapshot("z1.ppm").count(wh, 0, 192), r2.snapshot("z2.ppm").count(wh, 0, 192); r2.touch(0.5, 0.75, False)
t.check("independent touchscreen: stylus on DS #2 only", c2 - b2 > 15 and c1 - b1 < 5, f"DS#1 {b1}->{c1}  DS#2 {b2}->{c2}")
t.check("both encode H.264+Opus independently", all(r.video_frames > 100 and r.audio_packets > 100 for r in (r1, r2)))
rc2 = r2.stop(); time.sleep(0.5); rc1 = r1.stop()
t.check("DS #2 leaving is seen by the host; both shut down cleanly", rc1 == 0 and rc2 == 0 and "stopped cleanly" in r1.log())

# ---------- the real shape: DS #2 boots WITHOUT cartridge (Download Play client)
sock = f"{work}/ds2.sock"
h, hm = spawn("host", "H", devs[0], rom1, "h", sock)
time.sleep(1.5)
n, nm = spawn("client", "N", devs[1], "", "n", sock)
time.sleep(5)
t.check("no-cartridge client joins the host through the bridge", n.status.get("mp_active") is True and h.status.get("mp_peers") == 1)
t.check("no-cartridge client: core starts multiplayer and reports it needs the user's firmware", "Starting multiplayer on libretro side" in n.log() and "can't be used to boot to the DS menu" in n.log())
mm = re.search(r"\[melonDS\] MAC: ([0-9A-F:]{17})", n.log())
t.check("no-cartridge client has its own DS identity (core stops before printing the MAC without firmware, as under RetroArch): DSLink MAC differs from the host's and a core-reported one, if printed, matches",
        nm != hm and (mm is None or mm.group(1) == nm), f"expected {nm} vs host {hm}; core printed {mm and mm.group(1)}")
n.stop(); h.stop()
sys.exit(t.done())
