// Performance probe: two real browsers on the gateway; measures time-to-first-frame, fps, bitrate, jitter, RTT (WebRTC stats) and CPU / RSS of the
// DSLink Runtime + gateway processes. Prints a JSON summary. usage: node perf_probe.mjs <base> <rom1> <rom2> [seconds]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
const base = process.argv[2] || 'http://localhost:8080', rom1 = process.argv[3], rom2 = process.argv[4], secs = Number(process.argv[5] || 20);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const procs = () => execSync('ps -eo pid,pcpu,rss,args --no-headers | grep -E "dslink-(runtime|gateway)" | grep -v grep || true').toString().trim().split('\n').filter(Boolean)
  .map((l) => { const m = l.trim().match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)/); return m ? { pid: +m[1], cpu: +m[2], rssMB: +(m[3] / 1024).toFixed(1), name: m[4].split('/').pop() } : null; }).filter(Boolean);
await fetch(base + '/api/room', { method: 'DELETE' });
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection'] });
const mk = async () => (await browser.newContext({ viewport: { width: 540, height: 1000 } })).newPage();
const A = await mk();
await A.goto(base);
const t0 = Date.now();
const sess = await A.evaluate(async ([r1, r2]) => {
  const bin = (b) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0)); const fd = new FormData();
  fd.append('rom', new Blob([bin(r1)]), 'p1.nds'); fd.append('rom2', new Blob([bin(r2)]), 'p2.nds');
  return (await fetch('/api/room', { method: 'POST', body: fd })).json();
}, [fs.readFileSync(rom1).toString('base64'), fs.readFileSync(rom2).toString('base64')]);
const tCreate = Date.now() - t0;
await A.evaluate((s) => window.__dslinkStart(s), sess);
const B = await mk(); await B.goto(base + '/#' + sess.code); await B.click('#btnEnter');
await Promise.all([A, B].map((p) => p.waitForFunction(() => window.dslink?.video?.videoWidth > 0, null, { timeout: 40000 })));
const tFrame = Date.now() - t0;
await sleep(3000);
const stats = (p) => p.evaluate(async () => {
  const r = await window.dslink.pc.getStats(); const o = {};
  r.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') Object.assign(o, { bytes: s.bytesReceived, frames: s.framesDecoded, dropped: s.framesDropped, jitter: s.jitter, lost: s.packetsLost, w: s.frameWidth, h: s.frameHeight, t: s.timestamp });
    if (s.type === 'inbound-rtp' && s.kind === 'audio') o.abytes = s.bytesReceived;
    if (s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated) { o.rtt = s.currentRoundTripTime; o.pair = [s.localCandidateId, s.remoteCandidateId]; } });
  if (o.pair) { const t = (id) => r.get(id)?.candidateType; o.path = `${t(o.pair[0])}<->${t(o.pair[1])}`; }
  return o;
});
const cpu0 = procs(); const a0 = await stats(A), b0 = await stats(B);
const samples = []; for (let i = 0; i < Math.max(1, secs / 5); i++) { await sleep(5000); samples.push(procs()); }
const a1 = await stats(A), b1 = await stats(B);
const rate = (x, y) => { const dt = (y.t - x.t) / 1000; return { fps: +((y.frames - x.frames) / dt).toFixed(1), kbps: Math.round(((y.bytes - x.bytes) * 8) / dt / 1000), audioKbps: Math.round(((y.abytes - x.abytes) * 8) / dt / 1000), jitterMs: +(y.jitter * 1000).toFixed(2), lost: y.lost, dropped: y.dropped - x.dropped, rttMs: y.rtt != null ? +(y.rtt * 1000).toFixed(1) : null, res: `${y.w}x${y.h}`, icePath: y.path }; };
const flat = samples.flat(); const agg = {};
for (const p of flat) { const k = p.name; (agg[k] ||= { cpu: [], rss: [] }); agg[k].cpu.push(p.cpu); agg[k].rss.push(p.rssMB); }
const sum = Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, { samples: v.cpu.length, cpuPctAvg: +(v.cpu.reduce((a, b) => a + b, 0) / v.cpu.length).toFixed(1), rssMBMax: Math.max(...v.rss) }]));
const out = { sessionCreateMs: tCreate, firstFrameMs: tFrame, playerA: rate(a0, a1), playerB: rate(b0, b1), processes: sum, perRoomRuntimeCpuPctTotal: +Object.entries(agg).filter(([k]) => k === 'dslink-runtime').reduce((s, [, v]) => s + v.cpu.reduce((a, b) => a + b, 0) / (v.cpu.length / 2 || 1), 0).toFixed(1) };
console.log(JSON.stringify(out, null, 2));
await browser.close(); await fetch(base + '/api/room', { method: 'DELETE' });
