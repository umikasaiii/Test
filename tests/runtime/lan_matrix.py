#!/usr/bin/env python3
"""Runs the REAL Mario Party DS Download Play test (mario_dlplay.py, PRIVATE files, never CI) repeatedly over the LAN RadioTransport with network
impairment, and aggregates per-phase results. Writes only counters/timings to <out>.json (no private content).
usage: lan_matrix.py <runtime> <core.so> <cfgtool> <private-dir> <out.json> <label>:<impair>[:game] [...]
  impair = "delay=10,jitter=2,loss=0.5" or "-" for none; add ":game" to continue into a Block Star match, ":ws=3" to triple the radio wait budgets.   e.g.  base:-  d20:delay=20  l1:loss=1
  repeat a case with  label*N:impair"""
import json, os, subprocess, sys, time

rt, core, cfg, priv, outp = sys.argv[1:6]
cases = []
for a in sys.argv[6:]:
    parts = a.split(":"); lab = parts[0]; n = 1
    if "*" in lab: lab, n = lab.split("*"); n = int(n)
    imp = parts[1] if len(parts) > 1 else "-"; game = "game" in parts[2:]; noav = "noav" in parts[2:]; ws = next((p[3:] for p in parts[2:] if p.startswith("ws=")), "1")
    for i in range(n): cases.append((f"{lab}#{i + 1}" if n > 1 else lab, "" if imp == "-" else imp, game, ws, noav))

PHASES = [("discovery", "GAME_DISCOVERED: the client's radio"), ("discovery_screen", "GAME_DISCOVERED (screen)"), ("handshake", "DOWNLOAD_HANDSHAKE"), ("transfer", "DOWNLOAD_TRANSFER"),
          ("verify", "DOWNLOAD_VERIFY: payload"), ("client_boot", "CLIENT_GAME_BOOT"), ("game_handshake", "GAME_HANDSHAKE: regular"), ("lobby", "LOBBY (screen)"), ("lobby_radio", "LOBBY (radio)"),
          ("in_game", "IN_GAME (screen)"), ("alive", "neither console process crashed")]
results = json.load(open(outp)) if os.path.exists(outp) else []
done = {r["case"] for r in results}
for lab, imp, game, ws, noav in cases:
    if lab in done: continue
    res = f"/tmp/lm_{lab.replace('#', '_')}.json"
    cmd = [sys.executable, os.path.join(os.path.dirname(__file__), "mario_dlplay.py"), rt, core, cfg, priv, "--lan", "--out", "lm_" + lab.replace("#", "_"), "--result", res] + (["--impair", imp] if imp else []) + (["--blind-game"] if game else []) + (["--wait-scale", ws] if ws != "1" else []) + (["--no-av"] if noav else []) + ["--failfast"]
    t0 = time.time()
    try: subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=900)
    except subprocess.TimeoutExpired: pass
    r = {"case": lab, "impair": imp or "none", "game": game, "wait_scale": ws, "secs": round(time.time() - t0)}
    try:
        d = json.load(open(res)); ch = d["checks"]
        r["checks"] = f"{sum(1 for _, o in ch if o)}/{len(ch)}"
        r["phases"] = {p: any(o for n, o in ch if key in n) for p, key in PHASES}
        r["first_fail"] = next((n for n, o in ch if not o), None)
        r["lan"] = d.get("lan_stats"); r["fps"] = d.get("fps")
        r["ok"] = all(o for _, o in ch)
    except Exception as e:
        r["ok"] = False; r["error"] = str(e)[:100]
    results.append(r)
    json.dump(results, open(outp, "w"), indent=1)
    print(f"{lab:10s} {r['impair']:28s} ok={r['ok']} {r.get('checks')} {r['secs']}s first_fail={(r.get('first_fail') or '')[:70]}", flush=True)
