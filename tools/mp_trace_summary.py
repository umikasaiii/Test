#!/usr/bin/env python3
"""Summarise a radio frame trace (no payload): native Runtime trace (DSLINK_MP_TRACE lines "t TX|RX type= aid= len= flen= fc= ...") or a PWA trace (JSON list of
[t, dir(0 tx/1 rx), type, len, fc, peer, lagMs] from player.radioTrace()). Output: frames per direction and DS packet type (0 other / 1 reply / 2 cmd), broadcast share,
and the command->reply timing seen by this console: host = TX cmd -> next RX reply; guest = RX cmd -> next TX reply (turnaround). Private traces stay private: only the summary is kept.
usage: mp_trace_summary.py host|guest <trace.log|trace.json>"""
import json, re, sys, statistics as st

def load(path):
    if path.endswith(".json"):
        d = json.load(open(path)); ev = d["events"] if isinstance(d, dict) else d
        return [(e[0], "TX" if e[1] == 0 else "RX", e[2], e[3], e[4]) for e in ev]
    out = []
    for l in open(path, errors="replace"):
        m = re.match(r"\s*([\d.]+)\s+(TX|RX)\s+type=(\d+)\s+aid=\d+\s+len=(\d+)(?:\s+flen=\d+)?(?:\s+fc=([0-9a-f]+))?", l)
        if m: out.append((float(m.group(1)), m.group(2), int(m.group(3)), int(m.group(4)), int(m.group(5) or "0", 16)))
    return out

def pct(v, p): return round(v[min(len(v) - 1, int(len(v) * p))], 2) if v else None

def summary(role, ev):
    c = {}
    for _, d, ty, ln, fc in ev: c[f"{d}_type{ty}"] = c.get(f"{d}_type{ty}", 0) + 1
    lat, pend = [], None
    for t, d, ty, ln, fc in ev:
        if role == "host":
            if d == "TX" and ty == 2: pend = t
            elif d == "RX" and ty == 1 and pend is not None: lat.append(t - pend); pend = None
        else:
            if d == "RX" and ty == 2: pend = t
            elif d == "TX" and ty == 1 and pend is not None: lat.append(t - pend); pend = None
    lat.sort()
    dur = (ev[-1][0] - ev[0][0]) / 1000 if len(ev) > 1 else 0
    return {"frames": len(ev), "seconds": round(dur, 1), "counts": c, "cmd_reply_ms": {"n": len(lat), "p50": pct(lat, .5), "p90": pct(lat, .9), "p99": pct(lat, .99), "max": round(lat[-1], 2) if lat else None,
            "over_25ms": sum(1 for x in lat if x > 25), "share_over_25ms": round(sum(1 for x in lat if x > 25) / len(lat), 4) if lat else None}}

if __name__ == "__main__":
    print(json.dumps(summary(sys.argv[1], load(sys.argv[2])), indent=1))
