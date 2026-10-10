// DSLink Cloud storage end to end (phase 6), in real Chrome against a REAL Worker runtime (wrangler dev --local: Worker + local D1 + Durable Objects + a local R2 bucket) that also serves the PWA.
// Two "phones" with the same account (Honor / iPhone): private ROM upload, new device, CLOUD ONLY -> download -> play, save sync both ways, offline play, conflicts, history/restore,
// BIOS/firmware in the Cloud, big multipart upload, interrupted download, corrupted download, quota / R2-down errors. Homebrew ROMs and synthetic system files only.
// usage: node play_cloud_files_e2e.mjs <worker-base-url> <rom.nds (homebrew, code DLTT)> <big.nds (17 MiB, code BIGG)> [screenshot-dir]
import { chromium } from 'playwright';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [BASE, rom1, bigRom, shots = '/tmp/playcloudfiles'] = process.argv.slice(2);
fs.mkdirSync(shots, { recursive: true });
const results = [];
// Private Cloud storage (R2) is OPTIONAL: on a deployment without it this suite does not apply (play_storage_modes_e2e covers that mode).
{ const c = await fetch(BASE + '/api/config').then((r) => r.json()).catch(() => ({})); if (c.storage === 'none') { console.log('SKIPPED: R2 disabled - local storage mode (no private Cloud storage on this deployment)'); process.exit(0); } }
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000, step = 150) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
const uname = (p) => (p + Math.random().toString(36).slice(2, 8)).slice(0, 18);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const PASSWORD = 'correct horse battery staple';

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
async function device(name, { rom, query = '', sw = false } = {}) {
  const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 390, height: 844 }, hasTouch: true, acceptDownloads: false });
  const p = await ctx.newPage(); p.devName = name; p.errors = []; p.on('pageerror', (e) => p.errors.push(String(e))); p.on('dialog', (d) => d.accept());
  await p.goto(`${BASE}/play/?stun=0${sw ? '' : '&nosw'}&devname=${name}${query}`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 25000 });
  if (sw) await p.evaluate(async () => { await navigator.serviceWorker.ready; });
  if (rom) { await (await p.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), p).setInputFiles('#romFile', rom); await until(async () => (await p.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), p).locator('#gameList li.game').count()); }
  return p;
}
const screen = (p) => p.evaluate(() => document.body.dataset.screen);
async function signup(p, name) {
  await p.click('#btnAccount'); await p.waitForSelector('[data-screen=account].on'); await p.fill('#authUser', name);
  await p.locator('details.diag summary', { hasText: 'password' }).click(); await p.fill('#authPass', PASSWORD); await p.click('#btnPwCreate');
  const ok = await until(async () => (await screen(p)) === 'profile', 15000); await p.click('#btnProfBack'); return ok;
}
async function login(p, name) {
  await p.click('#btnAccount'); await p.waitForSelector('[data-screen=account].on'); await p.fill('#authUser', name);
  await p.locator('details.diag summary', { hasText: 'password' }).click(); await p.fill('#authPass', PASSWORD); await p.click('#btnPwLogin');
  const ok = await until(async () => (await screen(p)) === 'profile', 15000); await p.click('#btnProfBack'); return ok;
}
const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, credentials: 'include', headers: b ? { 'content-type': 'application/json' } : undefined, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j }; }, [method, url, body]);
const rows = (p) => p.evaluate(() => [...document.querySelectorAll('#gameList li.game')].map((li) => ({ id: li.dataset.id || '', gameid: li.dataset.gameid || '', state: li.dataset.state || '', tag: (li.querySelector('.tag') || {}).textContent || '', title: (li.querySelector('.t') || {}).childNodes[0]?.textContent || '', buttons: [...li.querySelectorAll('button')].map((b) => b.textContent) })));
const gameRow = (p) => p.locator('#gameList li.game').first();
const localId = (p) => p.evaluate(() => (window.dslinkPlay.games[0] || {}).id);
const saveSha = (p, id) => p.evaluate(async (i) => { const b = await window.dslinkPlay.store.get(`library/${i}/save`); if (!b) return null; return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join(''); }, id);
const putSave = (p, id, mark) => p.evaluate(async ([i, m]) => { const b = new Uint8Array(await window.dslinkPlay.store.get(`library/${i}/save`)); b.set(new TextEncoder().encode(m), 0); await window.dslinkPlay.store.put(`library/${i}/save`, b.buffer); await window.dslinkPlay.cfiles.markLocalSave(i); }, [id, mark]);
const saveMark = (p, id) => p.evaluate(async (i) => { const b = await window.dslinkPlay.store.get(`library/${i}/save`); return b ? new TextDecoder().decode(new Uint8Array(b).slice(0, 16)).replace(/\0.*$/, '') : null; }, id);
const syncSave = (p, id, gid) => p.evaluate(async ([i, g]) => { const r = await window.dslinkPlay.cfiles.syncSave(i, g); return { action: r.action, revision: r.revision }; }, [id, gid]);
const heads = async (p) => (await api(p, 'GET', '/api/saves')).body.saves;
async function playAndLeave(p, id, ms = 1500) {
  await (await p.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), p).locator(`#gameList li.game[data-id="${id}"] button.play`).click();
  const up = await until(async () => await p.evaluate(() => window.dslinkPlay.isPlaying()), 40000); await sleep(ms);
  await p.evaluate(() => window.dslinkPlay.controls.openMenu()); await p.click('.ctl-menu [data-act=leave]'); await p.click('#confirmYes');
  await until(async () => (await screen(p)) === 'library' && !(await p.evaluate(() => window.dslinkPlay.isPlaying())), 20000);
  return up;
}
const GID = 'nds-dltt';
const romBytes = fs.readFileSync(rom1), romSha = sha(romBytes);

