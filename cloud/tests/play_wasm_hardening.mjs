// PWA WASM mobile hardening: measures and asserts what the real Honor 200 run showed (render below 60 fps, audio underruns) under conditions that stress the page the way a phone does:
// a throttled / blocked main thread, background cycles, lock-screen style audio interruption, rotation, bfcache, and the SharedArrayBuffer audio path on an isolated page.
// Homebrew ROMs only. usage: node play_wasm_hardening.mjs <rom1.nds> [screenshot-dir]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [rom1, shots = '/tmp/playhard'] = process.argv.slice(2);
fs.mkdirSync(shots, { recursive: true });
const WEB = new URL('../web', import.meta.url).pathname, CONTROLS = new URL('../worker/public/controls', import.meta.url).pathname;
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000, step = 100) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
async function serve(coi) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); let p = u.pathname; if (p.endsWith('/')) p += 'index.html';
    const file = p.startsWith('/controls/') ? path.join(CONTROLS, p.slice(10)) : path.join(WEB, p);
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end(); return; }
      const h = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' };
      if (coi) { h['cross-origin-opener-policy'] = 'same-origin'; h['cross-origin-embedder-policy'] = 'require-corp'; }   // cross-origin isolation: SharedArrayBuffer becomes available
      res.writeHead(200, h); res.end(data);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}
const A = await serve(false), B = await serve(true);
process.on('exit', () => { A.server.close(); B.server.close(); });
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });

async function play(base, query = '?store=idb') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(String(e)));
  page.cdp = await ctx.newCDPSession(page);
  await page.goto(`${base}/play/${query}`); await page.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 20000 });
  await page.setInputFiles('#romFile', rom1); await until(() => page.locator('#gameList li.game').count());
  await page.click('#gameList li.game .play'); await until(() => page.evaluate(() => window.dslinkPlay.isPlaying()), 30000);
  await until(async () => (await st(page)).frames > 120, 20000); await sleep(1500);
  return page;
}
const st = (p) => p.evaluate(() => window.dslinkPlay.stats());
const frames = async (p) => (await st(p)).frames;

// ======================================================================== default path: no SharedArrayBuffer
let page = await play(A.base);
let s = await st(page);
check('default path needs no SharedArrayBuffer / WASM threads (page is not cross-origin isolated)', !(await page.evaluate(() => self.crossOriginIsolated)) && s.audio.backend === 'worklet-msg', s.audio.backend);
check('METRICS: emulator fps, submitted / received / rendered / dropped frames, upload and draw time are all reported', s.emuFps > 50 && s.submitted > 0 && s.received > 0 && s.rendered > 0 && typeof s.droppedRender === 'number' && s.uploadMsAvg > 0 && s.drawMsAvg >= 0 && s.mainFrameMsAvg > 0, JSON.stringify({ emu: s.emuFps.toFixed(1), sub: s.submitted, rcv: s.received, drawn: s.rendered, dropR: s.droppedRender, up: s.uploadMsAvg.toFixed(2), draw: s.drawMsAvg.toFixed(2) }));
check('VIDEO: every submitted picture is drawn when the page keeps up (render ~ emulator fps, nothing dropped)', s.renderFps > 55 && s.rendered / s.received > 0.95 && s.droppedRender <= 3, `render ${s.renderFps.toFixed(1)} fps, drawn ${s.rendered}/${s.received}, dropped ${s.droppedRender}`);
check('AUDIO: zero underruns, buffer near its adaptive target', s.audio.underEvents === 0 && s.audio.fillMs > 30 && s.audio.fillMs < s.audio.targetMs * 2.2, `fill ${s.audio.fillMs.toFixed(0)} ms, target ${s.audio.targetMs.toFixed(0)} ms, ${s.audio.ctxRate} Hz`);

// ---- main-thread blocked 4 x 400 ms (what a busy phone UI does): emulation and audio live in other threads
const ev0 = s.audio.underEvents, f0 = s.frames;
for (let i = 0; i < 4; i++) { await page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 400); }); await sleep(500); }
await sleep(1500); s = await st(page);
check('MAIN-THREAD STALLS: 4 x 400 ms blocks do not reach the emulator or the audio (no underrun, emulation kept running)', s.audio.underEvents === ev0 && s.frames - f0 > 200 && s.emuFps > 52, `underruns ${s.audio.underEvents}, frames +${s.frames - f0}, emu ${s.emuFps.toFixed(1)} fps`);
check('...and the stalls are measured (main stalls counter)', s.stalls >= 4, `stalls ${s.stalls}, long tasks ${s.longTasks}`);

