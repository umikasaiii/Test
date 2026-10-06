#!/usr/bin/env python3
"""Aggregates lan_matrix.py result files into a markdown table (counters/timings only; no private content). usage: lan_report.py matrix1.json [matrix2.json ...]"""
import json, sys
rows = []
for p in sys.argv[1:]:
    rows += json.load(open(p))
order = ["discovery", "handshake", "transfer", "verify", "client_boot", "game_handshake", "lobby", "in_game"]
print("| case | impair (per direction) | result | " + " | ".join(order) + " | RTT ms (guest, avg/min/max) | lost / re-seq / late | jitter ms | queue max | time |")
print("|---|---|---|" + "---|" * len(order) + "---|---|---|---|---|")
def success(r):   # the radio/game phases themselves; the auxiliary in-match D-pad isolation measurement is reported separately (it is a frame-difference heuristic)
    ph = dict(r.get("phases", {})); ph["lobby"] = ph.get("lobby") or ph.get("lobby_radio")      # lobby reached = screens OR the radio state machine (the screen hash is tolerance-sensitive to the animated background)
    need = ["discovery", "handshake", "transfer", "verify", "client_boot", "game_handshake", "lobby"] + (["in_game"] if r.get("game") else [])
    return all(ph.get(k) for k in need)
seen = {}
for r in rows: seen[r["case"]] = r          # a later file replaces an earlier run of the same case label
rows = list(seen.values())
for r in rows:
    ph = r.get("phases", {})
    g = (r.get("lan") or {}).get("guest", {}); h = (r.get("lan") or {}).get("host", {})
    cell = lambda k: ("✓" if (ph.get(k) or (k == "lobby" and ph.get("lobby_radio"))) else "✗") if (k != "in_game" or r.get("game")) else "–"
    rtt = f"{g.get('rtt_ms', 0):.1f}/{g.get('rtt_min_ms', 0):.0f}/{g.get('rtt_max_ms', 0):.0f}" if g else "-"
    lo = f"{g.get('lost', 0) + h.get('lost', 0)} / {g.get('reordered', 0) + h.get('reordered', 0)} / {g.get('late_dropped', 0) + h.get('late_dropped', 0)}" if g else "-"
    print(f"| {r['case']} | {r['impair']} | {'**PASS**' if success(r) else 'FAIL'} ({r.get('checks', '')}{'' if r.get('ok') or not success(r) else ', a screen-hash heuristic check failed'}) | " + " | ".join(cell(k) for k in order) +
          f" | {rtt} | {lo} | {g.get('jitter_ms', 0):.1f} | {max(g.get('queue_max', 0), h.get('queue_max', 0))} | {r.get('secs', 0)} s |")