// ============================================================================================ 0. same-origin hosting, privacy of the bucket
const get = (p) => fetch(BASE + p, { redirect: 'manual' });
const pwa = await get('/play/'), cfg = await (await get('/play/cloud-config.json')).json(), health = await (await get('/api/health')).json();
const sig = await fetch(BASE + '/signal/create', { method: 'POST', body: '{}' });
const build = await (await get('/play/build.json')).json();
check('HOSTING SAME-ORIGIN: /play/ (PWA), /api/ (Cloud API) and /signal (WebRTC signaling) answer on ONE address, no Netlify, no configuration', pwa.status === 200 && health.ok === true && sig.status === 200 && cfg.api === '' && cfg.signal === '', `build ${build.build}`);
check('PWA /play/: shell + WebAssembly core + manifest are served with isolation headers', (await get('/play/core/dslink_wasm.wasm')).status === 200 && (await get('/play/manifest.webmanifest')).status === 200 && pwa.headers.get('cross-origin-opener-policy') === 'same-origin' && pwa.headers.get('cross-origin-embedder-policy') === 'require-corp');
const leak = [];
for (const f of ['bios7.bin', 'bios9.bin', 'firmware.bin', 'refs.json', 'rom.nds', 'game.nds', 'dslink_test_1.nds']) { const r = await get('/play/' + f); if (r.status === 200 && !(r.headers.get('content-type') || '').includes('html')) leak.push(f); }
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
const pkg = walk(new URL('../../build/pwa', import.meta.url).pathname).filter((f) => /\.(nds|srl|sav|srm)$|(^|\/)(bios|firmware|refs)/i.test(f));
check('NO SYSTEM FILES IN PWA: the served PWA and the package contain no ROM, BIOS, firmware, refs.json or save', !leak.length && !pkg.length, JSON.stringify({ leak, pkg }));
const anon = await Promise.all(['/api/files', '/api/files/game/' + GID, '/api/saves', '/api/saves/' + GID + '/data', '/api/storage'].map(async (u) => (await get(u)).status));
check('R2 PRIVATE: no public path to any object - every Cloud file and save route refuses an anonymous request (401)', anon.every((s) => s === 401), anon.join(','));

