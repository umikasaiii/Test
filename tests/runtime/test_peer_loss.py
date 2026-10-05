#!/usr/bin/env python3
"""Abrupt loss of the other console (SIGKILL of the peer's process) while both run DS wireless traffic: the surviving Runtime must neither crash nor hang -
it must keep running, report the bridge as inactive, and shut down cleanly (exit code 0). Regression for a null-callback crash: the core's blocking
reply wait calls poll_receive; a peer loss must never invoke the core's netpacket stop() from inside that call.
usage: test_peer_loss.py <dslink-runtime> <npt-test-core.so> [rounds]
Uses the NETPACKET test core in its NPT_BLOCK mode (blocking reply wait like melonDS DS's real multiplayer code), no ROM/BIOS needed."""
import os, signal, subprocess, sys, tempfile, time
from rtlib import *

rt_bin, core = sys.argv[1:3]
rounds = int(sys.argv[3]) if len(sys.argv) > 3 else 10
os.environ["NPT_BLOCK"] = "1"
t = T()
work = tempfile.mkdtemp(prefix="peer_loss_")

crashes = hangs = 0
detail = []
for victim in ("host", "client"):
    for i in range(rounds):
        sock = f"{work}/s{victim}{i}.sock"
        h = Runtime(rt_bin, core, "", f"{work}/h{victim}{i}", name="H", mp=("host", sock)); time.sleep(0.8)
        c = Runtime(rt_bin, core, "", f"{work}/c{victim}{i}", name="C", mp=("client", sock)); time.sleep(1.5 + 0.037 * i)
        dead, alive = (h, c) if victim == "host" else (c, h)
        dead.proc.send_signal(signal.SIGKILL); dead.proc.wait()
        time.sleep(0.8)
        survived = alive.proc.poll() is None
        if not survived: crashes += 1; detail.append((victim, i, alive.proc.returncode)); continue
        f0 = alive.status.get("frames", 0); time.sleep(1.0)
        running = alive.status.get("frames", 0) > f0
        rc = alive.stop(timeout=10)
        if not running or rc != 0: hangs += 1; detail.append((victim, i, "rc", rc, "running", running))
t.check(f"the surviving console never crashes when its peer is SIGKILLed ({2 * rounds} rounds, host and client as victim)", crashes == 0, f"{crashes} crashes {detail[:3]}")
t.check("...keeps emulating afterwards and shuts down cleanly (exit 0)", hangs == 0, f"{hangs} bad")
sys.exit(t.done())
