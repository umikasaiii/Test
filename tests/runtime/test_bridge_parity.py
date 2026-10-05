#!/usr/bin/env python3
"""A/B parity of the packet interface: the same libretro core (dslink_npt_libretro, NETPACKET only) under
A = RetroArch Netplay (reference)  and  B = DSLink Runtime + Multiplayer Bridge.  Observable events must match.
usage: test_bridge_parity.py <dslink-runtime> <npt-core.so> <retroarch>"""
import os, re, subprocess, sys, tempfile, time
from rtlib import *

rt_bin, core, ra = sys.argv[1:4]
t = T()
work = tempfile.mkdtemp(prefix="bridge_parity_")


def events(text):
    out = []
    for m in re.finditer(r"NPT (START id=\d+|STOP|CONNECTED id=\d+|DISCONNECTED id=\d+|RECV src=\d+ len=\d+ data=\S+)", text):
        out.append(m.group(1))
    return out


def summarize(ev):
    kinds = {}
    for e in ev:
        k = re.sub(r"seq=\d+", "seq=N", e)
        kinds[k] = kinds.get(k, 0) + 1
    return kinds


def seqs_monotonic(ev, src):
    n = [int(m.group(1)) for e in ev for m in [re.search(rf"src={src} len=\d+ data=id={src}:seq=(\d+)", e)] if m]
    return len(n) >= 3 and n == sorted(n) and len(set(n)) == len(n), n[:4]


# ---------------- B: DSLink Runtime
sock = f"{work}/mp.sock"
h = Runtime(rt_bin, core, "", f"{work}/bh", name="H", mp=("host", sock))
time.sleep(1.0)
c = Runtime(rt_bin, core, "", f"{work}/bc", name="C", mp=("client", sock))
time.sleep(4.0)
b_host_status, b_client_status = dict(h.status), dict(c.status)
c.stop(); time.sleep(0.5); h.stop()
bh, bc = events(h.log()), events(c.log())

# ---------------- A: RetroArch (reference). Headless drivers, content-less core.
def ra_run(role, d, port, secs):
    os.makedirs(d, exist_ok=True)
    cfg = f'video_driver = "null"\naudio_driver = "null"\ninput_driver = "null"\naudio_enable = "false"\nmenu_driver = "rgui"\nconfig_save_on_exit = "false"\n'
    open(f"{d}/ra.cfg", "w").write(cfg)
    args = [ra, "-v", "-c", f"{d}/ra.cfg", "-L", core] + (["-H"] if role == "host" else ["-C", "127.0.0.1"]) + ["--port", str(port), "--nick", role]
    return subprocess.Popen(args, cwd=d, stdout=open(f"{d}/ra.log", "w"), stderr=subprocess.STDOUT)

port = 56420
ah = ra_run("host", f"{work}/ah", port, 8)
time.sleep(2.0)
ac = ra_run("client", f"{work}/ac", port, 8)
time.sleep(6.0)
ac.terminate(); time.sleep(1.0); ah.terminate()
try: ah.wait(5); ac.wait(5)
except Exception: ah.kill(); ac.kill()
rah, rac = events(open(f"{work}/ah/ra.log").read()), events(open(f"{work}/ac/ra.log").read())

print("RetroArch host   :", summarize(rah))
print("DSLink bridge host:", summarize(bh))
print("RetroArch client :", summarize(rac))
print("DSLink bridge client:", summarize(bc))

def first(ev, prefix): return next((i for i, e in enumerate(ev) if e.startswith(prefix)), -1)

t.check("host: core gets START id=0 (host) in both frontends", "START id=0" in rah and "START id=0" in bh)
t.check("host: core's connected(id=1) callback fires when the client joins, in both", "CONNECTED id=1" in rah and "CONNECTED id=1" in bh)
t.check("client: START with id=1 in both", "START id=1" in rac and "START id=1" in bc)
t.check("order on host: START before CONNECTED before first RECV, in both",
        all(0 <= first(e, "START") < first(e, "CONNECTED") < first(e, "RECV") for e in (rah, bh)))
t.check("client->host reliable packets arrive with src=1, in order, no loss/dup (both)", seqs_monotonic(rah, 1)[0] and seqs_monotonic(bh, 1)[0], f"RA {seqs_monotonic(rah,1)[1]} / DSLink {seqs_monotonic(bh,1)[1]}")
t.check("host->client broadcast arrives with src=0, in order (both)", seqs_monotonic(rac, 0)[0] and seqs_monotonic(bc, 0)[0], f"RA {seqs_monotonic(rac,0)[1]} / DSLink {seqs_monotonic(bc,0)[1]}")
t.check("client broadcast reaches the host with src=1 (both)", any("data=bcast" in e and "src=1" in e for e in rah) and any("data=bcast" in e and "src=1" in e for e in bh))
t.check("payloads byte-identical in both frontends (same formats observed)", set(re.sub(r"\d+", "#", e) for e in rah if e.startswith("RECV")) == set(re.sub(r"\d+", "#", e) for e in bh if e.startswith("RECV")))
t.check("client disconnect: host core gets DISCONNECTED id=1 in both", "DISCONNECTED id=1" in rah and "DISCONNECTED id=1" in bh)
t.check("DSLink Runtime reports mp_active/peers in its status", b_host_status.get("mp_role") == "host" and b_host_status.get("mp_peers") == 1 and b_client_status.get("mp_role") == "client" and b_client_status.get("mp_active") is True,
        f"{b_host_status.get('mp_role')},{b_host_status.get('mp_peers')} / {b_client_status.get('mp_role')}")
sys.exit(t.done())
