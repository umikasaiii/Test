// The PRODUCTION security headers, as the Worker serves them (wrangler dev --local with the packaged PWA): Content-Security-Policy, nosniff, referrer, permissions, COOP/COEP, and that the whole app
// (service worker, DS and PlayStation cores, workers, WebAssembly, themes) runs under them without a single violation. No Playwright bypassCSP here: this is the real thing.
// usage: node play_csp_worker.mjs <worker-base-url> <nds-homebrew.nds>
import { chromium } from 'playwright';
import { buildDiscs, files, until, sleep, reporter } from './ps1lib.mjs';
const [BASE, nds] = process.argv.slice(2);
if (!BASE || !nds) { console.error('usage: play_csp_worker.mjs <worker-url> <nds>'); process.exit(2); }
const { check, done } = reporter();
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
await ctx.addInitScript(() => { window.__csp = []; document.addEventListener('securitypolicyviolation', (e) => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); });
const p = await ctx.newPage(); const errors = [], consoleCsp = []; p.on('pageerror', (e) => errors.push(String(e))); p.on('console', (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) consoleCsp.push(m.text().slice(0, 120)); });
const r = await ctx.request.get(`${BASE}/play/`); const h = r.headers();
const csp = h['content-security-policy'] || '';
check('HEADERS: the app page carries a Content-Security-Policy that allows scripts from this origin only (+ WebAssembly), no inline script, no eval, no framing, no plugins', /default-src 'self'/.test(csp) && /script-src 'self' 'wasm-unsafe-eval'(;|$)/.test(csp) && !/script-src[^;]*'unsafe-(inline|eval)'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && /base-uri 'none'/.test(csp), csp.slice(0, 120));
check('HEADERS: nosniff, no referrer, permissions limited to camera and microphone (QR join, Party Voice), cross-origin isolation kept', h['x-content-type-options'] === 'nosniff' && h['referrer-policy'] === 'no-referrer' && /camera=\(self\)/.test(h['permissions-policy'] || '') && /microphone=\(self\)/.test(h['permissions-policy'] || '') && !/geolocation=\(self\)/.test(h['permissions-policy'] || '') && h['cross-origin-opener-policy'] === 'same-origin' && h['cross-origin-embedder-policy'] === 'require-corp');
const sw = await ctx.request.get(`${BASE}/play/sw.js`); check('HEADERS: the service worker is never cached by the host (always the freshest update check)', /no-cache|no-store/.test(sw.headers()['cache-control'] || ''));
await p.goto(`${BASE}/play/`); await until(async () => p.evaluate(() => !!window.dslinkPlay && document.body.dataset.screen === 'library'), 25000);
check('APP: the page starts under the CSP (library screen, no script error)', (await p.evaluate(() => document.body.dataset.screen)) === 'library' && !errors.length, errors.join('|'));
await until(async () => p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active); }), 20000);
check('APP: the service worker registers and activates under the CSP', await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active); }));
await p.evaluate(() => window.dslinkPlay.go('games')); await p.setInputFiles('#romFile', nds); await until(async () => p.evaluate(() => window.dslinkPlay.games.length === 1), 20000);
await p.click('li.game .play'); await until(async () => p.evaluate(() => window.dslinkPlay.isPlaying()), 40000); await sleep(2000);
check('APP: the Nintendo DS core (WebAssembly, module worker, audio worklet) runs under the CSP at full speed', await p.evaluate(() => window.dslinkPlay.stats().emuFps) > 45);
await p.evaluate(() => { document.getElementById('confirm').hidden = false; }); await p.click('#confirmYes'); await until(async () => p.evaluate(() => document.body.dataset.screen === 'library'), 15000);
const discs = buildDiscs(); await p.evaluate(() => window.dslinkPlay.go('games')); await p.setInputFiles('#romFile', files(discs, 'Test Game.cue', 'Test Game.bin')); await until(async () => p.evaluate(() => window.dslinkPlay.games.length === 2), 20000);
await p.click('li.game[data-platform=PS1] .play'); await p.waitForSelector('#hleBox:not([hidden])', { timeout: 20000 }); await p.click('#btnHleGo'); await until(async () => p.evaluate(() => window.dslinkPlay.isPlaying()), 40000); await sleep(2500);
check('APP: the PlayStation core (lazy-loaded WebAssembly) runs under the CSP at full speed', await p.evaluate(() => window.dslinkPlay.stats().emuFps) > 45);
await p.evaluate(() => { document.getElementById('confirm').hidden = false; }); await p.click('#confirmYes'); await until(async () => p.evaluate(() => document.body.dataset.screen === 'library'), 15000);
await p.evaluate(() => window.dslinkPlay.go('settings')); await p.click('[data-theme-set=light]'); await p.click('[data-theme-set=dark]');
const viol = await p.evaluate(() => window.__csp);
check('SECURITY: not one CSP violation across the whole session (page, service worker responses, both cores, workers, themes)', !viol.length && !consoleCsp.length, [...viol, ...consoleCsp].join(' | '));
const host = await ctx.newPage(); await host.setContent(`<iframe id=f src="${BASE}/play/" width=300 height=300></iframe>`); await sleep(2500);
const framed = host.frames().find((f) => f !== host.mainFrame());
check('SECURITY: the app cannot be framed by another site (clickjacking): the frame is refused', !framed || !/\/play\//.test(framed.url()) || framed.url().startsWith('chrome-error'), framed ? framed.url() : 'no frame');
await browser.close(); process.exit(done() ? 0 : 1);
