#!/usr/bin/env python3
"""Interactive two-console driver (local, private use). One daemon owns the two DSLink Runtimes; short commands drive them.

  dsdriver.py serve --rt R --core C --cfgtool T --rom ROM --fw DIR --out OUT [--sock S] [--no-client-rom|--dual-rom ROM2]
  dsdriver.py cmd shot host|client NAME      -> PNG path (screen, 256x384)         press host A 0.15     touch client 0.5 0.75 0.2
  dsdriver.py cmd status | log host 40 | audio host 1.0 | hold host A | release host A | quit

Everything it writes (screenshots, saves, logs) goes under OUT, which must stay outside git (private/ is ignored). The ROM and firmware are
read, never copied outside the consoles' work directories and never printed. client = NO cartridge unless --dual-rom (comparison debugging only)."""
import argparse, json, os, shutil, socket, subprocess, sys, threading, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "runtime"))
from rtlib import *

BTN = dict(B=0, Y=1, SELECT=2, START=3, UP=4, DOWN=5, LEFT=6, RIGHT=7, A=8, X=9, L=10, R=11)
DEV = {"host": "aaaa0000000000000000000000000000", "client": "bbbb0000000000000000000000000000"}

def serve(a):
    work = os.path.join(a.out, "work"); os.makedirs(work, exist_ok=True)
    mp = os.path.join(work, "mp.sock")
    def ident(role, name, rom):
        g = lambda w: subprocess.check_output([a.cfgtool, role, work, "x", rom or "-", "127.0.0.1" if role == "client" else "-", "56300", name, DEV[role], w], text=True).strip()
        open(f"{work}/{name}.opts", "w").write(g("opts"))
        return g("nick"), g("mac")
    def spawn(role, name, rom):
        d = os.path.join(work, role)
        os.makedirs(f"{d}/system/melonDS DS", exist_ok=True)
        if a.fw:
            for f in ("bios7.bin", "bios9.bin", "firmware.bin"):
                if os.path.exists(os.path.join(a.fw, f)): shutil.copy(os.path.join(a.fw, f), f"{d}/system/melonDS DS/{f}")   # copies; originals untouched
        nick, mac = ident(role, name, rom)
        return Runtime(a.rt, a.core, rom, d, name=name, username=nick, opts=f"{work}/{name}.opts", mp=(role, mp), av=True), mac
    R = {}
    R["host"], hm = spawn("host", "HOST", a.rom)
    time.sleep(2.0)
    R["client"], cm = spawn("client", "CLIENT", a.dual_rom or "")
    print(f"consoles up: host MAC {hm}, client MAC {cm}", flush=True)
    held = set()
    sock = a.sock; 
    if os.path.exists(sock): os.remove(sock)
    srv = socket.socket(socket.AF_UNIX); srv.bind(sock); srv.listen(4)
    def png(who, name):
        im = R[who].snapshot(name + ".ppm")
        if not im: return None
        out = os.path.join(a.out, name + ".png")
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", os.path.join(R[who].dir, name + ".ppm"), "-vf", "scale=iw*2:ih*2:flags=neighbor", out], check=False)
        return out
    def handle(req):
        c = req["c"]; who = req.get("who")
        if c == "status":
            return {k: {x: R[k].status.get(x) for x in ("frames", "fps", "mp_active", "mp_peers", "mp_in", "mp_out", "dl_state", "dl_counters", "slowest_frame_ms")} for k in R}
        if c == "shot": return {"png": png(who, req["name"])}
        if c == "press":
            R[who].button(BTN[req["btn"]], True); time.sleep(req.get("secs", 0.15)); R[who].button(BTN[req["btn"]], False); return {}
        if c == "hold": R[who].button(BTN[req["btn"]], True); return {}
        if c == "release": R[who].button(BTN[req["btn"]], False); return {}
        if c == "touch":
            R[who].touch(req["x"], req["y"], True); time.sleep(req.get("secs", 0.2)); R[who].touch(req["x"], req["y"], False); return {}
        if c == "log": return {"log": "\n".join(R[who].log().splitlines()[-req.get("n", 40):])}
        if c == "grep": return {"log": "\n".join(l for l in R[who].log().splitlines() if req["pat"] in l)[-6000:]}
        if c == "audio":
            w = R[who].audio_dump(req.get("secs", 1.0), "audio.wav"); return {"freq": w.freq() if w else None, "rms": w.rms() if w else None}
        if c == "quit": return {"bye": True}
        return {"error": "unknown command"}
    while True:
        conn, _ = srv.accept()
        try:
            req = json.loads(conn.makefile().readline())
            res = handle(req)
        except Exception as e:
            res = {"error": str(e)}
        conn.sendall((json.dumps(res) + "\n").encode()); conn.close()
        if res.get("bye"): break
    for r in R.values(): r.stop()
    os.remove(sock)

def cmd(args, sock):
    req = {"c": args[0]}
    if args[0] in ("shot", "press", "hold", "release", "touch", "log", "grep", "audio"): req["who"] = args[1]
    if args[0] == "shot": req["name"] = args[2]
    if args[0] in ("press", "hold", "release"): req["btn"] = args[2].upper(); req["secs"] = float(args[3]) if len(args) > 3 else 0.15
    if args[0] == "touch": req["x"], req["y"] = float(args[2]), float(args[3]); req["secs"] = float(args[4]) if len(args) > 4 else 0.2
    if args[0] == "log": req["n"] = int(args[2]) if len(args) > 2 else 40
    if args[0] == "grep": req["pat"] = args[2]
    if args[0] == "audio": req["secs"] = float(args[2]) if len(args) > 2 else 1.0
    s = socket.socket(socket.AF_UNIX); s.connect(sock); s.sendall((json.dumps(req) + "\n").encode())
    print(s.makefile().readline().strip())

if __name__ == "__main__":
    p = argparse.ArgumentParser(); p.add_argument("mode"); p.add_argument("rest", nargs="*")
    for k in ("rt", "core", "cfgtool", "rom", "fw", "out", "dual-rom"): p.add_argument("--" + k, default="")
    p.add_argument("--sock", default="/tmp/dsdriver.sock")
    a, extra = p.parse_known_args()
    a.dual_rom = getattr(a, "dual_rom", "")
    if a.mode == "serve": serve(a)
    else: cmd((a.rest if a.mode == "cmd" else [a.mode] + a.rest) + extra, a.sock)
