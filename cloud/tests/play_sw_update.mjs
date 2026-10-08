// PWA update safety (phase 6), real Chrome + a static host that can switch between two builds: version A is running, version B is deployed at the SAME URL.
//  - a half-published B (one file missing) never installs and never replaces A;
//  - a complete B installs in the background and WAITS: the running game is not interrupted, nothing reloads, the page keeps A's JS and A's WebAssembly core together;
//  - the update bar appears only in the menus; AGGIORNA switches to B (JS and core of the same build), the old cache is gone, and B starts offline.
// usage: node play_sw_update.mjs <packaged-pwa-dir (build/pwa)> <rom.nds>
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [PKG, rom] = process.argv.slice(2);
const results = [];
const check = (n, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(150); } return false; };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function build(dir, id, marker) {
  fs.rmSync(dir, { recursive: true, force: true }); fs.cpSync(PKG, dir, { recursive: true });
  const sw = path.join(dir, 'play/sw.js'); fs.writeFileSync(sw, fs.readFileSync(sw, 'utf8').replace(/^const BUILD = "[^"]*";/m, `const BUILD = "${id}";`));
  fs.appendFileSync(path.join(dir, 'play/play.js'), `\nwindow.__appVersion = "${marker}";\n`);
}
build('/tmp/pwaA', 'aaaaaaaaaaaa', 'A'); build('/tmp/pwaB', 'bbbbbbbbbbbb', 'B');
let root = '/tmp/pwaA', missing = '';
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = u.pathname; if (p.endsWith('/')) p += 'index.html';
  if (missing && p.endsWith(missing)) { res.writeHead(404).end(); return; }
  fs.readFile(path.join(root, p), (e, d) => { if (e) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin', 'cache-control': p.endsWith('sw.js') ? 'no-cache, max-age=0' : 'no-store', 'content-length': d.length }); res.end(d); });
});
await new Promise((r) => srv.listen(8791, 'localhost', r));
const URL0 = 'http://localhost:8791/play/?stun=0';
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(String(e)));
const caches = () => p.evaluate(async () => (await window.caches.keys()).sort());
const ver = () => p.evaluate(() => window.__appVersion);
const swState = () => p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return { active: !!r.active, waiting: !!r.waiting, installing: !!r.installing, controlled: !!navigator.serviceWorker.controller }; });
const update = () => p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); try { await r.update(); } catch { /* a failed install rejects */ } });

await p.goto(URL0); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
await p.evaluate(async () => { await navigator.serviceWorker.ready; });
await p.reload(); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
check('VERSION A installed: controlled by its own service worker, one cache named after the build', (await ver()) === 'A' && (await swState()).controlled && JSON.stringify((await caches()).filter((k) => k.startsWith('dslink-play'))) === '["dslink-play-aaaaaaaaaaaa"]', JSON.stringify(await caches()));
await p.setInputFiles('#romFile', rom); await until(() => p.locator('#gameList li.game').count());
await p.locator('#gameList li.game button.play').click();
check('GAME running on version A', !!(await until(async () => await p.evaluate(() => window.dslinkPlay.isPlaying()), 40000)));
await p.evaluate(() => { window.__stay = 1; });

// 1. half-published version B: a file is missing -> it must not install, A stays
root = '/tmp/pwaB'; missing = 'cloudfiles.js';
await update(); await sleep(2500);
const broken = await swState();
check('INCOMPLETE UPDATE: B with a missing file does not install, no half-filled cache is left, A keeps running', !broken.waiting && !broken.installing && !(await caches()).includes('dslink-play-bbbbbbbbbbbb') && await p.evaluate(() => window.dslinkPlay.isPlaying()), JSON.stringify([broken, await caches()]));

// 2. complete B while the game runs
missing = ''; await update();
const waiting = await until(async () => (await swState()).waiting, 20000);
check('SERVICE WORKER UPDATE: the complete new version installs in the background and WAITS (it does not take over)', !!waiting && (await caches()).includes('dslink-play-bbbbbbbbbbbb') && (await caches()).includes('dslink-play-aaaaaaaaaaaa'));
const same = await p.evaluate(async () => ({ stay: window.__stay, ver: window.__appVersion, playing: window.dslinkPlay.isPlaying(), bar: !document.getElementById('updateBar').hidden, js: (await (await fetch('./play.js')).text()).includes('__appVersion = "A"'), core: (await (await fetch('./core/dslink_wasm.js')).text()).length }));
check('RUNNING SESSION UNTOUCHED: no reload, the game keeps playing, no update bar over the game, and every file still comes from version A (JS and WASM core of the same build)', same.stay === 1 && same.ver === 'A' && same.playing && !same.bar && same.js && same.core > 1000, JSON.stringify(same));
await sleep(1500);
check('STILL RUNNING after the update was ready (nothing swapped under the player)', await p.evaluate(() => window.dslinkPlay.isPlaying() && window.__stay === 1));

// 3. back to the menu: the update is offered
await p.evaluate(() => window.dslinkPlay.controls.openMenu()); await p.click('.ctl-menu [data-act=leave]'); await p.click('#confirmYes');
await until(async () => (await p.evaluate(() => document.body.dataset.screen)) === 'library', 20000);
check('UPDATE OFFERED in the menu: "Nuova versione ... AGGIORNA" appears only once the game is closed', !!(await until(async () => await p.evaluate(() => !document.getElementById('updateBar').hidden), 5000)));
await p.screenshot({ path: '/tmp/swupdate.png' });
const reload = p.waitForEvent('load', { timeout: 20000 }).catch(() => null);
await p.click('#btnUpdate'); await reload;
await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 25000 });
const after = await until(async () => (await ver()) === 'B', 15000);
const keys = (await caches()).filter((k) => k.startsWith('dslink-play'));
check('AGGIORNA: the page reloads on version B, the old cache is deleted, only B remains', !!after && JSON.stringify(keys) === '["dslink-play-bbbbbbbbbbbb"]', JSON.stringify(keys));
await p.locator('#gameList li.game button.play').click();
check('VERSION B plays: B\'s JS with B\'s core', !!(await until(async () => await p.evaluate(() => window.dslinkPlay.isPlaying()), 40000)));
await p.evaluate(() => window.dslinkPlay.controls.openMenu()); await p.click('.ctl-menu [data-act=leave]'); await p.click('#confirmYes'); await until(async () => (await p.evaluate(() => document.body.dataset.screen)) === 'library', 20000);

// 4. offline start of B straight from its own cache
await ctx.setOffline(true); await p.reload(); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 25000 });
await p.locator('#gameList li.game button.play').click();
check('OFFLINE: version B starts and plays with no network, from its own cache', (await ver()) === 'B' && !!(await until(async () => await p.evaluate(() => window.dslinkPlay.isPlaying()), 40000)));
check('NO SCRIPT ERRORS', errors.length === 0, errors.join(' | ').slice(0, 300));
await browser.close(); srv.close();
const ok = results.filter(Boolean).length; console.log(`${ok}/${results.length} checks passed`); process.exit(ok === results.length ? 0 : 1);
