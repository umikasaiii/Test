// DSLink PWA (Phase 4): the high-performance multiplayer mode (cross-origin isolation, SharedArrayBuffer radio ring) switched on by the service worker on a STATIC host that sends no COOP/COEP headers:
// room intent and role survive the reload; a QR (camera app -> .../play/?join=CODE) lands in the right room without asking for the code again.
// A static server + the signaling room (the same module the Worker uses) stand in for the host. Homebrew ROMs only.
// usage: node play_wasm_qr_isolation.mjs <rom1.nds> <rom2.nds> [screenshot-dir]
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

async function device(host, name, query = '', { sw = false, importRom = true } = {}) {
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
  await p.goto(`${host.base}/play/?stun=0${sw ? '' : '&nosw'}${query}`); if (!sw || !query.includes('join=')) { await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen !== undefined, null, { timeout: 20000 }); }
  if (importRom) { await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 20000 }); await p.setInputFiles('#romFile', romFile); await until(() => p.locator('#gameList li.game').count()); }
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


const iso = (p) => p.evaluate(() => ({ coi: !!self.crossOriginIsolated, sab: typeof SharedArrayBuffer === 'function', ctl: !!navigator.serviceWorker.controller }));
const host = await startHost({ coi: false });      // a plain static host: NO COOP/COEP headers
// ---- 1. HOST: CREA PARTITA on a non-isolated page -> the service worker turns the mode on, the page reloads once, the room is created with the chosen game, nothing asked again
const A = await device(host, 'A', '', { sw: true });
await A.evaluate(() => navigator.serviceWorker.ready); await sleep(500);
check('precondition: static host without COOP/COEP, page not isolated, service worker active', !(await iso(A)).coi && (await A.evaluate(() => !!navigator.serviceWorker.controller)));
let navs = 0; A.on('framenavigated', (f) => { if (f === A.mainFrame()) navs++; });
await A.click('#btnCreate'); await A.waitForSelector('[data-screen=friends-create].on');
const chosen = await A.evaluate(() => document.getElementById('friendGame').value);
await A.click('#btnMakeRoom');
const lobbyA = await until(async () => { try { return await A.evaluate(() => document.body.dataset.screen === 'lobby' && /^\d{6}$/.test(document.getElementById('codeText').textContent)); } catch { return false; } }, 25000);
const ia = await iso(A);
check('ISOLATION FLOW (host): one automatic reload, then the lobby with the room code - game selection and host role survived', lobbyA && ia.coi && ia.sab && navs >= 1 && navs <= 2 && (await A.evaluate(() => window.dslinkPlay.session.o.game.id)) === chosen, JSON.stringify({ navs, ...ia }));
check('the room was created ONCE (the reload happened before the network was used)', host.sig.stats.created === 1, JSON.stringify(host.sig.stats));
const code = await A.evaluate(() => document.getElementById('codeText').textContent);
check('NO LOOP: the reload happens once (a second visit does not reload again)', await A.evaluate(() => sessionStorage.getItem('dslink.coiTried') === '1' && sessionStorage.getItem('dslink.intent') === null));

// ---- 2. GUEST via QR: the camera app opens .../play/?join=CODE on a device that has never seen DSLink (no service worker yet)
const B = await device(host, 'B', `&join=${code}`, { sw: true, importRom: false });
const okB = await until(async () => { try { const s = await sess(B); return s && s.peer === 'open'; } catch { return false; } }, 40000);
const ib = await iso(B);
check('QR + ISOLATION FLOW (guest, first visit): the QR link lands in the room after enabling isolation, without asking for the code', okB && ib.coi && ib.sab, JSON.stringify({ ...ib, s: await sess(B) }));
check('the guest was never shown the join form asking for a code (the code came from the QR)', (await B.evaluate(() => document.body.dataset.screen)) === 'lobby');
check('the QR URL no longer carries the code after use (a reload does not re-join an old room)', !(await B.evaluate(() => location.search)).includes('join='));
const sa = await until(async () => (await sess(A))?.peer === 'open', 15000);
check('both devices connected in the same room; radio receive path is the SharedArrayBuffer ring', sa && host.sig.stats.joined === 1, JSON.stringify(await sess(A)));
// ---- 3. a device with the app already installed (service worker + library) opens the QR
const B2 = await device(host, 'B', '', { sw: true });
await B2.evaluate(() => navigator.serviceWorker.ready); await sleep(500);
await A.click('#btnLobbyLeave'); await sleep(1000);
await A.click('#btnCreate'); await A.click('#btnMakeRoom'); await A.waitForSelector('[data-screen=lobby].on'); const code2 = await until(() => A.evaluate(() => document.getElementById('codeText').textContent), 8000);
await B2.goto(`${host.base}/play/?stun=0&join=${code2}`);
const ok2 = await until(async () => { try { const s = await sess(B2); return s && s.peer === 'open'; } catch { return false; } }, 40000);
check('QR on an installed (not yet isolated) PWA: reload + join the right room automatically', ok2 && (await iso(B2)).coi, JSON.stringify(await sess(B2)));
// ---- 4. no service worker possible (insecure origin or blocked): the plain path keeps working and says so; Download-Play-class games are refused with the high-performance message
const C = await device(host, 'C', '&coi=0', { sw: false });
check('NO-SAB FALLBACK: with isolation unavailable the lobby still works (message-queue radio path)', !(await iso(C)).coi && (await C.evaluate(() => document.body.dataset.screen)) === 'library');
check('NO SCRIPT ERRORS', A.errors.length + B.errors.length + B2.errors.length + C.errors.length === 0, [...A.errors, ...B.errors].join(' | '));
for (const p of [A, B, B2, C]) await p.context().close(); host.close();
await browser.close();
const ok = results.filter(Boolean).length; console.log(`${ok}/${results.length} checks passed`); process.exit(ok === results.length ? 0 : 1);