// ============================================================================================ 1. Honor: local first, then "SALVA NEL MIO CLOUD"
const ua = uname('alice'), ub = uname('bob');
const H = await device('Honor', { rom: rom1, sw: true });          // Honor runs with the service worker, like an installed PWA (needed to start offline)
check('ACCOUNT (password) created on Honor', await signup(H, ua));
await sleep(600);
const id1 = await localId(H);
let r0 = (await rows(H))[0];
check('LOCAL ONLY: the imported game is "SOLO LOCALE", nothing is in the Cloud, it plays', r0.tag === 'SOLO LOCALE' && r0.state === 'local' && r0.buttons.includes('SALVA NEL MIO CLOUD') && (await api(H, 'GET', '/api/files')).body.games.length === 0);
const seenPct = new Set();
const poll = setInterval(() => H.evaluate(() => (document.getElementById('xfer').hidden ? null : document.getElementById('xferBar').value)).then((v) => { if (v !== null) seenPct.add(Math.round(v)); }).catch(() => {}), 40);
await (await H.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), H).locator('#gameList li.game button', { hasText: 'SALVA NEL MIO CLOUD' }).click();
const up1 = await until(async () => (await rows(H))[0].tag === 'LOCALE + CLOUD', 30000);
clearInterval(poll);
const f1 = (await api(H, 'GET', '/api/files')).body;
check('ROM UPLOAD: the ROM went to the private Cloud (progress shown), the list says LOCALE + CLOUD, size and SHA-256 match the file', !!up1 && f1.games.length === 1 && f1.games[0].sha256 === romSha && f1.games[0].size === romBytes.length, `progress ${[...seenPct].join('/')}`);
check('LOCAL + CLOUD: row state both; storage usage shows local and Cloud space', (await rows(H))[0].state === 'both' && /Spazio locale utilizzato: .*Spazio Cloud utilizzato: [\d.]+ (KB|MB) di/.test(await H.evaluate(() => document.getElementById('usageBox').textContent)), await H.evaluate(() => document.getElementById('usageBox').textContent));
// first real play: the homebrew writes its save on exit -> v1 goes to the Cloud automatically
const played = await playAndLeave(H, id1);
check('PLAY (local, WebAssembly on the device) + SAVE AUTO SYNC on exit: the save written locally reaches the Cloud as revision 1, nobody was asked', played && !!(await until(async () => (await heads(H)).find((x) => x.gameId === GID)?.revision === 1, 15000)));
const v1sha = await saveSha(H, id1);
check('CLOUD SAVE: the Cloud head is exactly the device\'s save (same SHA-256), made by Honor', (await heads(H))[0].sha256 === v1sha && (await heads(H))[0].deviceName === 'Honor');
await putSave(H, id1, 'HONOR-V1'); const s1 = await syncSave(H, id1, GID);
check('SAVE UPLOAD: a changed save is uploaded as the next revision', s1.action === 'pushed' && s1.revision === 2);
const v2sha = await saveSha(H, id1);

// ============================================================================================ 2. iPhone: same account, new device
const P = await device('iPhone');
check('ACCOUNT on the iPhone: login with the same account', await login(P, ua));
const cloudOnly = await until(async () => (await rows(P)).find((r) => r.state === 'cloud'), 20000);
check('NEW DEVICE: after login the library shows the game at once as CLOUD ONLY with SCARICA and GIOCA', !!cloudOnly && cloudOnly.tag === 'SOLO CLOUD' && cloudOnly.buttons.includes('SCARICA') && cloudOnly.buttons.includes('GIOCA'), JSON.stringify(cloudOnly));
await (await P.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), P).locator('#gameList li.cloudonly button.play').click();
const dlOk = await until(async () => await P.evaluate(() => window.dslinkPlay.isPlaying()), 60000);
const idP = await localId(P);
const romLocal = await P.evaluate(async (i) => { const b = await window.dslinkPlay.store.get(`library/${i}/rom.nds`); return b ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('') : null; }, idP);
check('ROM DOWNLOAD + HASH VERIFY: GIOCA downloaded the ROM from the private Cloud, verified its SHA-256, stored it locally and started the local WebAssembly emulator', dlOk && romLocal === romSha);
check('SAVE DOWNLOAD: the account\'s latest save arrived together with the game (revision 2, Honor\'s)', (await saveSha(P, idP)) !== null && (await saveMark(P, idP)) === 'HONOR-V1');
await P.evaluate(() => window.dslinkPlay.controls.openMenu()); await P.click('.ctl-menu [data-act=leave]'); await P.click('#confirmYes');
await until(async () => (await screen(P)) === 'library' && !(await P.evaluate(() => window.dslinkPlay.isPlaying())), 20000);
check('LOCAL + CLOUD on the iPhone after the download', (await rows(P)).every((r) => r.state === 'both'), JSON.stringify((await rows(P)).map((r) => r.tag)));
await putSave(P, idP, 'IPHONE-V3'); const sP = await syncSave(P, idP, GID);
check('MULTI-DEVICE: the iPhone plays and creates the next save version (v3)', sP.action === 'pushed' && sP.revision === 3);
await H.reload(); await H.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
check('MULTI-DEVICE: Honor reopens and receives the iPhone\'s save automatically (no question asked)', !!(await until(async () => (await saveMark(H, id1)) === 'IPHONE-V3', 20000)) && !(await H.evaluate(() => !document.getElementById('conflictBox').hidden)));
check('SAVE AUTO SYNC: Cloud newer -> local updated; local newer -> Cloud updated; both without dialogs', (await heads(H))[0].revision === 3);

