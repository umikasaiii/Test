// DSLink PWA <-> PWA (Phase 3): network fault matrix. The same two-browser session as play_wasm_distributed.mjs, with a test-only impairment (one-way delay, jitter, loss)
// applied by each page to what it SENDS on the DataChannel (like the native LanImpair): connection time, radio handshake, bufferedAmount, drops, RTT/jitter/loss measured.
// A static server + the signaling room (the same module the Worker uses) stand in for the host. Homebrew ROMs only.
// usage: node play_wasm_distributed_matrix.mjs <rom1.nds> <rom2.nds> [report-dir]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createSignalHandler, nodeAdapter } from '../signal/dev_server.mjs';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--')), QUICK = process.argv.includes('--quick');
const [rom, rom2, shots = '/tmp/playdist'] = args;   // two builds of the same homebrew (console id 1 and 2: different Wi-Fi MAC) - the same game code
fs.mkdirSync(shots, { recursive: true });
const WEB = new URL('../web', import.meta.url).pathname, CONTROLS = new URL('../worker/public/controls', import.meta.url).pathname;
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000, step = 100) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

/** one "internet": static files + signaling, optionally cross-origin isolated (SharedArrayBuffer) */
async function startHost({ coi }) {
  const sig = createSignalHandler({ ttlMs: 120000 }), adapt = nodeAdapter(sig), hits = [];
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); hits.push(req.method + ' ' + u.pathname);
    if (await adapt(req, res)) return;
    let p = u.pathname; if (p.endsWith('/')) p += 'index.html';
    const file = p.startsWith('/controls/') ? path.join(CONTROLS, p.slice(10)) : path.join(WEB, p);
    if (!file.startsWith(WEB) && !file.startsWith(CONTROLS)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      const h = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' };
      if (coi) { h['cross-origin-opener-policy'] = 'same-origin'; h['cross-origin-embedder-policy'] = 'require-corp'; h['cross-origin-resource-policy'] = 'same-origin'; }
      res.writeHead(200, h); res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { sig, hits, base: `http://127.0.0.1:${server.address().port}`, close: () => { sig.close(); server.close(); } };
}

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });

async function device(host, name, query = '') {
  const romFile = name === 'B' ? rom2 : rom;
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage(); p.devName = name; p.errors = []; p.on('pageerror', (e) => p.errors.push(String(e)));
  await p.addInitScript(() => {
    window.__pcs = []; window.__tracks = 0; window.__media = 0; window.__channels = [];
    const R = window.RTCPeerConnection;
    window.RTCPeerConnection = function (...a) { const pc = new R(...a); window.__pcs.push(pc);
      const cdc = pc.createDataChannel.bind(pc); pc.createDataChannel = (l, o) => { window.__channels.push({ label: l, opts: o }); return cdc(l, o); };
      const at = pc.addTrack.bind(pc); pc.addTrack = (...x) => { window.__tracks++; return at(...x); }; const atr = pc.addTransceiver.bind(pc); pc.addTransceiver = (...x) => { window.__tracks++; return atr(...x); };
      return pc; };
    window.RTCPeerConnection.prototype = R.prototype;
    const gum = navigator.mediaDevices && navigator.mediaDevices.getUserMedia; if (gum) navigator.mediaDevices.getUserMedia = function (...a) { window.__media++; return gum.apply(this, a); };
  });
  await p.goto(`${host.base}/play/?stun=0&nosw${query}`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 20000 });
  await p.setInputFiles('#romFile', romFile); await until(() => p.locator('#gameList li.game').count());
  return p;
}
const stats = (p) => p.evaluate(() => window.dslinkPlay.stats());
const sess = (p) => p.evaluate(() => { const s = window.dslinkPlay.session; return s ? { state: s.state, code: s.code, role: s.role, peer: s.peer ? s.peer.state : null, ready: s.me.ready, otherReady: s.other.ready, quality: s.quality ? { level: s.quality.level, label: s.quality.label, probe: s.quality.probe } : null, timing: s.timing } : null; });
const grab = (p) => p.evaluate(async () => Array.from(await window.dslinkPlay.grab()));
const px = (b, x, y) => { const o = (y * 256 + x) * 4; return [b[o], b[o + 1], b[o + 2]]; };
const yellow = (c) => c[0] > 200 && c[1] > 200 && c[2] < 120, cyan = (c) => c[0] < 120 && c[1] > 200 && c[2] > 200;
const bars = async (p) => { const b = await grab(p); return { tx: yellow(px(b, 4, 171)), rx: cyan(px(b, 4, 177)), sq: px(b, 242, 176) }; };
const rxLen = async (p) => { const b = await grab(p); let n = 0; while (n < 60 && px(b, n * 4 + 1, 177)[0] < 120 && px(b, n * 4 + 1, 177)[1] > 200) n++; return n; };

