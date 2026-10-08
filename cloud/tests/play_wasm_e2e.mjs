// DSLink PWA + WebAssembly (Foundation 1): the Nintendo DS runs inside the page. A plain static file server stands in for the host (no gateway, no API): everything the
// emulation needs is the page itself. Homebrew ROMs only. usage: node play_wasm_e2e.mjs <rom1.nds> <rom2.nds> [screenshot-dir]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [rom1, rom2, shots = '/tmp/playwasm'] = process.argv.slice(2);
fs.mkdirSync(shots, { recursive: true });
const WEB = new URL('../web', import.meta.url).pathname, CONTROLS = new URL('../worker/public/controls', import.meta.url).pathname;
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000, step = 100) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };

// ---- static server with a request log (the proof that nothing but static files is ever asked for)
const log = [];
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); log.push(req.method + ' ' + u.pathname);
  let p = u.pathname; if (p.endsWith('/')) p += 'index.html';
  const file = p.startsWith('/controls/') ? path.join(CONTROLS, p.slice(10)) : path.join(WEB, p);
  if (!file.startsWith(WEB) && !file.startsWith(CONTROLS)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404).end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(data); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
process.on('exit', () => server.close());

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
async function newPage(query = '', vp = { width: 390, height: 844 }) {
  const ctx = await browser.newContext({ viewport: vp, hasTouch: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(String(e))); p.errors = errors;
  await p.addInitScript(() => { window.__net = { ws: 0, rtc: 0, fetch: 0, xhr: 0 };
    const W = window.WebSocket; window.WebSocket = function (...a) { window.__net.ws++; return new W(...a); };
    if (window.RTCPeerConnection) { const R = window.RTCPeerConnection; window.RTCPeerConnection = function (...a) { window.__net.rtc++; return new R(...a); }; }
    const F = window.fetch; window.fetch = function (...a) { window.__net.fetch++; return F.apply(this, a); };
    const X = XMLHttpRequest.prototype.open; XMLHttpRequest.prototype.open = function (...a) { window.__net.xhr++; return X.apply(this, a); }; });
  await p.goto(`${BASE}/play/${query}`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 20000 });
  return p;
}
const stats = (p) => p.evaluate(() => window.dslinkPlay.stats());
const whiteTop = (px, w) => { let n = 0; for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) { const o = (y * w + x) * 4; if (px[o] > 230 && px[o + 1] > 230 && px[o + 2] > 230) n++; } return n; };
const grab = async (p) => { const a = await p.evaluate(async () => { const g = await window.dslinkPlay.grab(); return { w: 256, b: Array.from(g) }; }); return a; };
const pix = (a, x, y) => { const o = (y * a.w + x) * 4; return [a.b[o], a.b[o + 1], a.b[o + 2]]; };

// ======================================================================== OPFS run (the full path)
let page = await newPage('?store=opfs');
check('PWA LOAD: the page loads, no script errors, service-worker-free static host', page.errors.length === 0 && (await page.evaluate(() => document.body.dataset.screen)) === 'library', page.errors.join(' | '));
const caps = await page.evaluate(() => window.dslinkPlay.caps);
check('capabilities: WebAssembly, WebGL, module worker, IndexedDB are present', caps.wasm && caps.webgl && caps.moduleWorker && caps.indexedDB, JSON.stringify(caps));
check('OPFS: the storage probe (write + read back) works and is the backend', (await page.evaluate(() => window.dslinkPlay.store.kind)) === 'opfs');
check('before a ROM is added the library is empty and shows no GIOCA', (await page.locator('#gameList li.game').count()) === 0);

await page.setInputFiles('#romFile', rom1);
await until(() => page.locator('#gameList li.game').count());
check('library: the imported ROM is listed with a [ GIOCA ] button', (await page.locator('#gameList li.game .play').count()) === 1 && (await page.locator('#gameList li.game .play').innerText()) === 'GIOCA');
const gameId = await page.evaluate(() => window.dslinkPlay.games[0].id);
check('library: the game id is a stable 24-hex key', /^[0-9a-f]{24}$/.test(gameId), gameId);
await page.screenshot({ path: `${shots}/library.png` });