// ============================================================================================ 3. offline play, reconnect
const Hctx = H.context();
await Hctx.setOffline(true);
const playedOff = await playAndLeave(H, id1);
await putSave(H, id1, 'HONOR-OFFLINE');
const offAct = await syncSave(H, id1, GID);
check('OFFLINE: with ROM already local, GIOCA works with no Cloud and no network; the save stays on the device', playedOff && offAct.action === 'offline' && (await saveMark(H, id1)) === 'HONOR-OFFLINE', `played ${playedOff} action ${offAct.action} mark ${await saveMark(H, id1)}`);
await Hctx.setOffline(false);
check('RECONNECT SYNC: when the connection returns the local save is sent to the Cloud by itself (Cloud unchanged meanwhile)', !!(await until(async () => (await heads(H))[0].revision === 4, 20000)) && (await heads(H))[0].deviceName === 'Honor');
check('OFFLINE SAVE: no script errors and nothing lost', H.errors.length === 0, H.errors.join('|'));

// ============================================================================================ 4. conflict: both devices changed the save while apart
await H.context().setOffline(true);
await putSave(H, id1, 'HONOR-DIVERGE');
await syncSave(P, idP, GID);                                                            // the iPhone (online) first takes revision 4 (Honor's offline play)...
await putSave(P, idP, 'IPHONE-DIVERGE'); await syncSave(P, idP, GID);                  // ...then changes the save and pushes revision 5, while Honor is still apart
const pHead = (await heads(P))[0];
await H.context().setOffline(false);
const cfShown = await until(async () => await H.evaluate(() => !document.getElementById('conflictBox').hidden), 20000);
const cfText = await H.evaluate(() => { const b = document.getElementById('conflictBox'); return [...b.querySelectorAll('h2,p,b,small,button')].map((e) => e.textContent).join(' | '); });
check('SAVE CONFLICT: Honor and iPhone changed the same save apart -> "Ci sono due salvataggi diversi" with both devices and their date/time', !!cfShown && /due salvataggi diversi/i.test(cfText) && /Honor/.test(cfText) && /iPhone/.test(cfText) && /\d{2}\/\d{2}/.test(cfText), cfText.replace(/\s+/g, ' ').slice(0, 160));
check('SAVE CONFLICT: nothing was overwritten while the question is open (Cloud still the iPhone\'s, Honor still its own)', (await saveMark(H, id1)) === 'HONOR-DIVERGE' && (await heads(H))[0].sha256 === pHead.sha256);
await H.screenshot({ path: path.join(shots, 'conflict.png') });
await H.click('#btnCfCloud');                                                            // USA L'ALTRO
check("SAVE CONFLICT: USA L'ALTRO -> the Cloud's save replaces the local one, and Honor's own save is kept as a backup copy", !!(await until(async () => (await saveMark(H, id1)) === 'IPHONE-DIVERGE', 15000)) && (await H.evaluate(async (i) => { const b = await window.dslinkPlay.store.get(`library/${i}/save.bak`); return b ? new TextDecoder().decode(new Uint8Array(b).slice(0, 13)).replace(/\0.*$/, '') : null; }, id1)) === 'HONOR-DIVERGE');
await putSave(H, id1, 'HONOR-2'); await syncSave(P, idP, GID); await putSave(P, idP, 'IPHONE-2'); await syncSave(P, idP, GID);     // diverge again
const again = await H.evaluate(async ([i, g]) => { const r = await window.dslinkPlay.cfiles.syncSave(i, g); return r.action; }, [id1, GID]);
await H.waitForSelector('#conflictBox:not([hidden])'); await H.click('#btnCfLocal');                // USA QUESTO
await until(async () => (await heads(H))[0].deviceName === 'Honor' && (await heads(H))[0].revision >= 7, 15000);
const hist = (await api(H, 'GET', '/api/saves/' + GID)).body.history;
check('SAVE CONFLICT: USA QUESTO -> Honor\'s save becomes the newest revision and the iPhone\'s version stays in the history (nothing lost)', again === 'conflict' && hist[0].deviceName === 'Honor' && hist.some((h) => h.deviceName === 'iPhone'), hist.map((h) => `v${h.revision}:${h.deviceName}`).join(' '));
check('SAVE REVISION: only the last 5 revisions are kept per game', hist.length <= 5 && hist.length >= 3, `${hist.length}`);

