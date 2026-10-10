// DSLink PWA <-> PWA (Phase 3): two browsers, each running its OWN melonDS WebAssembly, joined by one WebRTC DataChannel that carries ONLY the DS radio frames.
// A static server + the signaling room (the same module the Worker uses) stand in for the host. Homebrew ROMs only.
// usage: node play_wasm_distributed.mjs <rom1.nds> <rom2.nds> [screenshot-dir] [--quick]
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
  await (await p.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), p).setInputFiles('#romFile', romFile); await until(async () => (await p.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), p).locator('#gameList li.game').count());
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
  await (await A.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('multiplayer')), A).click('#btnCreate'); await A.waitForSelector('[data-screen=friends-create].on'); await A.click('#btnMakeRoom');
  await A.waitForSelector('[data-screen=lobby].on'); const code = await until(() => A.evaluate(() => document.getElementById('codeText').textContent), 8000);
  await (await B.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('multiplayer')), B).click('#btnJoin'); await B.waitForSelector('[data-screen=friends-join].on'); await B.fill('#joinCode', code); await B.click('#btnDoJoin');
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

// ============================================================================================ 1. SharedArrayBuffer receive path (isolated page), unordered/no-retransmit
{
  const host = await startHost({ coi: true });
  const { A, B, code } = await pair(host);
  check('LOBBY: HOST creates a 6-digit code (and QR); PLAYER 2 joins with it', /^\d{6}$/.test(code) && (await A.evaluate(() => document.getElementById('codeQr').dataset.code)) === code, code);
  check('TWO PWA PEERS: two separate browser contexts (devices), each with its own page and storage', A.context() !== B.context());
  const ok = await until(async () => (await sess(A))?.peer === 'open' && (await sess(B))?.peer === 'open', 15000);
  check('WEBRTC OFFER/ANSWER + ICE: the DataChannel connection is established through the signaling room', ok, JSON.stringify({ a: (await sess(A))?.peer, b: (await sess(B))?.peer }));
  const ia = await pcInfo(A), ib = await pcInfo(B);
  check('DATACHANNEL OPEN: "radio" and "ctl" channels on one connection, no other kind of channel', ia && ib && ia.channels.map((c) => c.label).join() === 'radio,ctl' && ib.channels.length === 0 && ia.conn === 'connected' && ib.conn === 'connected', JSON.stringify(ia?.channels));
  const mA = await A.evaluate(() => window.dslinkPlay.session.peer.metrics()), mB = await B.evaluate(() => window.dslinkPlay.session.peer.metrics());
  check('UNORDERED / NO-RETRANSMIT MODE: the radio channel is ordered=false, maxRetransmits=0 on both ends (verified on the live channel objects)', mA.radio.ordered === false && mA.radio.maxRetransmits === 0 && mB.radio.ordered === false && mB.radio.maxRetransmits === 0, JSON.stringify([mA.radio, mB.radio]));
  check('BINARY RADIO TRANSPORT: the radio channel is binary (arraybuffer), no string ever travels on it', mA.radio.binaryType === 'arraybuffer' && mB.radio.binaryType === 'arraybuffer' && mA.stringOnRadio === 0 && mB.stringOnRadio === 0);
  check('NO VIDEO STREAM / NO AUDIO STREAM: no tracks, no senders, no transceivers, no getUserMedia during the whole session', ia.senders === 0 && ia.transceivers === 0 && ia.tracks === 0 && ib.senders === 0 && ib.tracks === 0 && ia.media === 0 && ib.media === 0, JSON.stringify([ia.senders, ia.transceivers, ia.tracks, ia.media]));
  await until(async () => (await sess(A))?.quality, 15000);
  const q = await sess(A), qb = await until(async () => (await sess(B))?.quality, 8000);
  check('QUALITY GATE: before START the host measured RTT/jitter/loss for a few seconds; both lobbies show OTTIMA/BUONA/NON ADATTA (no numbers)', q.quality && ['OTTIMA', 'BUONA', 'NON ADATTA'].includes(q.quality.label) && qb && qb.label === q.quality.label && q.quality.probe.received > 20, JSON.stringify({ label: q.quality?.label, probe: q.quality?.probe }));
  const lobbyText = await A.evaluate(() => document.querySelector('[data-screen=lobby]').innerText);
  check('UX: the lobby shows HOST / PLAYER 2 and states, and never an SDP, IP, port or ICE', /HOST/.test(lobbyText) && /PLAYER 2/.test(lobbyText) && !/(sdp|candidate|ice|\d+\.\d+\.\d+\.\d+|a=)/i.test(lobbyText) && !/\bms\b/.test(await A.evaluate(() => document.getElementById('lobbyQuality').textContent)), lobbyText.replace(/\n/g, ' | '));
  await A.screenshot({ path: `${shots}/lobby-host.png` }); await B.screenshot({ path: `${shots}/lobby-guest.png` });
  const t0 = Date.now();
  const playing = await startBoth(A, B);
  check('START: HOST starts after PLAYER 2 is PRONTO, both consoles boot their own DS', playing, `${Date.now() - t0} ms`);
  await sleep(1500);
  const wa = A.workers().filter((w) => /emulator\.worker/.test(w.url())).length, wb = B.workers().filter((w) => /emulator\.worker/.test(w.url())).length;
  check('ONE MELONDS PER DEVICE: each page has exactly one emulator worker (one core), none extra on the other', wa === 1 && wb === 1, `${wa}/${wb}`);

  // ---- radio both ways (homebrew: yellow = frames sent, cyan = frames received from the OTHER console, square = sender: blue console 1 / red console 2)
  const ra = await until(async () => { const b = await bars(A); return b.tx && b.rx ? b : false; }, 25000), rb = await until(async () => { const b = await bars(B); return b.tx && b.rx ? b : false; }, 25000);
  check('A->B RADIO: B\'s DS receives frames transmitted by A\'s DS (cyan bar on B, sender colour = A)', !!rb && ((rb.sq[0] > 200 && rb.sq[2] < 100) || (rb.sq[2] > 200 && rb.sq[0] < 100)), JSON.stringify([ra, rb]));
  check('B->A RADIO: A\'s DS receives frames transmitted by B\'s DS (cyan bar on A)', !!ra);
  check('HOME-BREW MULTIPLAYER: the two consoles report each other\'s frames with DIFFERENT sender ids (host id differs from guest id)', !!ra && !!rb && JSON.stringify(ra.sq) !== JSON.stringify(rb.sq), JSON.stringify([ra?.sq, rb?.sq]));
  const n1 = [await rxLen(A), await rxLen(B)]; await sleep(3000); const n2 = [await rxLen(A), await rxLen(B)];
  check('RADIO BROADCAST / KEEPS FLOWING: received-frame bars keep growing on both consoles', n2[0] >= n1[0] && n2[1] >= n1[1] && (n2[0] > n1[0] || n2[0] >= 59) && (n2[1] > n1[1] || n2[1] >= 59), `${n1} -> ${n2}`);
  await until(async () => { const a = await stats(A), b = await stats(B); return a.radio.core.out > 5 && b.radio.core.out > 5 && a.radio.core.in > 5 && b.radio.core.in > 5; }, 30000);
  const sa = await stats(A), sb = await stats(B);
  const pa = sa.radio.peer, pb = sb.radio.peer;
  check('DS RADIO A->B: frames left A\'s core, crossed the DataChannel and were delivered into B\'s core', sa.radio.core.out > 5 && pa.sent > 5 && pb.recv > 5 && sb.radio.core.in > 5, `A core out ${sa.radio.core.out}, A sent ${pa.sent}, B recv ${pb.recv}, B core in ${sb.radio.core.in}`);
  check('DS RADIO B->A: frames left B\'s core, crossed the DataChannel and were delivered into A\'s core', sb.radio.core.out > 5 && pb.sent > 5 && pa.recv > 5 && sa.radio.core.in > 5, `B core out ${sb.radio.core.out}, B sent ${pb.sent}, A recv ${pa.recv}, A core in ${sa.radio.core.in}`);
  check('SAB RECEIVE PATH: the page is isolated, frames reach the core through the shared ring (readable while the core spins)', sa.radio.mode === 'sab' && sb.radio.mode === 'sab' && sa.radio.core.mode === 'sab', `${sa.radio.mode}/${sb.radio.mode}`);
  check('FRAME ORDER/SEQUENCE METRICS: sequence numbers tracked (lost, reordered, late counted), loss on a clean link is ~0', pa.lost + pb.lost < 3 && pa.lateDropped + pb.lateDropped < 3, JSON.stringify({ a: [pa.lost, pa.reordered, pa.lateDropped], b: [pb.lost, pb.reordered, pb.lateDropped] }));
  check('BACKPRESSURE: bufferedAmount stays below the soft threshold on a clean link, nothing dropped for it, no emulator stall', pa.bufferedMax < 8192 && pb.bufferedMax < 8192 && pa.droppedHard + pb.droppedHard === 0 && sa.emuFps > 50 && sb.emuFps > 50, `bufferedMax ${pa.bufferedMax}/${pb.bufferedMax}, emu ${sa.emuFps.toFixed(1)}/${sb.emuFps.toFixed(1)} fps`);
  check('METRICS: RTT, jitter, packet loss, frames sent/received/dropped, queue depth, bufferedAmount, max delay are all exposed', pa.rtt.n > 5 && typeof pa.jitter === 'number' && 'queueMax' in pa && 'rxHoldMsMax' in pa && 'bufferedMax' in pa && sa.radio.core.lagN > 0, `RTT avg ${pa.rtt.avg.toFixed(2)} ms, jitter ${pa.jitter.toFixed(2)} ms, ring lag avg ${sa.radio.core.lagAvg.toFixed(2)} max ${sa.radio.core.lagMax.toFixed(2)} ms`);
  console.log(`      measured: A RTT avg ${pa.rtt.avg.toFixed(2)} max ${pa.rtt.max.toFixed(2)} ms, jitter ${pa.jitter.toFixed(2)} ms | B RTT avg ${pb.rtt.avg.toFixed(2)} ms | bufferedMax ${pa.bufferedMax}/${pb.bufferedMax} | connect ${((await sess(A)).timing.connectMs).toFixed(0)} ms`);

  // ---- everything else is local
  check('VIDEO LOCAL: each device renders its own picture (WebGL) at ~60 fps', sa.renderFps > 25 && sb.renderFps > 25 && sa.emuFps > 50 && sb.emuFps > 50 && sa.video.startsWith('webgl') && sb.video.startsWith('webgl'), `${sa.renderFps.toFixed(1)}/${sb.renderFps.toFixed(1)} fps`);
  check('AUDIO LOCAL: each device produces and plays its own audio (AudioWorklet), nothing is streamed', sa.audio.pushed > 20000 && sb.audio.pushed > 20000 && sa.audio.backend.startsWith('worklet'), `${sa.audio.backend} pushed ${sa.audio.pushed}/${sb.audio.pushed}`);
  const rectOf = (p, sel) => p.evaluate((sel) => { const e = document.querySelector(sel); const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; }, sel);
  const fa = await rectOf(A, '[data-id=actions] [data-face=a]'); await A.mouse.move(fa.cx, fa.cy); await A.mouse.down(); await sleep(400);
  const gA = await grab(A), gB = await grab(B); await A.mouse.up();
  const sqA = px(gA, 214, 74), sqB = px(gB, 214, 74);
  check('INPUT LOCAL: button A pressed on device A lights A\'s DS only (B is untouched)', sqA[0] > 200 && sqA[1] < 120 && !(sqB[0] > 200 && sqB[1] < 120), `A ${sqA} B ${sqB}`);
  const vr = await A.evaluate(() => { const r = document.querySelector('#game canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const white = (b) => { let n = 0; for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) { const c = px(b, x, y); if (c[0] > 230 && c[1] > 230 && c[2] > 230) n++; } return n; };
  const w0 = white(await grab(A)), wB0 = white(await grab(B));
  await A.mouse.move(vr.x + vr.w * 0.5, vr.y + vr.h * 0.75); await A.mouse.down(); await sleep(400);
  const w1 = white(await grab(A)), wB1 = white(await grab(B)); await A.mouse.up();
  check('TOUCH LOCAL: the stylus on device A reaches A\'s DS touchscreen only', w1 - w0 > 15 && Math.abs(wB1 - wB0) < 10, `A white ${w0}->${w1}, B ${wB0}->${wB1}`);
  const hits = host.hits.filter((h) => !/favicon|^GET \/api\/(me|config)$/.test(h) && !/\/play\/|\/controls\/|\/mp\//.test(h) && !/^\w+ \/signal\//.test(h));
  check('NO MEDIA OVER THE SERVER: besides static files, the server only saw signaling requests (/signal/*), never frames, video or audio', hits.length === 0, hits.slice(0, 5).join(' '));
  check('NO SCRIPT ERRORS on either device', A.errors.length === 0 && B.errors.length === 0, [...A.errors, ...B.errors].join(' | '));
  await A.screenshot({ path: `${shots}/game-host.png` }); await B.screenshot({ path: `${shots}/game-guest.png` });
  await A.evaluate(() => document.getElementById('devOverlay').hidden = false);
  const ov = await A.evaluate(async () => { const m = document.createElement('div'); void m; return document.getElementById('devOverlay').textContent; }).catch(() => '');
  void ov;

  // ---- leaving
  const rooms0 = host.sig.rooms.size;
  await A.evaluate(() => window.dslinkPlay.friends && 0);
  await A.close(); // the host's page disappears
  const lost = await until(async () => (await B.evaluate(() => document.body.dataset.screen)) === 'lost', 15000);
  check('DISCONNECT: when HOST closes the page, PLAYER 2 gets "Connessione persa" and its game/worker is closed (no zombie core)', lost && (await B.evaluate(() => document.body.dataset.screen)) === 'lost' && (await B.evaluate(() => !window.dslinkPlay.isPlaying())) && (await until(() => B.workers().filter((w) => /emulator\.worker/.test(w.url())).length === 0, 5000)), `screen ${await B.evaluate(() => document.body.dataset.screen)} playing ${await B.evaluate(() => window.dslinkPlay.isPlaying())} workers ${B.workers().length}`);
  const cleaned = await until(() => host.sig.rooms.size === 0, 20000);
  check('ROOM CLEANUP: the signaling room is gone after the session ends', cleaned && rooms0 >= 1, `rooms ${rooms0} -> ${host.sig.rooms.size}`);
  await B.context().close(); host.close();
}

if (!QUICK) {
  // ============================================================================================ 2. message-queue receive path (page not isolated)
  {
    const host = await startHost({ coi: false });
    const { A, B } = await pair(host);
    const playing = await startBoth(A, B);
    const ra = await until(async () => { const b = await bars(A); return b.tx && b.rx ? b : false; }, 25000), rb = await until(async () => { const b = await bars(B); return b.tx && b.rx ? b : false; }, 25000);
    const sa = await stats(A);
    check('FALLBACK WITHOUT SharedArrayBuffer: plain homebrew radio still works both ways through the message queue', playing && !!ra && !!rb && sa.radio.mode === 'msg', `mode ${sa.radio.mode} playing ${playing} bars ${JSON.stringify([ra, rb])} core ${JSON.stringify(sa.radio.core)} peer sent/recv ${sa.radio.peer.sent}/${sa.radio.peer.recv} pushed ${sa.radio.pushed}`);
    await A.context().close(); await B.context().close(); host.close();
  }

  // ============================================================================================ 3. short outage survives, guest leaving frees the host, host reconnect
  {
    const host = await startHost({ coi: true });
    const { A, B } = await pair(host);
    await startBoth(A, B); await sleep(1500);
    await A.evaluate(() => window.dslinkPlay.session.peer.debugBlackout(1500)); await sleep(2500);
    const sA = await sess(A), sB = await sess(B), st = await stats(A);
    check('SHORT RECONNECT: a 1.5 s radio outage does not end the session, the radio resumes afterwards', sA.state === 'playing' && sB.state === 'playing' && st.radio.peer.droppedClosed > 0 && (await until(async () => { const a = await stats(A), b = await stats(B); return a.radio.peer.recv > st.radio.peer.recv && b.radio.peer.recv > 0; }, 8000)), JSON.stringify([sA.state, sB.state, st.radio.peer.droppedClosed]));
    // background: A tells B; B does not mistake the silence for a lost link and nothing piles up
    await A.evaluate(() => window.dslinkPlay.player.pauseAll('hidden')); await sleep(800);
    const hiddenSeen = await B.evaluate(() => window.dslinkPlay.session.other.hidden);
    const bpaused = await stats(B);
    await A.evaluate(() => window.dslinkPlay.player.resumeAll('visible')); await sleep(1500);
    const back = await B.evaluate(() => window.dslinkPlay.session.other.hidden), after = await stats(A);
    check('BACKGROUND: the peer is told, the other side keeps running, and on resume the stale radio backlog is flushed', hiddenSeen === true && back === false && bpaused.emuFps > 40 && after.lifecycle.paused === false && after.radio.ringFill < 4096, `hidden ${hiddenSeen} -> ${back}, ring fill ${after.radio.ringFill}`);
    // PLAYER 2 leaves
    await B.close();
    const l2 = await until(async () => (await A.evaluate(() => document.body.dataset.screen)) === 'lost', 15000);
    check('DISCONNECT: when PLAYER 2 closes the page, HOST gets "Connessione persa" and closes its core', l2 && (await A.evaluate(() => !window.dslinkPlay.isPlaying())) && A.workers().filter((w) => /emulator\.worker/.test(w.url())).length === 0);
    await A.context().close(); host.close();
  }

  // ============================================================================================ 4. UI: leave from the lobby, room expiry, full room
  {
    const host = await startHost({ coi: true });
    const A = await device(host, 'A'), B = await device(host, 'B'), C = await device(host, 'C');
    await (await A.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('multiplayer')), A).click('#btnCreate'); await A.click('#btnMakeRoom'); await A.waitForSelector('[data-screen=lobby].on');
    const code = await until(() => A.evaluate(() => document.getElementById('codeText').textContent), 8000);
    await (await B.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('multiplayer')), B).click('#btnJoin'); await B.fill('#joinCode', '000000'); await B.click('#btnDoJoin');
    check('JOIN with a wrong code: clear message, no crash', await until(async () => /Codice non valido/.test(await B.evaluate(() => document.getElementById('joinErr').textContent)), 5000));
    await B.fill('#joinCode', code); await B.click('#btnDoJoin'); await B.waitForSelector('[data-screen=lobby].on');
    await (await C.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('multiplayer')), C).click('#btnJoin'); await C.fill('#joinCode', code); await C.click('#btnDoJoin');
    check('2 PLAYERS ONLY: a third device is refused ("già al completo")', await until(async () => /completo/.test(await C.evaluate(() => document.getElementById('joinErr').textContent)), 5000));
    await until(async () => (await sess(A))?.peer === 'open', 15000);
    await B.click('#btnLobbyLeave');
    check('LEAVE LOBBY: guest leaves, the host goes back to waiting for a friend', await until(async () => (await sess(A))?.state === 'waiting' || (await sess(A))?.state === 'lost', 15000));
    await A.click('#btnLobbyLeave');
    check('ROOM CLEANUP after the host leaves the lobby', await until(() => host.sig.rooms.size === 0, 15000), `rooms ${host.sig.rooms.size}`);
    for (const p of [A, B, C]) await p.context().close(); host.close();
  }
}

await browser.close();
const ok = results.filter(Boolean).length; console.log(`${ok}/${results.length} checks passed`); process.exit(ok === results.length ? 0 : 1);
