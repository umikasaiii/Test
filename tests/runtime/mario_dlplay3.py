#!/usr/bin/env python3
"""REAL Mario Party DS Download Play with THREE DSLink Runtimes on one local bridge: the host runs the user's ROM, two clients have NO cartridge and boot the user's firmware.
PRIVATE: needs the user's files; never run in CI; writes only under the private directory (snapshots stay there).
usage: mario_dlplay3.py <runtime> <core.so> <cfgtool> <private-dir> [--shots]    (--shots: keep a snapshot of every console at every checkpoint, to look at them by eye)
private-dir: mario.nds, bios7.bin, bios9.bin, firmware.bin, mario_save/, out/refs.json (the screen references of the two-player flow)."""
import json, os, shutil, subprocess, sys, time
from rtlib import *

rt, core, cfgtool, priv = sys.argv[1:5]
SHOTS = "--shots" in sys.argv
out = os.path.join(priv, "out", "dl3"); shutil.rmtree(out, ignore_errors=True); os.makedirs(out)
work = os.path.join(out, "work"); os.makedirs(work)
sock = os.path.join(work, "mp.sock")
t = T(); T0 = time.time(); timeline = []
def mark(name, **kw): timeline.append((round(time.time() - T0, 1), name, kw)); print(f"[{timeline[-1][0]:7.1f}s] {name} {kw or ''}", flush=True)
DEV = {"host": "aaaa0000000000000000000000000000", "c1": "bbbb0000000000000000000000000000", "c2": "cccc0000000000000000000000000000"}

def spawn(who, name, rom):
    role = "host" if who == "host" else "client"
    d = os.path.join(work, who); os.makedirs(f"{d}/system/melonDS DS", exist_ok=True)
    for f in ("bios7.bin", "bios9.bin", "firmware.bin"): shutil.copy(os.path.join(priv, f), f"{d}/system/melonDS DS/{f}")
    if role == "host": shutil.copytree(os.path.join(priv, "mario_save"), f"{d}/saves", dirs_exist_ok=True)
    os.environ["DSLINK_MP_TRACE"] = os.path.join(out, f"trace_{who}.log")
    g = lambda w: subprocess.check_output([cfgtool, role, work, "x", rom or "-", "127.0.0.1" if role == "client" else "-", "56300", name, DEV[who], w], text=True).strip()
    open(f"{work}/{name}.opts", "w").write(g("opts"))
    return Runtime(rt, core, rom, d, name=name, username=g("nick"), opts=f"{work}/{name}.opts", mp=(role, sock), av=True)