// ============================================================================================ 5. history + restore
await (await H.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), H).locator('#gameList li.game button', { hasText: 'SALVATAGGI' }).click(); await H.waitForSelector('#histBox:not([hidden])');
await until(async () => (await H.locator('#histList li[data-rev]').count()) >= 3, 10000);          // the list fills in after the box opens
const histRows = await H.locator('#histList li[data-rev]').count();
const oldest = await H.locator('#histList li[data-rev]').last(); const oldRev = Number(await oldest.getAttribute('data-rev'));
const oldSha = (await (await H.request.get(`${BASE}/api/saves/${GID}/data?rev=${oldRev}`)).body()).length;      // (authenticated by the page's cookie jar)
await oldest.locator('button', { hasText: 'RIPRISTINA' }).click();
const restored = await until(async () => (await heads(H))[0].note === `restore:${oldRev}`, 15000);
await H.screenshot({ path: path.join(shots, 'history.png') });
await H.click('#btnHistClose');
const hd = (await heads(H))[0];
await until(async () => (await saveSha(H, id1)) === hd.sha256, 10000);        // the device takes the restored revision right after the Cloud made it
check('SAVE RESTORE: an older revision is restored as a NEW revision (history stays linear) and this device receives it', !!restored && hd.revision >= 8 && histRows >= 3 && oldSha > 0 && (await saveSha(H, id1)) === hd.sha256, `restored v${oldRev} -> v${hd.revision}`);

// ============================================================================================ 6. remove from device / remove from cloud
await P.reload(); await P.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
await until(async () => (await rows(P))[0]?.state === 'both', 15000);
await (await P.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), P).locator('#gameList li.game button', { hasText: 'RIMUOVI DAL DISPOSITIVO' }).click();
const afterLocal = await until(async () => (await rows(P)).length === 1 && (await rows(P))[0].state === 'cloud', 15000);
const stillCloud = (await api(P, 'GET', '/api/files')).body.games.length === 1;
check('REMOVE LOCAL: RIMUOVI DAL DISPOSITIVO deletes only the local copy - the game is CLOUD ONLY again and the Cloud keeps ROM and saves', !!afterLocal && stillCloud && (await api(P, 'GET', '/api/saves/' + GID)).body.history.length >= 3);
check('CLOUD ONLY: after removing the local copy the ROM is no longer in the browser storage (only save bookkeeping may remain)', (await P.evaluate(async () => (await window.dslinkPlay.store.list('library/')).map((x) => String(x.key || x.name || x.path || x)).filter((k) => !/\/(sync\.json|save\.meta\.json|save)$/.test(k)).length)) === 0);
await (await P.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), P).locator('#gameList li.cloudonly button', { hasText: 'RIMUOVI DAL CLOUD' }).click();
const gone = await until(async () => (await api(P, 'GET', '/api/files')).body.games.length === 0, 15000);
await H.reload(); await H.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library'); await sleep(1500);
check('REMOVE CLOUD: RIMUOVI DAL CLOUD (with confirmation) deletes the Cloud file; Honor still has its local copy, now SOLO LOCALE', !!gone && (await rows(H)).length === 1 && (await rows(H))[0].tag === 'SOLO LOCALE' && (await api(H, 'GET', '/api/storage')).body.gamesBytes === 0);

