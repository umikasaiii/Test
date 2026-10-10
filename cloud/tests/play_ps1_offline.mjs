// PlaySphere PS1 offline + atomic versioning of the lazy core (FASE 8), real Chrome against the PACKAGED PWA (service worker active, cross-origin isolated like the real host).
//  - the PlayStation core is not in the install set: it is fetched at first use and stored with THIS version's cache (all three files together);
//  - after that a PlayStation game starts with the network completely off (core from the cache, disc and BIOS from the device);
//  - a new app version never mixes: it installs without the old core, the old cache goes away, and the core of the new build is fetched and cached on its first use.
// usage: node play_ps1_offline.mjs <packaged-pwa-dir (build/pwa)>
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { buildDiscs, files, grab, pix, LAYOUT, counterOf, near, until, sleep, reporter } from './ps1lib.mjs';

const [PKG] = process.argv.slice(2);
if (!PKG) { console.error('usage: play_ps1_offline.mjs <build/pwa>'); process.exit(2); }
const R = reporter(), { check } = R;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
function build(dir, id, marker) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.cpSync(PKG, dir, { recursive: true });
  const sw = path.join(dir, 'play/sw.js'); fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace(/^const BUILD = "[^"]*";/m, `const BUILD = "${id}";`));
  fs.appendFileSync(path.join(dir, 'play/play.js'), `\nwindow.__appVersion = "${marker}";\n`);
}
build('/tmp/pwaA', 'aaaaaaaaaaaa', 'A'); build('/tmp/pwaB', 'bbbbbbbbbbbb', 'B');
let root = '/tmp/pwaA'; const log = [];
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = u.pathname; if (p.endsWith('/')) p += 'index.html'; log.push(p);
  fs.readFile(path.join(root, p), (e, d) => { if (e) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin', 'cache-control': p.endsWith('sw.js') ? 'no-cache' : 'max-age=3600' }); res.end(d); });
});
await new Promise((r) => srv.listen(8792, 'localhost', r));
const dir = buildDiscs(), URL0 = 'http://localhost:8792/play/?stun=0';
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(String(e)));
const cacheKeys = () => p.evaluate(async () => { const out = {}; for (const k of await caches.keys()) out[k] = (await (await caches.open(k)).keys()).map((r) => new URL(r.url).pathname); return out; });
const ps1In = (list) => list.filter((x) => x.includes('/core/ps1/')).length;
const ver = () => p.evaluate(() => window.__appVersion);
async function boot() { await p.goto(URL0); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library'); await p.evaluate(async () => { await navigator.serviceWorker.ready; }); }
async function playPs1() { await p.click('li.game[data-platform=PS1] .play'); await p.waitForSelector('#hleBox:not([hidden])', { timeout: 20000 }); await p.click('#btnHleGo'); return until(() => p.evaluate(() => window.dslinkPlay.isPlaying()), 60000); }
async function leave() { const b = await p.locator('.ctl-c[data-id=menu] .ctl-pillbtn').boundingBox(); await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down(); await p.mouse.up(); await p.waitForSelector('.ctl-menu .sheet'); await p.evaluate(() => document.querySelector('.ctl-menu [data-act=leave]').click()); await p.waitForSelector('#confirmYes', { state: 'visible' }); await p.evaluate(() => document.querySelector('#confirmYes').click()); return until(async () => (await p.evaluate(() => document.body.dataset.screen)) === 'library', 20000); }

await boot(); await p.reload(); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
let k = await cacheKeys();
check('INSTALL: version A is installed (service worker active), the PlayStation core is NOT part of the install (nothing fetched, nothing cached for it)', (await ver()) === 'A' && Object.keys(k).includes('dslink-play-aaaaaaaaaaaa') && ps1In(k['dslink-play-aaaaaaaaaaaa']) === 0 && ps1In(log) === 0);
await p.setInputFiles('#romFile', files(dir, 'Test Game.cue', 'Test Game.bin')); await until(async () => (await p.evaluate(() => window.dslinkPlay.games.length)) === 1, 60000);
k = await cacheKeys();
check('LAZY CORE: the first PlayStation use fetches the core and stores loader + wasm + build-info TOGETHER in this version\'s cache', ps1In(k['dslink-play-aaaaaaaaaaaa']) === 3 && ps1In(log) === 3, JSON.stringify(k['dslink-play-aaaaaaaaaaaa'].filter((x) => x.includes('ps1'))));
const up1 = await playPs1(); await sleep(3500); const f1 = await grab(p);
check('PS1 online first run (HLE chosen explicitly): boots, memory card counter 1', up1 && counterOf(f1) === 1);
await leave();

// ---- offline: the whole thing works with no network
const before = log.length; await ctx.setOffline(true);
await p.reload().catch(() => {}); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 20000 });
check('OFFLINE: the app itself opens with the network off (service worker cache)', (await p.evaluate(() => navigator.onLine)) === false);
const up2 = await playPs1(); await sleep(3500); const f2 = await grab(p);
check('PS1 OFFLINE: a PlayStation game starts and runs with NO network (core from the cache, disc / memory card / BIOS choice from the device)', up2 && near(pix(f2, ...LAYOUT.header), [0, 121, 57]) && counterOf(f2) === 2 && ps1In(log.slice(before)) === 0, 'counter ' + counterOf(f2));
await leave(); await ctx.setOffline(false);

// ---- a new version: no mixing
root = '/tmp/pwaB';
await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); try { await r.update(); } catch { /* none */ } });
const waiting = await until(() => p.evaluate(async () => !!(await navigator.serviceWorker.getRegistration()).waiting), 20000);
k = await cacheKeys();
check('VERSION B waits and installs WITHOUT the PlayStation core (it is lazy), version A\'s cache still has its own', !!waiting && ps1In(k['dslink-play-bbbbbbbbbbbb']) === 0 && ps1In(k['dslink-play-aaaaaaaaaaaa']) === 3);
await p.evaluate(() => { const b = document.getElementById('btnUpdate'); if (b) b.click(); else navigator.serviceWorker.getRegistration().then((r) => r.waiting && r.waiting.postMessage({ t: 'skip' })); });
await p.waitForFunction(() => window.__appVersion === 'B' && window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 25000 });
k = await cacheKeys();
check('UPDATE: version B is active, version A\'s cache is deleted (its core with it)', (await ver()) === 'B' && !Object.keys(k).includes('dslink-play-aaaaaaaaaaaa') && Object.keys(k).includes('dslink-play-bbbbbbbbbbbb'));
const mark = log.length; const up3 = await playPs1(); await sleep(3500);
k = await cacheKeys();
check('NO MIXING: version B fetched ITS OWN core on first use and cached it with ITS cache (old JS never meets a new core, new JS never meets the old one)', up3 && ps1In(log.slice(mark)) === 3 && ps1In(k['dslink-play-bbbbbbbbbbbb']) === 3, `requests after update: ${ps1In(log.slice(mark))}`);
await leave();
check('NO SCRIPT ERRORS on the page', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); srv.close();
process.exit(R.done() ? 0 : 1);