/** create + join + ready + start through the real UI. Returns the two pages already playing. */
async function pair(host, qa = '', qb = '') {
  const A = await device(host, 'A', qa), B = await device(host, 'B', qb);
  await A.click('#btnCreate'); await A.waitForSelector('[data-screen=friends-create].on'); await A.click('#btnMakeRoom');
  await A.waitForSelector('[data-screen=lobby].on'); const code = await until(() => A.evaluate(() => document.getElementById('codeText').textContent), 8000);
  await B.click('#btnJoin'); await B.waitForSelector('[data-screen=friends-join].on'); await B.fill('#joinCode', code); await B.click('#btnDoJoin');
  await B.waitForSelector('[data-screen=lobby].on');
  return { A, B, code };
}
async function startBoth(A, B) {
  await until(async () => (await sess(A))?.peer === 'open' && (await sess(B))?.peer === 'open', 15000);
  await until(async () => (await sess(A))?.quality, 15000);
  await until(() => B.evaluate(() => !document.getElementById('btnReady').hidden && !document.getElementById('btnReady').disabled), 8000);
  await B.click('#btnReady'); await until(() => A.evaluate(() => !document.getElementById('btnStart').disabled), 8000);
  await A.click('#btnStart');
  return await until(async () => (await A.evaluate(() => window.dslinkPlay.isPlaying())) && (await B.evaluate(() => window.dslinkPlay.isPlaying())), 40000);
}
const pcInfo = (p) => p.evaluate(async () => { const pc = window.__pcs[0]; if (!pc) return null; const st = await pc.getStats(); let pair = null, cands = []; st.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated) pair = r; });
  return { senders: pc.getSenders().length, transceivers: pc.getTransceivers().length, tracks: window.__tracks, media: window.__media, channels: window.__channels, sctp: !!pc.sctp, conn: pc.connectionState, pairRtt: pair ? pair.currentRoundTripTime : null }; });