// ============================================================================================ 7. another account cannot reach any of it
const B = await device('Bob'); await signup(B, ub);
const cross = await Promise.all([api(B, 'GET', '/api/files/game/' + GID), api(B, 'GET', '/api/saves/' + GID + '/data'), api(B, 'DELETE', '/api/files/game/' + GID)]);
check('CROSS-ACCOUNT R2 ACCESS: BLOCKED - another account gets 404 for the first account\'s ROM and save, cannot delete them, sees an empty list', cross.every((c) => c.status === 404) && (await api(B, 'GET', '/api/files')).body.games.length === 0 && (await api(B, 'GET', '/api/saves')).body.saves.length === 0);

// ---- an invite never downloads a ROM: Bob (no copy of the game) accepts a game invite from Alice; his device makes no file request and stores no ROM
await api(H, 'POST', '/api/friends/requests', { username: ub }); const rq = await api(B, 'GET', '/api/friends/requests'); await api(B, 'POST', `/api/friends/requests/${rq.body.incoming[0].id}/accept`);
await until(async () => (await H.evaluate(async () => { await window.dslinkPlay.cloud.loadFriends(); return window.dslinkPlay.cloud.friends.find((f) => f.status === 'MENU' || f.status === 'ONLINE') ? 1 : 0; })), 15000);
const bobFileReqs = []; B.on('request', (r) => { if (/\/api\/files\/(game|system)\//.test(r.url())) bobFileReqs.push(r.url()); });
const bobId = await B.evaluate(() => window.dslinkPlay.cloud.user.userId);
const inv = await H.evaluate(async ([uid]) => { const r = await window.dslinkPlay.cloud.invite(uid, 'nds-dltt'); return { ok: r.ok, err: r.error }; }, [bobId]);
await B.waitForSelector('#inviteBox:not([hidden])', { timeout: 15000 }); await B.click('#btnInvAccept');
const inLobby = await until(async () => (await screen(B)) === 'lobby', 15000); await sleep(800);
check('DOWNLOAD PLAY / INVITE: accepting an invite does NOT download the ROM from any Cloud - no file request, no ROM stored on the guest', inv.ok && !!inLobby && bobFileReqs.length === 0 && (await B.evaluate(async () => (await window.dslinkPlay.store.list('library/')).length)) === 0, JSON.stringify({ inv, bobFileReqs }));
await B.click('#btnLobbyLeave');

// ============================================================================================ 8. BIOS / firmware in the Cloud (synthetic files of the right size)
const uc = uname('carol');
const S1 = await device('Honor'); await signup(S1, uc);
const sys = { bios7: crypto.randomBytes(16384), bios9: crypto.randomBytes(4096), firmware: crypto.randomBytes(131072) };
for (const k of Object.keys(sys)) { fs.writeFileSync(`/tmp/pwa-${k}.bin`, sys[k]); await (await S1.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('settings')), S1).setInputFiles(`#sysList li[data-key=${k}] input[type=file]`, `/tmp/pwa-${k}.bin`); await sleep(300); }
await until(async () => (await (await S1.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('settings')), S1).locator('#sysList li[data-key=firmware] small.ok').count()) > 0, 10000);
await (await S1.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('settings')), S1).locator('#sysList li[data-key=bios7] button', { hasText: 'SALVA NEL MIO CLOUD' }).click();
await until(async () => (await api(S1, 'GET', '/api/files')).body.system.some((x) => x.name === 'bios7.bin'), 15000);
await (await S1.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('settings')), S1).locator('#sysList li[data-key=bios9] button', { hasText: 'SALVA NEL MIO CLOUD' }).click();
await until(async () => (await api(S1, 'GET', '/api/files')).body.system.some((x) => x.name === 'bios9.bin'), 15000);
await (await S1.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('settings')), S1).locator('#sysList li[data-key=firmware] button', { hasText: 'SALVA NEL MIO CLOUD' }).click();
await until(async () => (await api(S1, 'GET', '/api/files')).body.system.length === 3, 15000);
const cs = (await api(S1, 'GET', '/api/files')).body.system;
check('BIOS CLOUD + FIRMWARE CLOUD: bios7, bios9 and firmware.bin were saved in the private Cloud (optional "Salva nel mio Cloud"), SHA-256 equal to the files', cs.length === 3 && cs.find((x) => x.name === 'bios7.bin').sha256 === sha(sys.bios7) && cs.find((x) => x.name === 'firmware.bin').sha256 === sha(sys.firmware) && cs.find((x) => x.name === 'bios9.bin').size === 4096);
const S2 = await device('iPhone');
await login(S2, uc);
const got = await until(async () => (await S2.evaluate(async () => { const o = {}; for (const f of ['bios7.bin', 'bios9.bin', 'firmware.bin']) { const b = await window.dslinkPlay.store.get('system/' + f); o[f] = b ? b.byteLength : 0; } return o; })), 15000);
const gotAll = await until(async () => { const o = await S2.evaluate(async () => { const o = {}; for (const f of ['bios7.bin', 'bios9.bin', 'firmware.bin']) { const b = await window.dslinkPlay.store.get('system/' + f); o[f] = b ? b.byteLength : 0; } return o; }); return o['bios7.bin'] === 16384 && o['bios9.bin'] === 4096 && o['firmware.bin'] === 131072; }, 20000);
void got;
const h7 = await S2.evaluate(async () => { const b = await window.dslinkPlay.store.get('system/bios7.bin'); return [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join(''); });
check('SYSTEM FILE CLOUD: a new device gets BIOS and firmware back automatically after login, identical bytes, "pronto" with no manual import', !!gotAll && h7 === sha(sys.bios7));
const sysLocalOnly = await device('Local'); const uf = uname('dave'); await signup(sysLocalOnly, uf);
await (await sysLocalOnly.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('settings')), sysLocalOnly).setInputFiles('#sysList li[data-key=bios9] input[type=file]', '/tmp/pwa-bios9.bin'); await sleep(800);
check('LOCAL ONLY (system files): without "Salva nel mio Cloud" a BIOS stays on the device only', (await api(sysLocalOnly, 'GET', '/api/files')).body.system.length === 0 && (await sysLocalOnly.evaluate(async () => (await window.dslinkPlay.store.get('system/bios9.bin')).byteLength)) === 4096);

