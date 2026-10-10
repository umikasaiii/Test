// Shared helpers of the PlaySphere PS1 / multi-core tests: a static server standing in for the host, the redistributable test discs (tools/ps1/mkdisc.py), picture readers.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const ROOT = new URL('../..', import.meta.url).pathname;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const until = async (f, ms = 15000, step = 100) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return null; };
export function reporter() {
  const results = [];
  const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); return !!ok; };
  return { check, results, done() { const p = results.filter(Boolean).length; console.log(`${p}/${results.length} checks passed`); return p === results.length; } };
}

/** the test discs: single (bin/cue + chd), multi disc (m3u), PAL; built once per run into a temp dir */
export function buildDiscs(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps1discs-'))) {
  const mk = (...a) => execFileSync('python3', ['-I', path.join(ROOT, 'tools/ps1/mkdisc.py'), '--out', dir, ...a], { stdio: ['ignore', 'pipe', 'inherit'] });
  mk('--name', 'Test Game', '--chd');
  mk('--name', 'Two Disc Game', '--discs', '2');
  mk('--name', 'Pal Game', '--pal');
  return dir;
}

/** static host: /play -> cloud/web/play, /controls -> the frozen controls, everything else under cloud/web. `log` records every request path. */
export async function staticServer({ coi = false } = {}) {
  const WEB = path.join(ROOT, 'cloud/web'), CONTROLS = path.join(ROOT, 'cloud/worker/public/controls'), log = [];
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x'); log.push(u.pathname);
    let p = decodeURIComponent(u.pathname); if (p.endsWith('/')) p += 'index.html';
    const file = p.startsWith('/controls/') ? path.join(CONTROLS, p.slice(10)) : path.join(WEB, p);
    if (!file.startsWith(WEB) && !file.startsWith(CONTROLS)) { res.writeHead(403).end(); return; }
    fs.readFile(file, (err, data) => { if (err) { res.writeHead(404).end(); return; } const h = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' }; if (coi) { h['cross-origin-opener-policy'] = 'same-origin'; h['cross-origin-embedder-policy'] = 'require-corp'; } res.writeHead(200, h); res.end(data); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, log, close: () => server.close() };
}
export const launch = () => chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
export async function openApp(browser, base, query = '', vp = { width: 390, height: 844 }, ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: vp, hasTouch: true, deviceScaleFactor: 2, ...ctxOpts });
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(String(e))); p.errors = errors;
  await p.goto(`${base}/play/${query}`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 20000 });
  return p;
}
export const files = (dir, ...names) => names.map((n) => path.join(dir, n));

// ---- reading what the test program painted (tools/ps1/testgame/main.c): fixed layout on a 320 x 240 picture
export const LAYOUT = { header: [4, 4], frameSq: [304, 16], pad: [16, 64], mc: [16, 158], counter: (i) => [15 + i * 16, 177], disc: (i) => [15 + i * 16, 207], discMark: [207, 207], button: (i) => [16 + i * 19, 40], bar: (i) => [8, 86 + i * 18], button2: (i) => [12 + i * 10, 220], pad2: [176, 220] };
/** PlayStation pad word bit positions of the 16 button squares */
export const PSX = { select: 0, l3: 1, r3: 2, start: 3, up: 4, right: 5, down: 6, left: 7, l2: 8, r2: 9, l1: 10, r1: 11, triangle: 12, circle: 13, cross: 14, square: 15 };
/** next picture as {w,h,px(RGBA)} */
export async function grab(page) { const r = await page.evaluate(async () => { const g = await window.dslinkPlay.grab(); return { w: g.w, h: g.h, data: Array.from(g) }; }); return { w: r.w, h: r.h, px: Uint8Array.from(r.data) }; }
export const pix = (f, x, y) => { const sx = Math.round(x * f.w / 320), sy = Math.round(y * f.h / 240), o = (sy * f.w + sx) * 4; return [f.px[o], f.px[o + 1], f.px[o + 2]]; };
export const near = (a, b, t = 40) => Math.abs(a[0] - b[0]) < t && Math.abs(a[1] - b[1]) < t && Math.abs(a[2] - b[2]) < t;
/** length in picture pixels of a bar (cyan 0,200,255) on row y */
export const barLen = (f, y) => { let n = 0; for (let x = 8; x < 300; x++) if (near(pix(f, x, y), [0, 200, 255], 50)) n++; return n; };
export const buttons2 = (f) => Array.from({ length: 16 }, (_, i) => near(pix(f, ...LAYOUT.button2(i)), [255, 255, 255], 60));
export const padType = (f, at = LAYOUT.pad) => { const c = pix(f, ...at); return near(c, [0, 255, 0], 60) ? 'analog' : near(c, [255, 255, 0], 60) ? 'digital' : near(c, [255, 0, 0], 60) ? 'none' : 'unknown'; };
export const buttons = (f) => Array.from({ length: 16 }, (_, i) => near(pix(f, ...LAYOUT.button(i)), [255, 255, 255], 60));
export const counterOf = (f) => { let n = 0; for (let i = 0; i < 16; i++) if (near(pix(f, ...LAYOUT.counter(i)), [255, 140, 0], 60)) n++; return n; };
export const discOf = (f) => { let n = 0; for (let i = 0; i < 4; i++) if (near(pix(f, ...LAYOUT.disc(i)), [80, 120, 255], 60)) n++; return n; };