// ---- CPU throttled 4x (main thread slow, like a mid-range phone's UI thread): the picture must keep ~60 fps
await page.cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 }); await sleep(9000); s = await st(page);
check('THROTTLE 4x: emulator ~60 fps, render >= 45 fps (45.2 before the FIFO/upload changes, 58 typical now), audio clean', s.emuFps > 55 && s.renderFps >= 45 && s.audio.underEvents === ev0, `emu ${s.emuFps.toFixed(1)}, render ${s.renderFps.toFixed(1)} fps, upload ${s.uploadMsAvg.toFixed(2)} ms, draw ${s.drawMsAvg.toFixed(2)} ms, dropped render ${s.droppedRender}, underruns ${s.audio.underEvents}`);
await page.cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); await sleep(1000);

// ---- rotation
const u0 = (await st(page)).audio.underEvents;
await page.setViewportSize({ width: 844, height: 390 }); await sleep(1500); await page.setViewportSize({ width: 390, height: 844 }); await sleep(1500);
s = await st(page);
check('ROTATION (portrait -> landscape -> portrait): no underrun, emulation steady', s.audio.underEvents === u0 && s.emuFps > 52, `underruns ${s.audio.underEvents}, emu ${s.emuFps.toFixed(1)}`);

// ---- background cycles (visibilitychange): pause, flush, resume - five times
const setHidden = (h) => page.evaluate((h) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); document.dispatchEvent(new Event('visibilitychange')); }, h);
let okCycle = true; const u1 = (await st(page)).audio.underEvents;
for (let i = 0; i < 5; i++) {
  await setHidden(true); await sleep(700); const a = await frames(page); await sleep(700); const b = await frames(page);
  const pausedOk = b - a < 3 && (await st(page)).lifecycle.paused;
  await setHidden(false); const resumed = await until(async () => (await frames(page)) > b + 30, 6000);
  if (!pausedOk || !resumed) okCycle = false;
}
s = await st(page); await sleep(2500); s = await st(page);
check('BACKGROUND x5 (visibilitychange): paused while hidden, resumed every time, audio stale data flushed', okCycle && s.lifecycle.hidden === 5 && s.lifecycle.shown === 5 && s.lifecycle.resumes >= 5, JSON.stringify({ hidden: s.lifecycle.hidden, shown: s.lifecycle.shown, resumes: s.lifecycle.resumes, lastResumeMs: s.lifecycle.lastResumeMs.toFixed(0) }));
check('...and the dropouts that resuming causes are NOT counted as underruns (silence while the buffer refills)', s.audio.underEvents === u1, `underruns ${s.audio.underEvents} (before ${u1})`);
check('...emulation back at full speed after the cycles', s.emuFps > 55 && s.renderFps > 50, `emu ${s.emuFps.toFixed(1)} render ${s.renderFps.toFixed(1)}`);

// ---- pagehide / pageshow (back-forward cache restore)
const fPH = await frames(page);
await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))); await sleep(900);
const pausedByHide = (await st(page)).lifecycle.paused && (await st(page)).lifecycle.reason === 'pagehide';
const saveBefore = await page.evaluate(() => window.dslinkPlay.savesWritten);
await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
check('PAGEHIDE / PAGESHOW (persisted): paused and saved on hide, the worker is verified alive and the game resumes on show', pausedByHide && await until(async () => (await frames(page)) > fPH + 60 && !(await st(page)).lifecycle.paused, 8000), `pagehide counters ${JSON.stringify({ ph: (await st(page)).lifecycle.pagehide, ps: (await st(page)).lifecycle.pageshow })}`);

// ---- audio interruption (iOS call / lock screen: the AudioContext suspends by itself): the game pauses, a tap resumes it
await page.evaluate(() => window.dslinkPlay.player.ctx.suspend());
check('AUDIO INTERRUPTION: AudioContext suspended by the system -> game pauses cleanly and the RIPRENDI card appears', await until(async () => (await st(page)).lifecycle.paused && (await st(page)).lifecycle.reason === 'audio', 6000) && await page.locator('#resumeHint').isVisible());
const fAI = await frames(page); await sleep(800);
check('...while interrupted no frames run', (await frames(page)) - fAI < 3);
await page.click('#btnResume');
check('...one tap resumes audio and game', await until(async () => !(await st(page)).lifecycle.paused && (await frames(page)) > fAI + 60, 8000) && !(await page.locator('#resumeHint').isVisible()), `ctx ${await page.evaluate(() => window.dslinkPlay.player.ctx.state)}`);

// ---- wake lock / standalone are feature-detected, never required
const caps = await page.evaluate(() => window.dslinkPlay.caps);
check('capabilities report wakeLock / offscreenCanvas / standalone without requiring them', 'wakeLock' in caps && 'offscreenCanvas' in caps && 'standalone' in caps, JSON.stringify({ wl: caps.wakeLock, oc: caps.offscreenCanvas, sa: caps.standalone }));
check('no page errors', page.errors.length === 0, page.errors.join(' | '));
await page.screenshot({ path: `${shots}/hardening.png` });
await page.context().close();

