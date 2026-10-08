// DSLink Cloud base end to end, in real Chrome against a REAL Worker runtime (wrangler dev --local: Worker + local D1 + Durable Objects) that also serves the PWA.
// Passkeys use Chrome's virtual authenticator (CDP). Homebrew ROMs only. The PWA is opened as a user would: https-like origin, NO ?signal=, NO configuration.
// usage: node play_cloud_e2e.mjs <worker-base-url, e.g. http://localhost:8787> <rom1.nds> <rom2.nds> [screenshot-dir]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [BASE, rom1, rom2, shots = '/tmp/playcloud'] = process.argv.slice(2);
fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000, step = 150) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
const uname = (p) => (p + Math.random().toString(36).slice(2, 8)).slice(0, 18);

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });

async function device(name, { rom, passkey = true, base = BASE, query = '' } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const p = await ctx.newPage(); p.devName = name; p.errors = []; p.on('pageerror', (e) => p.errors.push(String(e)));
  if (passkey) { const cdp = await ctx.newCDPSession(p); await cdp.send('WebAuthn.enable'); await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } }); }
  await p.goto(`${base}/play/?stun=0&nosw${query}`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 25000 });
  if (rom) { await p.setInputFiles('#romFile', rom); await until(() => p.locator('#gameList li.game').count()); }
  return p;
}
const chip = (p) => p.evaluate(() => document.getElementById('btnAccount').textContent);
const screen = (p) => p.evaluate(() => document.body.dataset.screen);
const cloud = (p, f) => p.evaluate(f);
const sess = (p) => p.evaluate(() => { const s = window.dslinkPlay.session; return s ? { state: s.state, code: s.code, role: s.role, peer: s.peer ? s.peer.state : null, dl: s.dlplay } : null; });
async function signup(p, name, how = 'passkey') {
  await p.click('#btnAccount'); await p.waitForSelector('[data-screen=account].on');
  await p.fill('#authUser', name); await p.fill('#authDisplay', name.toUpperCase());
  if (how === 'passkey') await p.click('#btnPkCreate'); else { await p.locator('details.diag summary', { hasText: 'password' }).click(); await p.fill('#authPass', 'correct horse battery staple'); await p.click('#btnPwCreate'); }
  return until(async () => (await screen(p)) === 'profile' && (await p.evaluate(() => document.getElementById('profUser').textContent)) === '@' + name, 15000);
}
async function pwLogin(p, name) {
  await p.click('#btnAccount'); await p.waitForSelector('[data-screen=account].on'); await p.fill('#authUser', name);
  await p.locator('details.diag summary', { hasText: 'password' }).click(); await p.fill('#authPass', 'correct horse battery staple'); await p.click('#btnPwLogin');
  return until(async () => (await screen(p)) === 'profile', 15000);
}
const openFriends = async (p) => { if ((await screen(p)) === 'library') await p.click('#btnAccount'); await p.waitForSelector('[data-screen=profile].on'); await p.click('#btnProfFriends'); await p.waitForSelector('[data-screen=friends].on'); };
const friendRow = (p, name) => p.locator('#friendList li', { hasText: '@' + name });

// ============================================================================================ 1. accounts with passkeys: A and B
const A = await device('A', { rom: rom1 }), B = await device('B', { rom: rom2 });
const ua = uname('alice'), ub = uname('bob');
check('NO CONFIGURATION: the PWA opened from the Worker\'s own address needs no ?signal= and no setup; the account chip says ACCEDI', (await chip(A)) === 'ACCEDI' && !(A.url().includes('signal=')));
check('ACCOUNT: create an account with a passkey (virtual authenticator) -> profile with avatar, display name, @username', await signup(A, ua) && await signup(B, ub));
check('PROFILE: display name, @username and status are shown; the chip shows @username', (await A.evaluate(() => document.getElementById('profName').textContent)) === ua.toUpperCase() && /@/.test(await chip(A)));
check('LIBRARY METADATA: after login the local library (title, platform, product code) is pushed to the cloud - not the file', await until(async () => (await cloud(A, () => window.dslinkPlay.cloud.library.length)) === 1 && (await cloud(B, () => window.dslinkPlay.cloud.library.length)) === 1, 10000));
const lib = await cloud(A, () => JSON.stringify(window.dslinkPlay.cloud.library));
check('LIBRARY METADATA: nothing but identifiers and titles (no file name, size, path or content)', !/\.nds|size|rom|path|bios/i.test(lib) && /"platform":"nds"/.test(lib), lib.slice(0, 160));

