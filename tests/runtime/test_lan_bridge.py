#!/usr/bin/env python3
"""DISTRIBUTED MODE, TEST A: two DSLink Runtimes (two processes, two melonDS instances) exchange REAL DS wireless frames EXCLUSIVELY through the
LAN RadioTransport (DSLink Radio Protocol over UDP, discovery + authenticated join) - no Unix socket between them, nothing else crosses.
Same homebrew radio test as test_wifi_bridge.py, plus protocol-level checks, impairment, disconnect and reconnect.
usage: test_lan_bridge.py <dslink-runtime> <core.so> <rom1.nds> <rom2.nds> <dslink_cfgtool> [--quick]"""
import glob, os, subprocess, sys, tempfile, time
from rtlib import *

rt_bin, core, rom1, rom2, cfgtool = sys.argv[1:6]
t = T()
work = tempfile.mkdtemp(prefix="lan_bridge_")
devs = ("aaaa0000000000000000000000000000", "bbbb0000000000000000000000000000")
DISC = 47700 + os.getpid() % 200       # private discovery port: tests never see each other's hosts
CODE = "482731"


def spawn(role, name, dev, rom, d, impair="", grace=0):
    g = lambda w: subprocess.check_output([cfgtool, role, work, "x", rom or "-", "127.0.0.1" if role == "client" else "-", "56300", name, dev, w], text=True).strip()
    open(f"{work}/{name}.opts", "w").write(g("opts"))
    extra = ["--session-mode", "distributed", "--lan-role", "host" if role == "host" else "guest", "--lan-code", CODE, "--lan-discovery-port", str(DISC),
             "--lan-discovery-addr", "127.0.0.1", "--lan-bind", "127.0.0.1", "--lan-name", name]
    if impair: extra += ["--lan-impair", impair]
    if grace: extra += ["--mp-peer-grace-ms", str(grace)]
    return Runtime(rt_bin, core, rom, f"{work}/{d}", name=name, username=g("nick"), opts=f"{work}/{name}.opts", av=True, extra=extra)


def bars(im):
    yellow = lambda p: p[0] > 200 and p[1] > 200 and p[2] < 120
    cyan = lambda p: p[0] < 120 and p[1] > 200 and p[2] > 200
    return dict(tx=yellow(im.px(4, 171)), rx=cyan(im.px(4, 177)), sq=im.px(242, 176), nowifi=im.px(10, 165))


def frames_in(r):
    im = r.snapshot("len.ppm")
    n = 0
    while n < 60 and im.px(n * 4 + 1, 177)[0] < 120 and im.px(n * 4 + 1, 177)[1] > 200: n += 1
    return n


r1 = spawn("host", "P1", devs[0], rom1, "p1", os.environ.get("LAN_IMPAIR", ""))
time.sleep(1.5)
r2 = spawn("client", "P2", devs[1], rom2, "p2", os.environ.get("LAN_IMPAIR", ""))
time.sleep(9)
b1, b2 = bars(r1.snapshot("a.ppm")), bars(r2.snapshot("b.ppm"))
s1, s2 = r1.status, r2.status
t.check("two distinct Runtime processes, session mode DISTRIBUTED, radio transport LAN, no game stream transport", s1.get("session_mode") == "distributed" and s1.get("radio") == "lan" and s2.get("radio") == "lan" and s1.get("stream") == "none", f"{s1.get('session_mode')}/{s1.get('radio')}/{s1.get('stream')}")
t.check("NO Unix-socket bridge exists between them (the old internal path is not used)", not glob.glob(f"{work}/**/*.sock", recursive=True) or all(os.path.basename(p) == "link.sock" for p in glob.glob(f"{work}/**/*.sock", recursive=True)), str(glob.glob(f"{work}/**/*.sock", recursive=True)))
t.check("guest found the host by discovery (room code) and joined; host sees 1 peer", s1.get("mp_peers") == 1 and s2.get("mp_active") is True and s1.get("lan", {}).get("peers") == 1, f"peers={s1.get('mp_peers')}")
t.check("DS Wi-Fi hardware powers up on both consoles", b1["nowifi"][0] < 60 and b2["nowifi"][1] < 60)
t.check("both consoles transmit 802.11 frames", b1["tx"] and b2["tx"])
t.check("DS #1 and DS #2 each receive the OTHER console's frames over the LAN bridge", b1["rx"] and b2["rx"] and b1["sq"][0] > 200 and b1["sq"][2] < 100 and b2["sq"][2] > 200 and b2["sq"][0] < 100, f"{b1['sq']} / {b2['sq']}")
l1, l2 = s1.get("lan", {}), s2.get("lan", {})
t.check("bridge counters: datagrams flowed both ways, authenticated (no bad-auth/format)", l1.get("rx", 0) > 20 and l2.get("rx", 0) > 20 and l1.get("tx", 0) > 20 and l1.get("bad_auth", 1) == 0 and l2.get("bad_auth", 1) == 0 and l1.get("bad_format", 1) == 0, f"host rx/tx {l1.get('rx')}/{l1.get('tx')} guest {l2.get('rx')}/{l2.get('tx')}")
t.check("RTT measured by the protocol", l1.get("rtt_ms", -1) >= 0 and l2.get("rtt_ms", -1) >= 0 and l2.get("rtt_ms", 99) < 30, f"host {l1.get('rtt_ms')} ms guest {l2.get('rtt_ms')} ms (impair={os.environ.get('LAN_IMPAIR', 'none')})")
d1, d2 = s1.get("dl_counters", {}), s2.get("dl_counters", {})
t.check("Download Play diagnostics see the real traffic in both directions", s1.get("dl_state") == "RADIO_ON" and s2.get("dl_state") == "RADIO_ON" and all(d.get("data_tx", 0) > 2 and d.get("data_rx", 0) > 2 for d in (d1, d2)), f"{s1.get('dl_state')}/{s2.get('dl_state')}")
n1a, n2a = frames_in(r1), frames_in(r2); time.sleep(4); n1b, n2b = frames_in(r1), frames_in(r2)
t.check("traffic keeps flowing (received-frame counters keep increasing)", n1b > n1a and n2b > n2a, f"#1 {n1a}->{n1b} #2 {n2a}->{n2b}")
s1, s2 = r1.status, r2.status
print("LAN stats host :", s1.get("lan")); print("LAN stats guest:", s2.get("lan"))