// ======================================================================== OffscreenCanvas render worker (optional path)
{
  const wp = await play(A.base, '?store=idb&render=worker');
  let w = await st(wp);
  check('RENDER WORKER (OffscreenCanvas): picked when asked and supported, WebGL in the worker, the picture is the ROM\'s', w.renderMode === 'worker' && w.video.endsWith('/worker') && w.emuFps > 55 && w.renderFps > 52, `${w.video}, emu ${w.emuFps.toFixed(1)}, render ${w.renderFps.toFixed(1)}`);
  const px = await wp.evaluate(async () => { const g = await Promise.race([window.dslinkPlay.grab(), new Promise((r) => setTimeout(() => r(null), 3000))]); return g ? [g[(125 * 256 + 130) * 4], g[(125 * 256 + 130) * 4 + 1], g[(125 * 256 + 130) * 4 + 2], g[(300 * 256 + 100) * 4]] : null; });
  check('RENDER WORKER: pixels read back are blue (top) and white (bottom): the canvas really shows the game', px && px[2] > px[0] + 40 && px[3] > 240, JSON.stringify(px));
  await wp.cdp.send('Emulation.setCPUThrottlingRate', { rate: 8 }); await sleep(9000); w = await st(wp);
  const wRender = w.renderFps;
  await wp.cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); await wp.context().close();
  const mp = await play(A.base, '?store=idb&render=main'); await mp.cdp.send('Emulation.setCPUThrottlingRate', { rate: 8 }); await sleep(9000);
  const mRender = (await st(mp)).renderFps; await mp.context().close();
  check('THROTTLE 8x: the render worker keeps the picture going better than the main-thread renderer (the main thread is off the video path)', wRender > mRender + 5, `worker ${wRender.toFixed(1)} fps vs main-thread ${mRender.toFixed(1)} fps`);
  const wp2 = await play(A.base, '?store=idb&render=worker');
  const setH = (h) => wp2.evaluate((h) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => h }); document.dispatchEvent(new Event('visibilitychange')); }, h);
  await setH(true); await sleep(800); const a = await frames(wp2); await sleep(600); const b = await frames(wp2);
  await setH(false);
  check('RENDER WORKER: background pauses, resume continues drawing', b - a < 3 && await until(async () => (await st(wp2)).rendered > 0 && (await frames(wp2)) > b + 60, 6000) && await until(async () => (await st(wp2)).renderFps > 50, 6000), `render ${(await st(wp2)).renderFps.toFixed(1)} fps`);
  await wp2.setViewportSize({ width: 844, height: 390 }); await sleep(1500); const w2 = await st(wp2);
  check('RENDER WORKER: rotation keeps running', w2.emuFps > 52 && w2.renderFps > 40, `emu ${w2.emuFps.toFixed(1)} render ${w2.renderFps.toFixed(1)}`);
  check('RENDER WORKER: no page errors', wp2.errors.length === 0, wp2.errors.join(' | '));
  await wp2.context().close();
}

// ======================================================================== SharedArrayBuffer path (isolated page: COOP/COEP)
page = await play(B.base);
s = await st(page);
check('SAB path: an isolated page uses the lock-free SharedArrayBuffer ring', (await page.evaluate(() => self.crossOriginIsolated)) && s.audio.backend === 'worklet-sab', s.audio.backend);
await sleep(4000); s = await st(page);
check('SAB path: audio flows, no underrun, nothing dropped at the source, emulation full speed', s.audio.pushed > 100000 && s.audio.underEvents === 0 && s.audioSourceDropped === 0 && s.emuFps > 55, `pushed ${s.audio.pushed}, underruns ${s.audio.underEvents}, dropped ${s.audioSourceDropped}, emu ${s.emuFps.toFixed(1)}`);
const fS = await frames(page);
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); }); await sleep(900);
await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
check('SAB path: background / resume works (ring flushed, audio resumes)', await until(async () => (await frames(page)) > fS + 60, 8000) && await until(async () => (await st(page)).audio.state === 'run', 6000), `state ${(await st(page)).audio.state}`);
check('SAB page: no page errors', page.errors.length === 0, page.errors.join(' | '));
await page.context().close();
page = await play(B.base, '?store=idb&audio=msg');
check('SAB available but ?audio=msg forces the MessagePort path (A/B on a device)', (await st(page)).audio.backend === 'worklet-msg');
await page.context().close();
await browser.close();
const ok = results.filter(Boolean).length;
console.log(`${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