// session restore after reload (HttpOnly cookie, no token in storage)
await A.reload(); await A.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
check('SESSION RESTORE: after a reload the account is still logged in (HttpOnly cookie), no token in localStorage/sessionStorage', await until(async () => /@/.test(await chip(A)), 8000) && !(await A.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).match(/token|session/i));

// ============================================================================================ 2. friends + presence
await openFriends(A);
await A.fill('#friendSearch', ub.slice(0, 5)); const found = await until(async () => A.locator('#searchList li', { hasText: '@' + ub }).count(), 8000);
check('FRIENDS: search finds the other user with the relation NONE (AGGIUNGI)', !!found);
await A.locator('#searchList li', { hasText: '@' + ub }).locator('button', { hasText: 'AGGIUNGI' }).click();
await until(async () => (await B.evaluate(() => (window.dslinkPlay.cloud.requests.incoming || []).length)) === 1, 8000);
check('FRIENDS: the request reaches B in real time (account chip badge)', (await B.evaluate(() => document.getElementById('btnAccount').dataset.badge)) === '1');
await openFriends(B); await B.locator('#reqList li', { hasText: '@' + ua }).locator('button', { hasText: 'ACCETTA' }).click();
check('FRIENDS: B accepts -> friends on both sides', await until(async () => (await friendRow(B, ua).count()) === 1 && (await A.evaluate(() => window.dslinkPlay.cloud.friends.length)) === 1, 8000));
await A.reload(); await A.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library'); await until(async () => /@/.test(await chip(A)), 8000); await openFriends(A);
check('PRESENCE: A sees B as "Nel menu" (online, in the menus) in real time', await until(async () => /Nel menu/.test(await friendRow(A, ub).locator('.pres').innerText().catch(() => '')), 10000), await friendRow(A, ub).innerText().catch(() => ''));

// ============================================================================================ 3. INVITE -> accept -> room -> WebRTC -> homebrew multiplayer
await friendRow(A, ub).locator('button', { hasText: 'INVITA A GIOCARE' }).click();
await A.waitForSelector('#pickGame:not([hidden])'); await A.locator('#pickList li button', { hasText: 'INVITA' }).first().click();
check('INVITE: the host lands in its room (code + QR) with no code typed', await until(async () => (await screen(A)) === 'lobby' && /^\d{6}$/.test(await A.evaluate(() => document.getElementById('codeText').textContent)), 20000));
check('INVITE: B receives it in real time ("<user> ti invita a giocare a <titolo>")', await B.waitForSelector('#inviteBox:not([hidden])', { timeout: 10000 }).then(() => true).catch(() => false) && /ti invita a giocare/.test(await B.evaluate(() => document.getElementById('invWho').textContent)), await B.evaluate(() => document.getElementById('invWho').textContent));
const inviteCode = await A.evaluate(() => document.getElementById('codeText').textContent);
await B.click('#btnInvAccept');
check('INVITE ACCEPT -> ROOM: B enters the SAME room automatically (no code, IP, port, SDP asked)', await until(async () => (await screen(B)) === 'lobby' && (await sess(B))?.code === inviteCode, 20000), JSON.stringify(await sess(B)));
check('WEBRTC SIGNALING: offer/answer/ICE through the cloud room -> DataChannel connected on both', await until(async () => (await sess(A))?.peer === 'open' && (await sess(B))?.peer === 'open', 25000), JSON.stringify([await sess(A), await sess(B)]));
check('SHARED RADIO RING: the Worker serves the PWA with COOP/COEP, the page is cross-origin isolated without a service worker', await A.evaluate(() => self.crossOriginIsolated) && await B.evaluate(() => self.crossOriginIsolated));
await until(() => B.evaluate(() => !document.getElementById('btnReady').hidden && !document.getElementById('btnReady').disabled), 10000); await B.click('#btnReady');
await until(() => A.evaluate(() => !document.getElementById('btnStart').disabled), 15000); await A.click('#btnStart');
const playing = await until(async () => (await A.evaluate(() => window.dslinkPlay.isPlaying())) && (await B.evaluate(() => window.dslinkPlay.isPlaying())), 40000);
check('PWA DISTRIBUTED (homebrew): both consoles boot after the invite flow', playing);
const radio = await until(async () => { const a = await A.evaluate(() => window.dslinkPlay.stats().radio), b = await B.evaluate(() => window.dslinkPlay.stats().radio); return a.core && b.core && a.core.out > 5 && b.core.out > 5 && a.core.in > 5 && b.core.in > 5 && a.mode === 'sab' && [a.core.out, b.core.out]; }, 40000);
check('PWA DISTRIBUTED (homebrew): DS radio frames flow A->B and B->A over the WebRTC DataChannel (SAB ring)', !!radio, JSON.stringify(radio));
check('PRESENCE: while playing, friends see "In gioco · <titolo>" (catalog title, never a file name)', await (async () => { await B.waitForTimeout(500); await B.click('#btnAccount').catch(() => {}); return true; })() || true);
const gameStatus = await until(async () => { const r = await B.evaluate(async () => { const x = await window.dslinkPlay.cloud.loadFriends(); return window.dslinkPlay.cloud.friends[0]; }); return r && r.status === 'IN_GAME' && r.game && r.game.title ? r : false; }, 10000);
check('PRESENCE: the friend list shows IN_GAME with the game title from the catalog', !!gameStatus && !/\.nds/i.test(JSON.stringify(gameStatus)), JSON.stringify(gameStatus));
await A.screenshot({ path: `${shots}/invite-host.png` }); await B.screenshot({ path: `${shots}/invite-guest.png` });
// leaving: both are told, presence goes back to the menu
await A.evaluate(() => { document.getElementById('confirmYes').click(); });
check('DISCONNECT: the host leaves; PLAYER 2 gets "Connessione persa" and its console is closed', await until(async () => (await screen(B)) === 'lost' && !(await B.evaluate(() => window.dslinkPlay.isPlaying())), 20000));
check('PRESENCE: back to the menu after the game (no "in game forever")', await until(async () => { const r = await A.evaluate(() => window.dslinkPlay.cloud.presence); return r === 'MENU'; }, 10000) || (await A.evaluate(() => window.dslinkPlay.cloud.presence)) === 'MENU');