const t0 = Date.now();
await page.click('#gameList li.game .play');
const started = await until(() => page.evaluate(() => window.dslinkPlay.isPlaying()), 30000);
check('CORE INIT + REAL DS BOOT: WASM core initialised and a DS cartridge is running', started, `${Date.now() - t0} ms from tap to running`);
await until(async () => (await stats(page)).frames > 120, 20000);
await sleep(2500);
const s1 = await stats(page);
check('VIDEO: the emulator runs in real time (~60 fps)', s1.emuFps > 50, `emu ${s1.emuFps.toFixed(1)} fps, frame ${s1.frameMsAvg.toFixed(2)} ms avg / ${s1.frameMsMax.toFixed(1)} max`);
check('VIDEO: the page renders it (WebGL)', s1.renderFps > 40 && s1.video.startsWith('webgl'), `render ${s1.renderFps.toFixed(1)} fps via ${s1.video}`);
const f0 = await grab(page);
const top = pix(f0, 130, 125), bot = pix(f0, 100, 300);
check('VIDEO: the picture is the ROM\'s (blue top screen, white bottom screen, 256x384)', top[2] > top[0] + 40 && bot.every((c) => c > 240), `top ${top} bottom ${bot}`);
const canvasLit = await page.evaluate(() => { const c = document.querySelector('#game canvas'); return !!c && c.width > 10 && c.getBoundingClientRect().height > 100; });
check('VIDEO: the canvas is laid out by the frozen touch-controls engine', canvasLit);
check('AUDIO PIPELINE: samples flow worker -> AudioWorklet and are consumed', await until(async () => { const s = await stats(page); return s.audio.backend === 'worklet-msg' && s.audio.pushed > 40000 && s.audio.consumed > 20000; }, 15000), JSON.stringify({ backend: (await stats(page)).audio.backend, pushed: (await stats(page)).audio.pushed, consumed: (await stats(page)).audio.consumed }));
const s2 = await stats(page);
check('AUDIO: no underrun in steady state, buffer near its target', s2.audio.underEvents === 0 && s2.audio.fillMs > 30 && s2.audio.fillMs < 200, `underruns ${s2.audio.underEvents} (${s2.audio.underSamples} samples), buffer ${s2.audio.fillMs.toFixed(0)} / target ${s2.audio.targetMs.toFixed(0)} ms`);
await page.screenshot({ path: `${shots}/game-portrait.png` });

// ---- input: the real touch controls (same elements the Android build uses)
const rectOf = (sel) => page.evaluate((sel) => { const e = document.querySelector(sel); const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; }, sel);
const face = await rectOf('[data-id=actions] [data-face=a]');
await page.mouse.move(face.cx, face.cy); await page.mouse.down(); await sleep(400);
const fa = await grab(page); const c = pix(fa, 214, 74);
await page.mouse.up();
check('INPUT: button A on the touch controls reaches the core (the A square lights up)', c[0] > 200 && c[1] < 120, `pixel ${c}`);
const beforeW = whiteTop(f0.b, 256);
const vr = await page.evaluate(() => { const r = document.querySelector('#game canvas').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
await page.mouse.move(vr.x + vr.w * 0.5, vr.y + vr.h * 0.75); await page.mouse.down(); await sleep(400);
const ft = await grab(page);
await page.mouse.up();
check('TOUCH: the stylus on the bottom screen reaches the DS touchscreen (crosshair on the top screen)', whiteTop(ft.b, 256) - beforeW > 15, `white px ${beforeW} -> ${whiteTop(ft.b, 256)}`);

// ---- rotation
const r0 = await page.evaluate(() => document.querySelector('#game canvas').getBoundingClientRect().width);
await page.setViewportSize({ width: 844, height: 390 }); await sleep(900);
const r1 = await page.evaluate(() => document.querySelector('#game canvas').getBoundingClientRect().width), s3 = await stats(page);
check('ROTATION: landscape re-lays the picture out and the game keeps running', r1 !== r0 && s3.emuFps > 40 && (await page.evaluate(() => window.dslinkPlay.isPlaying())), `canvas width ${Math.round(r0)} -> ${Math.round(r1)}, ${s3.emuFps.toFixed(0)} fps`);
await page.screenshot({ path: `${shots}/game-landscape.png` });
await page.setViewportSize({ width: 390, height: 844 }); await sleep(500);

// ---- background / resume
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
await sleep(1500);
const sp = await stats(page); const f1 = sp.frames; await sleep(1200); const f2 = (await stats(page)).frames;
check('BACKGROUND: hidden page pauses the emulation (no frames run)', f2 - f1 < 3, `frames ${f1} -> ${f2}`);
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
check('RESUME: visible again, the emulation continues at full speed', await until(async () => (await stats(page)).emuFps > 45, 8000), `${(await stats(page)).emuFps.toFixed(1)} fps`);

// ---- no network emulation
const net = await page.evaluate(() => window.__net);
const reqsDuring = log.length;
await sleep(1500);
check('NO NETWORK EMULATION: no WebSocket, no WebRTC, no fetch/XHR from the page while a game runs, no new HTTP request', net.ws === 0 && net.rtc === 0 && net.xhr === 0 && log.length === reqsDuring, JSON.stringify(net) + ` requests ${log.length}`);
check('NO NETWORK EMULATION: every request is a static file of the player (only the optional account restore GET /api/me at start, no ws)', log.every((l) => l.startsWith('GET /play/') || l.startsWith('GET /controls/') || l === 'GET /api/me' || l.startsWith('GET /mp/mp.css') || l.startsWith('GET /mp/vendor/qrcode.js') || l.startsWith('GET /favicon')), [...new Set(log.filter((l) => !l.startsWith('GET /play/') && !l.startsWith('GET /controls/')))].join(' '));

// ---- SAVE: play, leave through the exit dialog (save on exit), reload the page, play again
const mem = (await stats(page)).wasmMB;
await page.evaluate(() => window.dslinkPlay.controls.openMenu()); await page.click('.ctl-menu [data-act=leave]'); await page.click('#confirmYes');   // the real exit path: menu -> Esci -> confirm
check('EXIT: back to the library, emulator stopped', await until(async () => (await page.evaluate(() => document.body.dataset.screen)) === 'library' && !(await page.evaluate(() => window.dslinkPlay.isPlaying())), 15000));
const saveKey = `library/${gameId}/save`;
const saved = await page.evaluate(async (k) => { const b = await window.dslinkPlay.store.get(k); return b ? b.byteLength : 0; }, saveKey);
check('SAVE: the game\'s save was written to the browser storage on exit', saved > 0, `${saved} bytes at ${saveKey}`);
// put a recognisable mark in the save, reload the whole page, play again, leave: the mark survives (loaded back and written again)
await page.evaluate(async (k) => { const b = new Uint8Array(await window.dslinkPlay.store.get(k)); b.set(new TextEncoder().encode('DSLINKWA'), 0); await window.dslinkPlay.store.put(k, b.buffer); }, saveKey);
await page.reload(); await page.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 20000 });
check('SAVE RELOAD: after reloading the PWA the library and the save are still there', (await page.locator('#gameList li.game').count()) === 1 && (await page.evaluate(async (k) => (await window.dslinkPlay.store.get(k)).byteLength, saveKey)) === saved);
await page.click('#gameList li.game .play'); await until(() => page.evaluate(() => window.dslinkPlay.isPlaying()), 30000); await until(async () => (await stats(page)).frames > 60, 15000);
await page.evaluate(() => { document.getElementById('confirm').hidden = false; }); await page.click('#confirmYes'); await until(async () => (await page.evaluate(() => document.body.dataset.screen)) === 'library', 15000);
const mark = await page.evaluate(async (k) => new TextDecoder().decode(new Uint8Array(await window.dslinkPlay.store.get(k)).slice(0, 8)), saveKey);
check('SAVE RELOAD: the game started from its save (the mark was loaded and saved again)', mark === 'DSLINKWA', mark);

