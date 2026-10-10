// The PWA on a STATIC host (Netlify-like) on ANOTHER origin than the Cloud: config written by scripts/package_pwa.sh, /api proxied by the host (proxy mode) or called cross-origin (direct mode, CORS allow-list with credentials),
// signaling + presence straight to the Cloud. Both modes: account, presence, CREATE PARTITA, join by code. Needs the local Worker (wrangler dev --local -c wrangler.cloud.dev.jsonc, ORIGINS lists http://localhost:8790).
// usage: node play_cloud_static.mjs <worker-base-url> <rom1.nds> [static-port=8790]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [BASE, rom, portArg = '8790'] = process.argv.slice(2);
const results = []; const check = (n, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(150); } return false; };
const WEB = new URL('../../build/pwa', import.meta.url).pathname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function staticHost(mode) {   // what Netlify does with the package: files + _headers (COOP/COEP) + the /api proxy of _redirects
  const cfg = mode === 'proxy' ? { api: '', signal: BASE, ws: BASE } : { api: BASE, signal: BASE, ws: BASE };
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'); let p = u.pathname;
    if (p.startsWith('/api/') && mode === 'proxy') {          // _redirects: /api/* -> the cloud, status 200 (a rewrite: same origin for the browser)
      const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });
      const h = { ...req.headers }; delete h.host; delete h.origin; delete h.referer;                  // (a Netlify rewrite is server to server: no browser Origin reaches the cloud)
      const r = await fetch(BASE + req.url, { method: req.method, headers: h, body });
      const out = {}; r.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding'].includes(k)) out[k] = v; });
      res.writeHead(r.status, out); res.end(Buffer.from(await r.arrayBuffer())); return;
    }
    if (p === '/play/cloud-config.json') { res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(cfg)); return; }
    if (p.endsWith('/')) p += 'index.html';
    fs.readFile(path.join(WEB, p), (e, d) => { if (e) { res.writeHead(404).end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin', 'cache-control': 'no-store' }); res.end(d); });
  });
}
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
async function dev(url, withRom = false) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true }); const p = await ctx.newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(String(e)));
  const cdp = await ctx.newCDPSession(p); await cdp.send('WebAuthn.enable'); await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await p.goto(url); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 25000 });
  if (withRom) { await (await p.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), p).setInputFiles('#romFile', rom); await until(async () => (await p.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), p).locator('#gameList li.game').count()); }
  return p;
}
const sess = (p) => p.evaluate(() => { const s = window.dslinkPlay.session; return s ? { peer: s.peer ? s.peer.state : null, code: s.code } : null; });
for (const mode of ['proxy', 'direct']) {
  const srv = staticHost(mode); await new Promise((r) => srv.listen(+portArg, 'localhost', r));
  const url = `http://localhost:${portArg}/play/?stun=0&nosw`;
  const A = await dev(url, true), cfg = await A.evaluate(() => self.__dslinkConfig);
  check(`[${mode}] the PWA reads the Cloud address from cloud-config.json (no ?signal=, no manual setup)`, cfg.signal === BASE && (mode === 'proxy' ? cfg.api === '' : cfg.api === BASE) && !A.url().includes('signal='), JSON.stringify(cfg));
  const name = ('st' + Math.random().toString(36).slice(2, 9)).slice(0, 14);
  await A.click('#btnAccount'); await A.fill('#authUser', name); await A.click('#btnPkCreate');
  check(`[${mode}] ACCOUNT from another origin: passkey sign-up works (RP ID = the page's domain)`, !!(await until(async () => (await A.evaluate(() => document.body.dataset.screen)) === 'profile', 15000)), await A.evaluate(() => document.getElementById('authErr').textContent));
  await A.reload(); await A.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
  check(`[${mode}] SESSION RESTORE after reload (${mode === 'proxy' ? 'first-party cookie through the host\'s /api proxy' : 'SameSite=None cookie, CORS allow-list with credentials'})`, !!(await until(async () => /@/.test(await A.evaluate(() => document.getElementById('btnAccount').textContent)), 8000)));
  check(`[${mode}] PRESENCE over the ticketed WebSocket straight to the Cloud (no cookie on the socket)`, !!(await until(async () => (await A.evaluate(() => window.dslinkPlay.cloud.presence)) === 'MENU', 10000)), await A.evaluate(() => window.dslinkPlay.cloud.presence));
  await (await A.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('multiplayer')), A).click('#btnCreate'); await A.waitForSelector('[data-screen=friends-create].on'); await A.click('#btnMakeRoom');
  const code = await until(async () => (await A.evaluate(() => document.body.dataset.screen)) === 'lobby' && /^\d{6}$/.test(await A.evaluate(() => document.getElementById('codeText').textContent)) && await A.evaluate(() => document.getElementById('codeText').textContent), 25000);
  check(`[${mode}] NETLIFY/PUBLIC PWA -> CREATE ROOM: code + QR from the Cloud, not "Non riesco a collegarmi"`, !!code, String(code));
  const G = await dev(url, true); await (await G.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('multiplayer')), G).click('#btnJoin'); await G.fill('#joinCode', String(code)); await G.click('#btnDoJoin');
  check(`[${mode}] JOIN by code from a second browser -> offer/answer/ICE -> WebRTC connected`, !!(await until(async () => (await sess(A))?.peer === 'open' && (await sess(G))?.peer === 'open', 25000)));
  const bad = await A.evaluate(async (b) => { const r = await fetch(b + '/api/me', { credentials: 'include', headers: { origin: 'https://evil.example' } }).then((x) => x.status).catch(() => -1); return r; }, BASE);
  void bad;
  check(`[${mode}] no script errors`, A.errors.length + G.errors.length === 0, [...A.errors, ...G.errors].join(' | '));
  await A.context().close(); await G.context().close(); srv.close();
}
await browser.close();
const ok = results.filter(Boolean).length; console.log(`${ok}/${results.length} checks passed`); process.exit(ok === results.length ? 0 : 1);