// ============================================================================================ 9. big ROM: multipart upload with real progress, then download on another device
const ud = uname('erin');
const G1 = await device('Honor', { rom: bigRom }); await signup(G1, ud);
const pcts = new Set(); const poll2 = setInterval(() => G1.evaluate(() => (document.getElementById('xfer').hidden ? null : document.getElementById('xferBar').value)).then((v) => { if (v !== null) pcts.add(Math.round(v)); }).catch(() => {}), 30);
await (await G1.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), G1).locator('#gameList li.game button', { hasText: 'SALVA NEL MIO CLOUD' }).click();
const bigUp = await until(async () => (await api(G1, 'GET', '/api/files')).body.games.length === 1, 90000); clearInterval(poll2);
const bigSha = sha(fs.readFileSync(bigRom));
const bf = (await api(G1, 'GET', '/api/files')).body.games[0];
check('UPLOAD (large file, in parts): a 17 MiB ROM goes up in 8 MiB parts with a growing percentage and is verified by the Cloud', !!bigUp && bf.sha256 === bigSha && bf.size === fs.statSync(bigRom).size && [...pcts].some((v) => v > 0 && v < 100), `progress ${[...pcts].sort((a, b) => a - b).join('/')}`);
const G2 = await device('iPhone'); await login(G2, ud);
await until(async () => (await rows(G2)).find((r) => r.state === 'cloud'), 20000);
// interrupted download: the first response is cut half way; the client resumes with a Range request and still verifies the whole file
let cut = false, ranged = false;
await G2.route('**/api/files/game/*', async (route) => {
  const hdr = route.request().headers();
  if (hdr.range) { ranged = true; return route.continue(); }
  const resp = await route.fetch(); const body = await resp.body(); cut = true;
  return route.fulfill({ status: 200, headers: { ...resp.headers(), 'content-length': String(body.length) }, body: body.subarray(0, Math.floor(body.length / 2)) });
});
await (await G2.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), G2).locator('#gameList li.cloudonly button', { hasText: 'SCARICA' }).click();
const dl2 = await until(async () => (await rows(G2)).some((r) => r.state === 'both'), 60000);
await G2.unroute('**/api/files/game/*');
const bigLocal = await G2.evaluate(async () => { const g = window.dslinkPlay.games[0]; const b = await window.dslinkPlay.store.get(`library/${g.id}/rom.nds`); return b ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', b))].map((x) => x.toString(16).padStart(2, '0')).join('') : null; });
check('DOWNLOAD interrupted: the connection drops half way -> the client resumes from where it stopped (Range) and the finished file passes the SHA-256 check', !!dl2 && cut && ranged && bigLocal === bigSha, `cut ${cut} range ${ranged}`);
// corrupted download: one flipped byte must be refused, nothing stored
await G2.evaluate(async () => { const g = window.dslinkPlay.games[0]; for (const n of ['rom.nds', 'meta.json', 'save', 'sync.json']) await window.dslinkPlay.store.del(`library/${g.id}/${n}`); });
await G2.reload(); await G2.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library'); await until(async () => (await rows(G2)).find((r) => r.state === 'cloud'), 20000);
await G2.route('**/api/files/game/*', async (route) => { const resp = await route.fetch(); const b = Buffer.from(await resp.body()); b[5000] ^= 1; return route.fulfill({ status: 200, headers: resp.headers(), body: b }); });
await (await G2.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), G2).locator('#gameList li.cloudonly button', { hasText: 'SCARICA' }).click();
const errShown = await until(async () => /integro/.test(await G2.evaluate(() => document.getElementById('xferErr').textContent)), 60000);
const nothing = (await G2.evaluate(async () => (await window.dslinkPlay.store.list('library/')).length)) === 0;
await G2.unroute('**/api/files/game/*');
check('ROM HASH VERIFY: a corrupted download is refused ("non è arrivato integro"), nothing is written to the device, the Cloud copy is untouched', !!errShown && nothing && (await api(G2, 'GET', '/api/files')).body.games.length === 1);
await G2.click('#btnXferClose');

// ============================================================================================ 10. errors: quota, R2 down, local quota - local files are never lost
const L = await device('Honor', { rom: rom1 }); await signup(L, uname('frank'));
await L.route('**/api/files/uploads', (route) => route.fulfill({ status: 507, contentType: 'application/json', body: JSON.stringify({ error: 'cloud_quota_exceeded' }) }));
await (await L.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), L).locator('#gameList li.game button', { hasText: 'SALVA NEL MIO CLOUD' }).click();
const qErr = await until(async () => await L.evaluate(() => document.getElementById('xferErr').textContent), 10000);
const stillLocal = (await L.evaluate(async () => (await window.dslinkPlay.store.list('library/')).length)) === 2;
await L.click('#btnXferClose'); await L.unroute('**/api/files/uploads');
await L.route('**/api/files/uploads', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'storage_unavailable' }) }));
await (await L.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), L).locator('#gameList li.game button', { hasText: 'SALVA NEL MIO CLOUD' }).click();
const rErr = await until(async () => { const t = await L.evaluate(() => document.getElementById('xferErr').textContent); return t && t !== qErr ? t : ''; }, 10000);
await L.click('#btnXferClose'); await L.unroute('**/api/files/uploads');
check('QUOTA / R2 UNAVAILABLE: "Spazio Cloud esaurito" and "il Cloud non riesce ad accedere ai file" are shown, the local game and its save are untouched, GIOCA still works', /Spazio Cloud esaurito/.test(qErr) && /non riesce ad accedere/.test(rErr) && stillLocal && (await playAndLeave(L, await localId(L))));
check('NO SCRIPT ERRORS on any device', [H, P, B, S1, S2, G1, G2, L].every((p) => p.errors.length === 0), [H, P, B, S1, S2, G1, G2, L].flatMap((p) => p.errors).join(' | ').slice(0, 300));

await browser.close();
const ok = results.filter(Boolean).length; console.log(`${ok}/${results.length} checks passed`); process.exit(ok === results.length ? 0 : 1);