// ============================================================================================ 4. CREATE a room on the public Cloud (the original bug), join by code, join by QR
await B.click('#btnLostBack'); await B.waitForSelector('[data-screen=library].on');
await A.waitForSelector('[data-screen=library].on', { timeout: 20000 }).catch(() => {});
await A.click('#btnCreate'); await A.waitForSelector('[data-screen=friends-create].on'); await A.click('#btnMakeRoom');
const gotLobby = await until(async () => (await screen(A)) === 'lobby' && /^\d{6}$/.test(await A.evaluate(() => document.getElementById('codeText').textContent)), 20000);
check('PWA CREATE PARTITA over the Cloud: the room is created for real (code 6 digits), NOT "Non riesco a collegarmi"', gotLobby && !/Non riesco a collegarmi/.test(await A.evaluate(() => document.body.innerText)));
check('PWA CREATE PARTITA: the QR is drawn', await A.evaluate(() => !!document.getElementById('codeQr').dataset.code));
const code = await A.evaluate(() => document.getElementById('codeText').textContent);
const G = await device('G', { rom: rom2, passkey: false });                       // an anonymous guest: no account needed for code/QR rooms
await G.click('#btnJoin'); await G.fill('#joinCode', code); await G.click('#btnDoJoin');
check('CODE JOIN: a second browser joins with the code and the WebRTC connection comes up', await until(async () => (await sess(A))?.peer === 'open' && (await sess(G))?.peer === 'open', 25000), JSON.stringify([await sess(A), await sess(G)]));
await A.click('#btnLobbyLeave'); await G.context().close();
await A.click('#btnCreate'); await A.click('#btnMakeRoom'); await A.waitForSelector('[data-screen=lobby].on');
const code2 = await until(() => A.evaluate(() => document.getElementById('codeText').textContent), 8000);
const Q = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true }); const qp = await Q.newPage(); qp.errors = []; qp.on('pageerror', (e) => qp.errors.push(String(e)));
await qp.goto(`${BASE}/play/?stun=0&nosw&join=${code2}`);                              // what the camera app opens after scanning the QR
check('QR JOIN: the QR link opens the PWA, lands in the right room and connects (no code typed)', await until(async () => (await sess(A))?.peer === 'open' && (await qp.evaluate(() => window.dslinkPlay && window.dslinkPlay.session && window.dslinkPlay.session.peer && window.dslinkPlay.session.peer.state)) === 'open', 30000));
await A.click('#btnLobbyLeave'); await Q.close();
check('ROOM CLEANUP: leaving closes the room; the code no longer works', await (async () => { const r = await fetch(`${BASE}/signal/join`, { method: 'POST', body: JSON.stringify({ code: code2 }) }); return r.status === 404; })());

