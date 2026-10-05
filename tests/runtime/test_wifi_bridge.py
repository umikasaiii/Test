#!/usr/bin/env python3
"""REAL DS wireless traffic over the DSLink Multiplayer Bridge (no RetroArch).
The homebrew test ROMs drive the DS Wi-Fi hardware from ARM7 (power-up, channel 1, 802.11 data frames); melonDS emulates the radio and
hands every transmitted frame to the libretro netpacket interface, which the Runtime's bridge carries to the other instance, where
melonDS's receiver delivers it to the other ARM7. Both consoles report it on their top screen: yellow bar = frames sent, cyan bar =
frames received from the OTHER console, square colour = sender id (blue = console 1, red = console 2).
usage: test_wifi_bridge.py <dslink-runtime> <core.so> <rom1.nds> <rom2.nds> <dslink_cfgtool>"""
import subprocess, sys, tempfile, time
from rtlib import *

rt_bin, core, rom1, rom2, cfgtool = sys.argv[1:6]
t = T()
work = tempfile.mkdtemp(prefix="wifi_bridge_")
devs = ("aaaa0000000000000000000000000000", "bbbb0000000000000000000000000000")


def spawn(role, name, dev, rom, d, mp):
    g = lambda w: subprocess.check_output([cfgtool, role, work, "x", rom or "-", "127.0.0.1" if role == "client" else "-", "56300", name, dev, w], text=True).strip()
    open(f"{work}/{name}.opts", "w").write(g("opts"))
    return Runtime(rt_bin, core, rom, f"{work}/{d}", name=name, username=g("nick"), opts=f"{work}/{name}.opts", mp=(role, mp), av=True)


def bars(im):
    yellow = lambda p: p[0] > 200 and p[1] > 200 and p[2] < 120
    cyan = lambda p: p[0] < 120 and p[1] > 200 and p[2] > 200
    return dict(tx=yellow(im.px(4, 171)), rx=cyan(im.px(4, 177)), sq=im.px(242, 176), nowifi=im.px(10, 165))


def frames_in(r):  # RX bar length in DS pixels / 4 = frames received (capped at 60)
    im = r.snapshot("len.ppm")
    n = 0
    while n < 60 and im.px(n * 4 + 1, 177)[0] < 120 and im.px(n * 4 + 1, 177)[1] > 200:
        n += 1
    return n


# ---------- two consoles, bridged
sock = f"{work}/ds.sock"
r1 = spawn("host", "P1", devs[0], rom1, "p1", sock)
time.sleep(1.5)
r2 = spawn("client", "P2", devs[1], rom2, "p2", sock)
time.sleep(9)
b1, b2 = bars(r1.snapshot("a.ppm")), bars(r2.snapshot("b.ppm"))
t.check("DS Wi-Fi hardware powers up on both consoles (ARM7 init sequence accepted by the emulated radio)", b1["nowifi"][0] < 60 and b2["nowifi"][1] < 60, f"{b1['nowifi']} / {b2['nowifi']}")
t.check("both consoles transmit 802.11 frames (yellow bar)", b1["tx"] and b2["tx"])
t.check("DS #1 receives frames over the bridge (cyan bar)", b1["rx"])
t.check("DS #2 receives frames over the bridge (cyan bar)", b2["rx"])
t.check("each console received the OTHER console's frames (sender id: #1 sees red/2, #2 sees blue/1)",
        b1["sq"][0] > 200 and b1["sq"][2] < 100 and b2["sq"][2] > 200 and b2["sq"][0] < 100, f"{b1['sq']} / {b2['sq']}")
s1, s2 = r1.status, r2.status
t.check("bridge counters: frames flowed both ways", all(s.get("mp_in", 0) >= 3 and s.get("mp_out", 0) >= 3 for s in (s1, s2)), f"P1 in/out {s1.get('mp_in')}/{s1.get('mp_out')}  P2 in/out {s2.get('mp_in')}/{s2.get('mp_out')}")
n1a, n2a = frames_in(r1), frames_in(r2)
time.sleep(4)
n1b, n2b = frames_in(r1), frames_in(r2)
t.check("traffic keeps flowing (received-frame counters keep increasing)", n1b > n1a and n2b > n2a, f"#1 {n1a}->{n1b}  #2 {n2a}->{n2b}")
r2.stop(); time.sleep(0.5); r1.stop()

# ---------- control: a console alone never receives anything (no self-echo, nothing invented by the bridge)
sock = f"{work}/solo.sock"
solo = spawn("host", "S", devs[0], rom1, "s", sock)
time.sleep(8)
bs = bars(solo.snapshot("solo.ppm"))
t.check("control: a lone console transmits but receives nothing", bs["tx"] and not bs["rx"], f"tx={bs['tx']} rx={bs['rx']}")
solo.stop()

# ---------- isolation: leaving the session stops the traffic on the remaining console
sock = f"{work}/leave.sock"
a = spawn("host", "A", devs[0], rom1, "la", sock); time.sleep(1.5)
b = spawn("client", "B", devs[1], rom2, "lb", sock); time.sleep(7)
got = frames_in(a)
b.stop(); time.sleep(1.0)
x = frames_in(a); time.sleep(4); y = frames_in(a)
t.check("after the other console leaves, the remaining console stops receiving", got > 0 and y == x, f"{got} -> {x} -> {y}")
a.stop()
sys.exit(t.done())