def ahash(im, top):
    y0 = 0 if top else 192
    g = [sum(im.px(x, y)) // 3 for y in range(y0 + 6, y0 + 192, 12) for x in range(8, 256, 16)]
    avg = sum(g) / len(g)
    return "".join("1" if v > avg else "0" for v in g)
def dist(a, b): return sum(x != y for x, y in zip(a, b))
refs = json.load(open(os.path.join(priv, "out", "refs.json")))
def shot(r, name):
    im = r.snapshot(name + ".ppm")
    if im and SHOTS: shutil.copy(f"{r.dir}/{name}.ppm", os.path.join(out, name + ".ppm"))
    return im
def screen_is(r, name, which="both", tol=40):
    im = r.snapshot("tmp.ppm"); ref = refs[name]
    d = {"top": dist(ahash(im, True), ref["top"]), "bot": dist(ahash(im, False), ref["bot"])}
    return (d["top"] <= tol and d["bot"] <= tol) if which == "both" else d[which] <= tol
def wait_screen(r, name, secs, which="both", tol=40):
    end = time.time() + secs
    while time.time() < end:
        if screen_is(r, name, which, tol): return True
        time.sleep(1.0)
    return False
def dl(r): return r.status.get("dl_state")
def wait_state(r, states, secs):
    end = time.time() + secs
    while time.time() < end:
        if dl(r) in states: return True
        time.sleep(0.5)
    return False
def tap(r, x, y, hold=0.4, wait=1.5):
    r.touch(x, y, True); time.sleep(hold); r.touch(x, y, False); time.sleep(wait)
def press(r, b, hold=0.25, wait=1.0):
    r.button(b, True); time.sleep(hold); r.button(b, False); time.sleep(wait)
def goto(r, name, action, which="both", tries=6, wait=3.0, tol=40):
    for _ in range(tries):
        if r.proc.poll() is not None: mark("CONSOLE EXITED", name=name); return False
        if screen_is(r, name, which, tol): return True
        action(); time.sleep(wait)
    return screen_is(r, name, which, tol)

H = spawn("host", "HOST", os.path.join(priv, "mario.nds")); time.sleep(2.0)
C1 = spawn("c1", "CLIENT1", ""); time.sleep(1.0)
C2 = spawn("c2", "CLIENT2", ""); mark("three consoles started")
time.sleep(14)
t.check("three consoles run in real time", min((H.status.get("fps") or 0), (C1.status.get("fps") or 0), (C2.status.get("fps") or 0)) > 50, f"fps {H.status.get('fps')}/{C1.status.get('fps')}/{C2.status.get('fps')}")
for r, n in ((C1, "c1"), (C2, "c2")):
    t.check(f"{n}: DS menu", goto(r, "client_ds_menu", lambda r=r: tap(r, 0.5, 0.75), "bot"))
    t.check(f"{n}: Download Play open", goto(r, "client_dl_open", lambda r=r: tap(r, 0.68, 0.72, 0.3, 2), "bot"))
t.check("host: select data", goto(H, "host_select_data", lambda: tap(H, 0.5, 0.9, 0.3, 3), "both", 8))
t.check("host: main menu", goto(H, "host_main_menu", lambda: (screen_is(H, "host_select_data", "both") and (tap(H, 0.5, 0.66), tap(H, 0.88, 0.97, 0.4, 3))), "bot", 6, 3))
t.check("host: Find Players", goto(H, "host_find_players", lambda: (screen_is(H, "host_main_menu", "bot") and (tap(H, 0.5, 0.80), tap(H, 0.88, 0.97, 0.4, 3))), "top", 6, 3))
mark("host in Multiplayer menu"); shot(H, "host_find")
t.check("host advertises", wait_state(H, {"HOST_ADVERTISING"}, 20), dl(H))
for r, n in ((C1, "c1"), (C2, "c2")):
    t.check(f"{n}: discovers the game", wait_state(r, {"GAME_DISCOVERED"}, 20) and wait_screen(r, "client_discovered", 15, "bot"), dl(r))
shot(C1, "c1_discovered"); shot(C2, "c2_discovered")
def pick(r): tap(r, 0.5, 0.67, 0.3, 2.0); press(r, 8, 0.25, 3.0)
def own_download_done(r, secs):
    """the console's OWN transfer: its association was made by it (assoc_req_tx) and the bytes delivered to it stopped growing (the shared radio makes the state machine see the other client's transfer too)"""
    end = time.time() + secs; last, since = -1, time.time()
    while time.time() < end:
        c = r.status.get("dl_counters") or {}
        b = c.get("data_bytes_rx", 0)
        if b != last: last, since = b, time.time()
        if c.get("assoc_req_tx", 0) >= 1 and b > 300000 and time.time() - since > 5: return True
        time.sleep(0.5)
    return False
for n, r in (("c1", C1), ("c2", C2)):          # one download after the other: every client asks for the game itself (screen-checked: the radio state is shared)
    for i in range(12):
        if screen_is(r, "client_downloading", "bot", 60): break
        pick(r)
    mark("download requested", who=n, screen_downloading=screen_is(r, "client_downloading", "bot", 60))
    t.check(f"{n}: its own download completes", own_download_done(r, 150), str((r.status.get("dl_counters") or {}).get("data_bytes_rx")))
    shot(r, n + "_dl_done")
mark("both downloaded", c1=dl(C1), c2=dl(C2), host=dl(H))
time.sleep(12); shot(H, "host_two_joined"); shot(C1, "c1_downloading"); shot(C2, "c2_downloading")
for _try in range(10):
    tap(H, 0.88, 0.97, 0.4, 1.5)
    if wait_state(C1, {"CLIENT_GAME_BOOT", "GAME_HANDSHAKE", "LOBBY"}, 6) and wait_state(C2, {"CLIENT_GAME_BOOT", "GAME_HANDSHAKE", "LOBBY"}, 2): break
mark("host pressed OK", c1=dl(C1), c2=dl(C2), host=dl(H))
for n, r in (("c1", C1), ("c2", C2)):
    t.check(f"{n}: the downloaded game boots and handshakes", wait_state(r, {"GAME_HANDSHAKE", "LOBBY"}, 120), dl(r))
time.sleep(10)
for name, r in (("host", H), ("c1", C1), ("c2", C2)): shot(r, name + "_after_boot")
mark("states", host=dl(H), c1=dl(C1), c2=dl(C2), peers=H.status.get("mp_peers"))
for _ in range(4):   # accept the 'You are Pn' screens on every console
    for r, n in ((H, "host_you_are_p1"), (C1, "client_you_are_p2")):
        if screen_is(r, n, "bot"): tap(r, 0.5, 0.79, 0.4, 1.0)
    tap(C2, 0.5, 0.79, 0.4, 3.0)
for name, r in (("host", H), ("c1", C1), ("c2", C2)): shot(r, name + "_lobby")
t.check("no console crashed", all(r.proc.poll() is None for r in (H, C1, C2)))
t.check("the host sees both clients", (H.status.get("mp_peers") or 0) == 2, f"peers={H.status.get('mp_peers')}")
json.dump(timeline, open(os.path.join(out, "timeline.json"), "w"), indent=1)
for r in (C2, C1, H): r.stop()
sys.exit(t.done())