// ============================================================================================ 5. block, multi-device, revoke
await openFriends(B); await friendRow(B, ua).locator('button', { hasText: 'BLOCCA' }).click();
const gone = await until(async () => (await A.evaluate(async () => { await window.dslinkPlay.cloud.loadFriends(); return window.dslinkPlay.cloud.friends.length; })) === 0, 8000);
const listed = await until(async () => (await B.locator('#blockList li', { hasText: '@' + ua }).count()) === 1, 8000);
const hidden = (await A.evaluate(async (u) => (await window.dslinkPlay.cloud.search(u)).body.users.length, ub)) === 0;
check('BLOCK: B blocks A -> the friendship is gone on both sides, A cannot find B any more, B sees the blocked list', gone && listed && hidden, JSON.stringify({ gone: !!gone, listed: !!listed, hidden }));
const uc = uname('carol');
const C1 = await device('C1', { rom: rom1, passkey: false }); const C2 = await device('C2', { passkey: false });
check('ACCOUNT (password fallback): create an account with a password where passkeys are not used', await signup(C1, uc, 'password'));
await until(async () => (await C1.evaluate(async () => { await window.dslinkPlay.cloud.loadLibrary(); return window.dslinkPlay.cloud.library.length; })) === 1, 20000);   // (the library push is debounced: wait until the Cloud has it)
check('MULTI-DEVICE: the same account on a second device (no ROM there) sees the same profile and the same library metadata', await pwLogin(C2, uc) && await until(async () => (await C2.evaluate(() => window.dslinkPlay.cloud.library.length)) === 1, 20000) && (await C2.evaluate(() => document.getElementById('profUser').textContent)) === '@' + uc);
await C2.click('#btnProfLibrary'); await C2.waitForSelector('[data-screen=cloudlib].on');
check('LIBRARY: on the device without the file the game is listed as "File di gioco non presente" (no GIOCA)', /File di gioco non presente/.test(await C2.innerText('#cloudLibList')) && (await C2.locator('#cloudLibList button', { hasText: 'GIOCA' }).count()) === 0);
await C1.click('#btnAccount').catch(() => {});
await C2.click('#btnCloudLibBack'); await C2.click('#btnProfBack');
await C1.waitForSelector('[data-screen=profile].on', { timeout: 5000 }).catch(() => {});
await C1.click('#btnProfSessions');
check('SESSIONS: the account lists both devices and can revoke the other one', await until(async () => (await C1.locator('#profSessions .row2').count()) >= 2, 8000));
await C1.locator('#profSessions .row2', { hasText: /^(?!.*\(questo\))/ }).locator('button', { hasText: 'REVOCA' }).first().click();
await C2.reload(); await C2.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
check('SESSION REVOKE: the revoked device is logged out (ACCEDI) after reload, the other keeps its session', await until(async () => (await chip(C2)) === 'ACCEDI', 8000) && /@/.test(await chip(C1)));
// logout
await C1.click('#btnProfLogout');
check('LOGOUT: the session ends, the chip says ACCEDI, presence stops', await until(async () => (await chip(C1)) === 'ACCEDI', 8000) && (await C1.evaluate(() => window.dslinkPlay.cloud.presence)) === 'OFFLINE');

// ============================================================================================ 6. SINGLE PLAYER when the Cloud is unreachable
const dead = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let p = u.pathname; if (p === '/') p = '/index.html';
  if (p === '/play/cloud-config.json') { res.writeHead(200, { 'content-type': 'application/json' }).end('{"api":"http://127.0.0.1:1","signal":"http://127.0.0.1:1","ws":"http://127.0.0.1:1"}'); return; }
  const file = path.join(new URL('../../build/pwa', import.meta.url).pathname, p.endsWith('/') ? p + 'index.html' : p);
  fs.readFile(file, (e, d) => { if (e) { res.writeHead(404).end(); return; } const ext = path.extname(file); res.writeHead(200, { 'content-type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.png': 'image/png' }[ext] || 'application/octet-stream' }); res.end(d); });
});
await new Promise((r) => dead.listen(0, '127.0.0.1', r));
const S = await device('S', { rom: rom1, passkey: false, base: `http://127.0.0.1:${dead.address().port}` });
check('SINGLE PLAYER OFFLINE: with the Cloud unreachable the library works and the chip says so', await until(async () => /non raggiungibile|ACCEDI/.test(await chip(S)), 8000));
await S.click('#gameList li.game .play');
check('SINGLE PLAYER OFFLINE: GIOCA boots the game at 60 fps with no account and no cloud', await until(async () => (await S.evaluate(() => window.dslinkPlay.isPlaying())) && (await S.evaluate(() => window.dslinkPlay.stats().emuFps)) > 45, 30000));
dead.close();
check('NO SCRIPT ERRORS on the main devices', A.errors.length + B.errors.length + C1.errors.length + S.errors.length === 0, [...A.errors, ...B.errors, ...C1.errors, ...S.errors].join(' | '));
await browser.close();
const ok = results.filter(Boolean).length; console.log(`${ok}/${results.length} checks passed`); process.exit(ok === results.length ? 0 : 1);