const MATRIX = [
  { name: '0 ms', q: '' },
  { name: '5 ms', q: '&delay=5' },
  { name: '8 ms', q: '&delay=8' },
  { name: '10 ms', q: '&delay=10' },
  { name: '5 ms + jitter 3 ms', q: '&delay=5&jitter=3' },
  { name: '5 ms + 1% loss', q: '&delay=5&loss=1' },
  { name: '5 ms + 3% loss', q: '&delay=5&loss=3' },
  { name: '5 ms + 3% loss, channel ordered+reliable (mode check only: the loss is injected ABOVE the channel, so no retransmission is simulated)', q: '&delay=5&loss=3&radiomode=ordered', cmp: true },
];
const PLAY_MS = 9000, rows = [];
const host = await startHost({ coi: true });
for (const sc of MATRIX) {
  const t0 = Date.now();
  const A = await device(host, 'A', sc.q), B = await device(host, 'B', sc.q);
  await A.click('#btnCreate'); await A.click('#btnMakeRoom'); await A.waitForSelector('[data-screen=lobby].on');
  const code = await until(() => A.evaluate(() => document.getElementById('codeText').textContent), 8000);
  await B.click('#btnJoin'); await B.fill('#joinCode', code); await B.click('#btnDoJoin');
  const tj = Date.now();
  const open = await until(async () => (await sess(A))?.peer === 'open' && (await sess(B))?.peer === 'open', 20000);
  const connectMs = Date.now() - tj;
  await until(async () => (await sess(A))?.quality, 20000);
  const qa = (await sess(A))?.quality;
  const lp = await A.evaluate(() => window.dslinkPlay.session.peer.probe(5000, 20));   // 250 round trips on the idle link (before the emulators load the CPU): the clean measurement
  await until(() => B.evaluate(() => !document.getElementById('btnReady').hidden && !document.getElementById('btnReady').disabled), 8000);
  await B.click('#btnReady'); await until(() => A.evaluate(() => !document.getElementById('btnStart').disabled), 8000); await A.click('#btnStart');
  const ts = Date.now();
  await until(async () => (await A.evaluate(() => window.dslinkPlay.isPlaying())) && (await B.evaluate(() => window.dslinkPlay.isPlaying())), 40000);
  const hs = await until(async () => { const a = await bars(A), b = await bars(B); return a.tx && a.rx && b.tx && b.rx; }, 40000);
  const handshakeMs = hs ? Date.now() - ts : -1;
  const sa0 = await stats(A), sb0 = await stats(B);
  await sleep(PLAY_MS);
  const sa = await stats(A), sb = await stats(B), pa = sa.radio.peer, pb = sb.radio.peer;
  const sentAB = pa.sent, recvAB = pb.recv, sentBA = pb.sent, recvBA = pa.recv;
  const attAB = pa.sent + pa.droppedImpair, attBA = pb.sent + pb.droppedImpair;                     // frames the cores handed over (before the test impairment)
  const lossAB = attAB ? 100 * (1 - recvAB / attAB) : 0, lossBA = attBA ? 100 * (1 - recvBA / attBA) : 0;
  const row = { scenario: sc.name, connected: open, connectMs, quality: qa && qa.label, probe: { n: lp.sent, rttAvg: +lp.rttAvg.toFixed(2), rttMin: +lp.rttMin.toFixed(2), rttP95: +lp.rttP95.toFixed(2), rttMax: +lp.rttMax.toFixed(2), jitter: +lp.jitter.toFixed(2), roundTripLossPct: +lp.lossPct.toFixed(1), oneWayEstMs: +lp.oneWayEstMs.toFixed(2) },
    handshakeMs, handshake: hs, playMs: PLAY_MS, emuFps: [+sa.emuFps.toFixed(1), +sb.emuFps.toFixed(1)],
    inGameRttAvg: +((pa.rtt.avg + pb.rtt.avg) / 2).toFixed(2), rttAvg: +lp.rttAvg.toFixed(2), rttMax: +lp.rttMax.toFixed(1), jitter: +lp.jitter.toFixed(2), inGameJitter: +((pa.jitter + pb.jitter) / 2).toFixed(2), framesAttempted: [attAB, attBA],
    sent: [sentAB, sentBA], recv: [recvAB, recvBA], oneWayLossPct: [+lossAB.toFixed(1), +lossBA.toFixed(1)], seqLost: [pb.lost, pa.lost], reordered: [pb.reordered, pa.reordered], late: [pb.lateDropped, pa.lateDropped],
    dropped: { impair: [pa.droppedImpair, pb.droppedImpair], soft: [pa.droppedSoft, pb.droppedSoft], hard: [pa.droppedHard, pb.droppedHard], ringA: sa.radio.ringDropped, ringB: sb.radio.ringDropped },
    bufferedMax: [pa.bufferedMax, pb.bufferedMax], queueMax: [pa.queueMax, pb.queueMax], holdMaxMs: [+pb.rxHoldMsMax.toFixed(1), +pa.rxHoldMsMax.toFixed(1)], ringLagMaxMs: [+sa.radio.core.lagMax.toFixed(1), +sb.radio.core.lagMax.toFixed(1)],
    coreIn: [sa.radio.core.in, sb.radio.core.in], coreOut: [sa.radio.core.out, sb.radio.core.out], channel: { ordered: pa.radio.ordered, maxRetransmits: pa.radio.maxRetransmits } };
  rows.push(row); console.log(JSON.stringify(row));
  const still = (await sess(A))?.state === 'playing' && (await sess(B))?.state === 'playing';
  check(`MATRIX ${sc.name}: connected, radio handshake completed, session stays up, emulation real-time, nothing blocked`, open && hs && still && sa.emuFps > 45 && sb.emuFps > 45 && pa.droppedHard + pb.droppedHard === 0,
    `connect ${connectMs} ms, handshake ${handshakeMs} ms, RTT ${row.rttAvg} ms, jitter ${row.jitter} ms, loss ${row.oneWayLossPct} %, bufferedMax ${row.bufferedMax}, emu ${row.emuFps}`);
  await A.context().close(); await B.context().close();
  await until(() => host.sig.rooms.size === 0, 10000);
}
check('MATRIX impairment is real (clean idle-link probe): RTT ~ 2x the injected one-way delay and grows with it; round-trip loss follows the injected rate; the clean link has none', rows[0].probe.rttAvg < 5 && rows[1].rttAvg > 8 && rows[2].rttAvg > rows[1].rttAvg + 3 && rows[3].rttAvg > rows[2].rttAvg + 2 && rows[0].probe.roundTripLossPct === 0 && rows[5].probe.roundTripLossPct > 0.4 && rows[6].probe.roundTripLossPct > 2 && rows[6].probe.roundTripLossPct < 14 && rows[4].jitter > rows[1].jitter, JSON.stringify(rows.map((r) => [r.scenario, r.rttAvg, r.jitter, r.probe.roundTripLossPct])));
fs.mkdirSync(shots, { recursive: true }); fs.writeFileSync(path.join(shots, 'matrix.json'), JSON.stringify(rows, null, 1));
console.log('\nscenario'.padEnd(52) + 'connect hshake RTTavg RTTmax jitter rtLoss% lossAB/BA(game) buffMax drop(imp/soft/hard)');
for (const r of rows) console.log(r.scenario.padEnd(51) + `${String(r.connectMs).padStart(6)} ${String(r.handshakeMs).padStart(6)} ${String(r.rttAvg).padStart(6)} ${String(r.rttMax).padStart(6)} ${String(r.jitter).padStart(6)} ${String(r.probe.roundTripLossPct).padStart(7)} ${r.oneWayLossPct.join('/').padStart(9)} ${String(Math.max(...r.bufferedMax)).padStart(8)}  ${r.dropped.impair.reduce((a, b) => a + b)}/${r.dropped.soft.reduce((a, b) => a + b)}/${r.dropped.hard.reduce((a, b) => a + b)}`);
host.close(); await browser.close();
const ok = results.filter(Boolean).length; console.log(`${ok}/${results.length} checks passed`); process.exit(ok === results.length ? 0 : 1);