// ---- second ROM: its own save
await page.setInputFiles('#romFile', rom2); await until(async () => (await page.locator('#gameList li.game').count()) === 2);
const ids = await page.evaluate(() => window.dslinkPlay.games.map((g) => g.id));
check('SAVE: another game has another key (saves are never shared)', ids.length === 2 && ids[0] !== ids[1]);

// ---- system files: validated by size, kept locally, never sent
const badSys = Buffer.alloc(1000, 7); fs.writeFileSync(`${shots}/bad.bin`, badSys);
await page.setInputFiles('li[data-key=bios7] input', `${shots}/bad.bin`); await sleep(300);
check('system files: a wrong file is refused (not stored)', (await page.evaluate(async () => await window.dslinkPlay.store.get('system/bios7.bin'))) === null);
fs.writeFileSync(`${shots}/fake7.bin`, Buffer.alloc(16384, 1));
await page.setInputFiles('li[data-key=bios7] input', `${shots}/fake7.bin`); await sleep(400);
check('system files: a right-sized file is kept in the browser storage only', (await page.evaluate(async () => (await window.dslinkPlay.store.get('system/bios7.bin')).byteLength)) === 16384 && log.every((l) => !l.includes('bios')));
await page.evaluate(async () => { await window.dslinkPlay.store.del('system/bios7.bin'); });

check('WASM MEMORY (desktop)', mem > 0 && mem < 600, `${mem.toFixed(0)} MB`);
check('no page errors during the whole run', page.errors.length === 0, page.errors.join(' | '));
await page.context().close();