if "--quick" not in sys.argv:
    # ---- TEST E: disconnect / reconnect. 1) graceful (BYE) 2) crash (SIGKILL, host times out) - then a NEW guest process joins and frames flow again
    r2.stop(); time.sleep(1.0)
    t.check("graceful guest exit (BYE): the host drops the peer at once and keeps running", r1.status.get("mp_peers") == 0 and r1.proc.poll() is None, f"peers={r1.status.get('mp_peers')}")
    r2 = spawn("client", "P2b", devs[1], rom2, "p2b"); time.sleep(8)
    sb1, sb2 = bars(r1.snapshot("c.ppm")), bars(r2.snapshot("d.ppm"))
    t.check("reconnect: a fresh guest process discovers the host again, joins (id re-used) and frames flow both ways", r1.status.get("mp_peers") == 1 and sb1["rx"] and sb2["rx"], f"peers={r1.status.get('mp_peers')}")
    r2.kill(); time.sleep(6)
    t.check("guest crash (SIGKILL, no BYE): the host notices by timeout and stays alive", r1.status.get("mp_peers") == 0 and r1.proc.poll() is None, f"peers={r1.status.get('mp_peers')}")
    r2 = spawn("client", "P2c", devs[1], rom2, "p2c"); time.sleep(8)
    t.check("reconnect after a crash works too", r1.status.get("mp_peers") == 1 and bars(r2.snapshot("e.ppm"))["rx"])
    r1c = r1
    r1.kill(); time.sleep(6)
    t.check("host crash: the guest's core is told the session ended and the guest process stays alive", r2.proc.poll() is None and r2.status.get("mp_active") is False, f"active={r2.status.get('mp_active')}")
    r2.stop()
    # ---- peer-loss policy: after the grace window with no peer the host ends the multiplayer session cleanly (core stop, sockets closed)
    r1 = spawn("host", "G1", devs[0], rom1, "g1", grace=3000); time.sleep(1.5)
    r2 = spawn("client", "G2", devs[1], rom2, "g2"); time.sleep(8)
    t.check("grace policy: session established (host sees 1 peer)", r1.status.get("mp_peers") == 1 and r1.status.get("mp_ended") is None)
    r2.kill(); time.sleep(3.5)
    t.check("grace policy: shortly after the peer vanished the session is still held (inside the window / timeout)", r1.status.get("mp_ended") is None or r1.status.get("mp_ended") == "peer_lost")
    time.sleep(6)
    st = r1.status
    t.check("grace policy: after the grace window the host ended the multiplayer session by itself and keeps running", st.get("mp_ended") == "peer_lost" and st.get("mp_role") == "none" and r1.proc.poll() is None, f"ended={st.get('mp_ended')} role={st.get('mp_role')}")
    r1.stop()
else:
    r2.stop(); time.sleep(0.5); r1.stop()
sys.exit(t.done())
