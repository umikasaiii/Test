#!/usr/bin/env python3
"""Samples CPU (% of ONE core) and RSS of the DSLink processes via /proc every 2 s until stopped (SIGTERM) and prints a JSON summary (names and numbers only).
usage: procstat.py <out.json> [comm ...]    default: dslink-runtime dslink-gateway"""
import json, os, signal, sys, time
out = sys.argv[1]; names = sys.argv[2:] or ["dslink-runtime", "dslink-gateway"]
hz = os.sysconf("SC_CLK_TCK"); samples = {}; prev = {}; stop = False
def onterm(*_):
    global stop; stop = True
signal.signal(signal.SIGTERM, onterm); signal.signal(signal.SIGINT, onterm)
def procs():
    for p in os.listdir("/proc"):
        if not p.isdigit(): continue
        try:
            comm = open(f"/proc/{p}/comm").read().strip()
            if comm in names:
                f = open(f"/proc/{p}/stat").read().rsplit(")", 1)[1].split()
                yield int(p), comm, (int(f[11]) + int(f[12])) / hz, int(f[21]) * os.sysconf("SC_PAGE_SIZE") / 1048576
        except OSError: pass
t_prev = time.time()
while not stop:
    time.sleep(2); now = time.time(); dt = now - t_prev; t_prev = now
    cur = {}
    for pid, comm, cpu, rss in procs():
        cur[pid] = cpu
        if pid in prev: samples.setdefault(comm, {}).setdefault(pid, []).append((100.0 * (cpu - prev[pid]) / dt, rss))
    prev = cur
res = {}
for comm, d in samples.items():
    allc = [c for v in d.values() for c, _ in v]; allr = [r for v in d.values() for _, r in v]
    res[comm] = {"processes": len(d), "cpu_pct_avg_per_process": round(sum(allc) / max(1, len(allc)), 1), "cpu_pct_max": round(max(allc or [0]), 1), "rss_mb_max_per_process": round(max(allr or [0]), 1),
                 "cpu_pct_sum_avg": round(sum(sum(c for c, _ in v) / max(1, len(v)) for v in d.values()), 1)}
json.dump(res, open(out, "w"), indent=1); print(json.dumps(res))
