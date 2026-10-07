#!/usr/bin/env python3
"""Table of the private Mario Party DS PWA<->PWA runs (cloud/tests/play_mario_private.mjs): reads <private>/out/pwa_*/result.json and prints a markdown table of times, link
numbers and radio-trace timing. Only names, states, counters and times are read (the result files contain nothing else). usage: mario_pwa_report.py <private-dir> [run ...]"""
import glob, json, os, sys
priv = sys.argv[1]; names = sys.argv[2:]
rows = []
for f in sorted(glob.glob(os.path.join(priv, "out", "pwa_*", "result.json"))):
    n = os.path.basename(os.path.dirname(f))[4:]
    if names and n not in names: continue
    r = json.load(open(f)); ck = r.get("checks", []); ok = sum(1 for c in ck if c.get("ok")); d = r.get("durations", {}); h = r.get("host") or {}; g = r.get("guest") or {}
    hp = (h.get("peer") or {}); tr = r.get("traces", {}).get("host", {}).get("cmd_reply_ms", {}); tg = r.get("traces", {}).get("guest", {}).get("cmd_reply_ms", {})
    lobby = next((c for c in ck if c["name"].startswith("MARIO LOBBY (screens)")), None)
    imp = r.get("impair", {}); imps = ",".join(f"{k}={v}" for k, v in imp.items() if v) or "-"
    rows.append((n, imps, "msg" if r.get("ringMsg") else "SAB", f"{ok}/{len(ck)}", "PASS" if lobby and lobby["ok"] else "FAIL",
                 d.get("discoveryToDownloadMs"), d.get("downloadMs"), d.get("downloadToBootMs"), d.get("bootToLobbyMs"),
                 round((hp.get("rtt") or {}).get("avg", 0), 1), round(hp.get("jitter", 0), 1), (hp.get("lost"), (g.get("peer") or {}).get("lost")),
                 tr.get("p50"), tr.get("p99"), tr.get("max"), tr.get("share_over_25ms"), tg.get("p50"), tg.get("p99")))
print("| run | impairment | radio rx | checks | lobby | discovery->download ms | download ms | download->boot ms | boot->lobby ms | RTT avg ms | jitter ms | lost h/g | host cmd->reply p50/p99/max ms | >25 ms | guest turnaround p50/p99 ms |")
print("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|")
for x in rows:
    print(f"| {x[0]} | {x[1]} | {x[2]} | {x[3]} | {x[4]} | {x[5]} | {x[6]} | {x[7]} | {x[8]} | {x[9]} | {x[10]} | {x[11][0]}/{x[11][1]} | {x[12]}/{x[13]}/{x[14]} | {x[15]} | {x[16]}/{x[17]} |")