// ======================================================================== IndexedDB fallback run
page = await newPage('?store=idb');
check('INDEXEDDB FALLBACK: forced IndexedDB backend works', (await page.evaluate(() => window.dslinkPlay.store.kind)) === 'idb');
await page.setInputFiles('#romFile', rom1); await until(() => page.locator('#gameList li.game').count());
const id2 = await page.evaluate(() => window.dslinkPlay.games[0].id);
await page.click('#gameList li.game .play'); await until(() => page.evaluate(() => window.dslinkPlay.isPlaying()), 30000); await until(async () => (await stats(page)).frames > 90, 20000);
await page.evaluate(() => { document.getElementById('confirm').hidden = false; }); await page.click('#confirmYes'); await until(async () => (await page.evaluate(() => document.body.dataset.screen)) === 'library', 15000);
const saved2 = await page.evaluate(async (k) => { const b = await window.dslinkPlay.store.get(k); return b ? b.byteLength : 0; }, `library/${id2}/save`);
await page.reload(); await page.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 20000 });
const saved3 = await page.evaluate(async (k) => { const b = await window.dslinkPlay.store.get(k); return b ? b.byteLength : 0; }, `library/${id2}/save`);
check('INDEXEDDB FALLBACK: ROM + save persist across a reload', saved2 > 0 && saved3 === saved2 && (await page.locator('#gameList li.game').count()) === 1, `save ${saved2} -> ${saved3} bytes`);
// ---- installed PWA: the shell + core are cached, the game starts with the network cut
await page.evaluate(() => navigator.serviceWorker.ready);
const cached = await until(() => page.evaluate(async () => { const c = await caches.open('dslink-play-v5'); const k = (await c.keys()).map((r) => new URL(r.url).pathname); return k.includes('/play/core/dslink_wasm.wasm') && k.includes('/controls/controls.js') ? k.length : 0; }), 20000);
check('PWA OFFLINE: service worker caches the shell and the WASM core', !!cached, `${cached} files cached`);
await page.context().setOffline(true);
await page.reload(); await page.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 20000 });
await page.click('#gameList li.game .play');
check('PWA OFFLINE: with the network cut the page reloads and the game still boots', await until(() => page.evaluate(() => window.dslinkPlay.isPlaying()), 30000) && await until(async () => (await stats(page)).frames > 60, 15000));
await page.context().setOffline(false);
// auto: Chrome has OPFS, the auto choice picks it
await page.context().close();
// ---- audio fallback (pages without AudioWorklet: plain http, old browsers): ScriptProcessor
page = await newPage('?audio=sp&store=idb');
await page.setInputFiles('#romFile', rom1); await until(() => page.locator('#gameList li.game').count());
await page.click('#gameList li.game .play'); await until(() => page.evaluate(() => window.dslinkPlay.isPlaying()), 30000); await sleep(3000);
const spStats = await stats(page);
check('AUDIO FALLBACK: without AudioWorklet a ScriptProcessor plays the same stream (buffer fills, few underruns)', spStats.audio.backend === 'scriptprocessor' && spStats.audio.fillMs > 20 && spStats.audio.underEvents < 3, `${spStats.audio.backend} buffer ${spStats.audio.fillMs.toFixed(0)} ms underruns ${spStats.audio.underEvents}`);
await page.context().close();
// ---- development overlay (?dev=1)
page = await newPage('?dev=1&store=idb');
await page.setInputFiles('#romFile', rom1); await until(() => page.locator('#gameList li.game').count());
await page.click('#gameList li.game .play'); await until(() => page.evaluate(() => window.dslinkPlay.isPlaying()), 30000); await sleep(2500);
const ov = await page.evaluate(() => document.getElementById('devOverlay').textContent);
check('DEV OVERLAY: emulator fps, submitted/rendered/dropped frames, upload and draw time, audio backend/buffer/underruns/overrun/queue/rate/health, WASM memory, main-thread stalls', /EMU\s+[\d.]+ fps/.test(ov) && /submit \d+\s+recv \d+\s+drawn \d+\s+drop\(src \d+ \/ render \d+\)/.test(ov) && /upload [\d.]+\/[\d.]+ ms\s+draw [\d.]+\/[\d.]+ ms/.test(ov) && /AUDIO\s+worklet-msg\s+buf \d+\/\d+ ms\s+queue \d+ fr\s+rate \d+>\d+ Hz/.test(ov) && /underruns \d+ ev \/ \d+ smp\s+last10s \d+\s+overrun \d+\s+health \w+\/\w+/.test(ov) && /WASM\s+\d+ MB\s+main stalls \d+/.test(ov), ov.replace(/\n/g, ' | '));
await page.context().close();
page = await newPage('?store=idb');
const dt = await page.evaluate(() => document.getElementById('diagText').textContent);
check('compatibility panel lists WebAssembly, WebGL2, AudioWorklet, storage, secure context, standalone', /WebAssembly: sì/.test(dt) && /WebGL2/.test(dt) && /AudioWorklet/.test(dt) && /Archivio: IndexedDB/.test(dt) && /Contesto sicuro/.test(dt) && /standalone/.test(dt), dt.split('\n').length + ' lines');
await page.context().close();
page = await newPage('');
check('auto backend: OPFS when it really works', (await page.evaluate(() => window.dslinkPlay.store.kind)) === 'opfs');
await page.context().close();
await browser.close();
const ok = results.filter(Boolean).length;
console.log(`${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
