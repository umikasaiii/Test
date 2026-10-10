// PRIVATE test (never run in CI): real Mario Party DS Download Play between two PWAs. HOST has the user's ROM + BIOS + firmware + refs.json, GUEST has BIOS + firmware only (NO cartridge).
// Everything private is read from <private-dir> and goes only into the two browser contexts' local storage; the result file carries step names, DS state names, counters and times, never payload.
// usage: node play_mario_private.mjs <private-dir> [--name run1] [--no-coi] [--delay=ms] [--jitter=ms] [--loss=pct] [--game] [--soak=sec] [--wait-scale=1.5]
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSignalHandler, nodeAdapter } from '../signal/dev_server.mjs';

const argv = process.argv.slice(2), priv = argv.find((a) => !a.startsWith('--') && fs.existsSync(a));
const opt = (n, d = '') => { const i = argv.findIndex((a) => a === '--' + n || a.startsWith('--' + n + '=')); if (i < 0) return d; const a = argv[i]; return a.includes('=') ? a.split('=')[1] : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '1'); };
if (!priv) { console.error('usage: play_mario_private.mjs <private-dir>'); process.exit(2); }
const NAME = opt('name', 'run'), OUT = path.join(priv, 'out', 'pwa_' + NAME); fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
const COI = !argv.includes('--no-coi'), RINGMSG = argv.includes('--msg'), SOAK = +opt('soak', 0), WS = opt('wait-scale', '1');
const WEB = new URL('../web', import.meta.url).pathname, CONTROLS = new URL('../worker/public/controls', import.meta.url).pathname;
const results = [], T0 = Date.now();
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const mark = (n, x) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(7)}s] ${n} ${x ? JSON.stringify(x) : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 15000, step = 200) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const sig = createSignalHandler({ ttlMs: 3600000 }), adapt = nodeAdapter(sig);
const server = http.createServer(async (req, res) => {
  if (await adapt(req, res)) return;
  const u = new URL(req.url, 'http://x'); let p = u.pathname; if (p.endsWith('/')) p += 'index.html';
  const file = p.startsWith('/controls/') ? path.join(CONTROLS, p.slice(10)) : path.join(WEB, p);
  fs.readFile(file, (err, data) => { if (err) { res.writeHead(404).end(); return; }
    const h = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' };
    if (COI) { h['cross-origin-opener-policy'] = 'same-origin'; h['cross-origin-embedder-policy'] = 'require-corp'; h['cross-origin-resource-policy'] = 'same-origin'; }
    res.writeHead(200, h); res.end(data); });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });

async function device(name, files, withSave) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 1 });
  const p = await ctx.newPage(); p.devName = name; p.errors = []; p.on('pageerror', (e) => p.errors.push(String(e)));
  const q = `?stun=0&nosw${RINGMSG ? '&radioring=msg' : ''}${opt('delay') ? '&delay=' + opt('delay') : ''}${opt('jitter') ? '&jitter=' + opt('jitter') : ''}${opt('loss') ? '&loss=' + opt('loss') : ''}&dlscale=${WS}&dev=1`;
  await p.goto(`${BASE}/play/${q}`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 20000 });
  for (const f of files) {
    if (f === 'mario.nds') { await (await p.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), p).setInputFiles('#romFile', path.join(priv, f)); await until(async () => (await p.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('games')), p).locator('#gameList li.game').count(), 60000); }
    else await (await p.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('settings')), p).setInputFiles(`input[data-sys="${f === 'refs.json' ? 'refs' : f.replace('.bin', '').replace('firmware', 'firmware')}"]`, f === 'refs.json' ? path.join(priv, 'out', 'refs.json') : path.join(priv, f));
    await sleep(300);
  }
  if (withSave) {   // a pristine save (a slot exists) so the menus are deterministic; copied into this browser's own storage
    const b64 = fs.readFileSync(path.join(priv, 'mario_save', 'melonDS DS', 'mario.srm')).toString('base64');
    await p.evaluate(async (b64) => { const id = window.dslinkPlay.games[0].id, bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); await window.dslinkPlay.store.put(`library/${id}/save`, bin.buffer); }, b64);
  }
  return p;
}
const sess = (p) => p.evaluate(() => { const s = window.dslinkPlay.session; return s ? { why: s.why, scr: document.body.dataset.screen, state: s.state, role: s.role, peer: s.peer ? s.peer.state : null, dl: s.dlplay, other: s.other.ready, q: s.quality && s.quality.label } : null; });
const stats = (p) => p.evaluate(() => { const s = window.dslinkPlay.stats(); if (!s) return null; const r = s.radio; return { emuFps: s.emuFps, frameMax: s.frameMsMax, dl: s.dl, radioMode: r && r.mode, peer: r && { rtt: r.peer.rtt, jitter: r.peer.jitter, sent: r.peer.sent, recv: r.peer.recv, lost: r.peer.lost, reordered: r.peer.reordered, late: r.peer.lateDropped, bufferedMax: r.peer.bufferedMax, droppedSoft: r.peer.droppedSoft, droppedHard: r.peer.droppedHard, holdMax: r.peer.rxHoldMsMax }, core: r && r.core, ringDropped: r && r.ringDropped, ringFill: r && r.ringFill }; });
const assistOf = (p) => p.evaluate(() => { const a = window.dslinkPlay.assist; return a ? { done: a.done, failed: a.failed, step: a.step, timeline: a.timeline, lastDist: a.lastDist } : null; });
const shot = async (p, n) => { const px = await p.evaluate(async () => { const g = await window.dslinkPlay.grab(); return Array.from(g); }).catch(() => null); if (!px) return; /* private screenshots stay in the private dir */
  const { createCanvas } = {}; void createCanvas; await p.screenshot({ path: path.join(OUT, n + '.png') }); };

mark('devices', { coi: COI, ringMsg: RINGMSG, impair: [opt('delay'), opt('jitter'), opt('loss')] });
const LATE = argv.includes('--late-refs');   // host starts WITHOUT refs.json: START must be refused before it, the room must survive, importing it in the lobby unblocks START
const A = await device('host', ['mario.nds', 'bios7.bin', 'bios9.bin', 'firmware.bin', ...(LATE ? [] : ['refs.json'])], true);
const B = await device('guest', ['bios7.bin', 'bios9.bin', 'firmware.bin'], false);
check('HOST has ROM + BIOS + firmware + refs.json; GUEST has BIOS + firmware only (no game in its library)', (await A.evaluate(() => window.dslinkPlay.games.length)) === 1 && (await B.evaluate(() => window.dslinkPlay.games.length)) === 0 && (await (await B.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('settings')), B).locator('#sysList li small.ok').count()) >= 3);
await (await A.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('multiplayer')), A).click('#btnCreate'); await A.waitForSelector('[data-screen=friends-create].on'); await A.click('#btnMakeRoom'); await A.waitForSelector('[data-screen=lobby].on');
const code = await until(() => A.evaluate(() => document.getElementById('codeText').textContent), 8000);
await (await B.evaluate(() => window.dslinkPlay && window.dslinkPlay.go('multiplayer')), B).click('#btnJoin'); await B.waitForSelector('[data-screen=friends-join].on'); await B.fill('#joinCode', code); await B.click('#btnDoJoin'); await B.waitForSelector('[data-screen=lobby].on');
check('LOBBY: DataChannel open, GUEST in Download Play mode (no copy of the game)', await until(async () => { const a = await sess(A), b = await sess(B); return a && b && a.peer === 'open' && b.peer === 'open' && b.dl && a.dl; }, 20000), JSON.stringify([await sess(A), await sess(B)]));
await until(() => B.evaluate(() => !document.getElementById('btnReady').disabled), 8000); await B.click('#btnReady');
if (LATE) {
  await until(() => A.evaluate(() => document.getElementById('lobbyNote').textContent.includes('refs.json')), 8000);
  const blocked = await A.evaluate(() => ({ dis: document.getElementById('btnStart').disabled, note: document.getElementById('lobbyNote').textContent, imp: !document.getElementById('lobbyRefsWrap').hidden, st: window.dslinkPlay.session && window.dslinkPlay.session.state }));
  check('refs.json MISSING: START refused BEFORE it with a clear message, room kept (lobby, peer connected), import offered in the lobby', blocked.dis && /refs\.json/.test(blocked.note) && blocked.imp && blocked.st === 'lobby' && (await sess(A)).peer === 'open', JSON.stringify(blocked));
  await A.setInputFiles('#lobbyRefs', path.join(priv, 'out', 'refs.json'));
  check('refs.json imported in the open lobby: START unlocked, same room', await until(() => A.evaluate(() => !document.getElementById('btnStart').disabled), 8000) && (await sess(A)).peer === 'open');
}
check('START gate: host can start (refs.json + system files present)', await until(() => A.evaluate(() => !document.getElementById('btnStart').disabled), 15000), await A.evaluate(() => document.getElementById('lobbyNote').textContent));
const tStart = Date.now(); mark('START');
await A.click('#btnStart');
check('both consoles booted (HOST with Mario, GUEST with NO cartridge)', await until(async () => (await A.evaluate(() => window.dslinkPlay.isPlaying())) && (await B.evaluate(() => window.dslinkPlay.isPlaying())), 60000));
const log = [];
let lastA = '', lastB = '';
const endBy = Date.now() + (+opt('budget', 900)) * 1000;   // --budget=sec: stop waiting (failing runs: capture metrics early)
let lobbyBoth = false;
while (Date.now() < endBy) {
  const [aa, ab] = [await assistOf(A), await assistOf(B)];
  const sa = await stats(A), sb = await stats(B);
  const ds = `${sa?.dl?.dl_state}|${sb?.dl?.dl_state}`;
  const [xa, xb] = [await sess(A), await sess(B)]; const ss = `${xa?.state}/${xa?.peer}/${xa?.scr}|${xb?.state}/${xb?.peer}/${xb?.scr}`; if (ss !== (globalThis.__ss || '')) { globalThis.__ss = ss; mark('session', { ss, whyA: xa?.why, whyB: xb?.why, lostA: await A.evaluate(() => document.getElementById('lostNote').textContent).catch(() => ''), lostB: await B.evaluate(() => document.getElementById('lostNote').textContent).catch(() => '') }); }
  if (ds !== lastA) { lastA = ds; mark('DS states host|guest', ds); }
  if (!xa && !xb) { mark('session ended on both devices', { shutdown: await Promise.all([A, B].map((pg) => pg.evaluate(() => window.__lastShutdown || null).catch(() => null))), screens: [await A.evaluate(() => document.body.dataset.screen), await B.evaluate(() => document.body.dataset.screen)], lostA: await A.evaluate(() => document.getElementById('lostNote').textContent), lostB: await B.evaluate(() => document.getElementById('lostNote').textContent) }); break; }
  if ((aa && aa.failed) || (ab && ab.failed)) { mark('assistant failed', { host: aa?.failed, guest: ab?.failed, hostDist: aa?.lastDist, guestDist: ab?.lastDist }); break; }
  if (aa?.done && ab?.done) { lobbyBoth = true; break; }
  await sleep(2000);
}
const aa = await assistOf(A), ab = await assistOf(B), sa = await stats(A), sb = await stats(B);
const tl = (x) => Object.fromEntries((x?.timeline || []).map((e) => [e.name, e.t]));
const ta = tl(aa), tb = tl(ab);
check('DOWNLOAD PLAY DISCOVERY: guest sees the host advertising', !!(tb.GUEST_DISCOVERED !== undefined && ta.HOST_ADVERTISING !== undefined), JSON.stringify({ ta, tb }));
check('DOWNLOAD PLAY TRANSFER: complete', tb.DOWNLOAD_COMPLETE !== undefined, `begin ${tb.DOWNLOAD_BEGIN} complete ${tb.DOWNLOAD_COMPLETE}`);
check('GUEST GAME BOOT', tb.GUEST_BOOT !== undefined);
check('MARIO HANDSHAKE', tb.GAME_HANDSHAKE !== undefined && ta.GAME_HANDSHAKE !== undefined);
check('MARIO LOBBY on both (assistant finished)', lobbyBoth && ta.MARIO_LOBBY !== undefined && tb.MARIO_LOBBY !== undefined);
// the real lobby, by SCREEN (the user's own references, test-only): host 'Select Mode', guest 'P1 is making selections'
const refs = JSON.parse(fs.readFileSync(path.join(priv, 'out', 'refs.json'), 'utf8'));
const onScreen = (p, name, tol = 60) => p.evaluate(async ([ref, tol]) => { const m = await import('./dlassist.js'); const g = await (window.dslinkPlay.grab() || Promise.resolve(null)).catch(() => null); if (!g) return -999; const h = m.hashScreens(g); return Math.min(m.hdist(h.bot, ref.bot), 999) <= tol ? m.hdist(h.bot, ref.bot) : -m.hdist(h.bot, ref.bot); }, [refs[name], tol]);
let lobbyScreens = false, dh = 0, dg = 0;
for (let i = 0; i < (lobbyBoth ? 80 : 1) && !lobbyScreens; i++) { dh = await onScreen(A, 'host_select_mode'); dg = await onScreen(B, 'client_lobby'); lobbyScreens = dh >= 0 && dg >= 0; if (!lobbyScreens) await sleep(3000); }
check('MARIO LOBBY (screens): host Select Mode and guest "P1 is making selections"', lobbyScreens, `dist host ${Math.abs(dh)} guest ${Math.abs(dg)}`);
if (lobbyScreens) { const t = Date.now() - tStart; mark('MARIO_LOBBY on screen', { ms: t }); }
await A.screenshot({ path: path.join(OUT, 'host_end.png') }); await B.screenshot({ path: path.join(OUT, 'guest_end.png') });
// ---------------------------------------------------------------- GAMEPLAY (--game, optional --soak=sec): Puzzle Mode > Block Star, then the match runs; reference-free (the same taps as the native private test, verified by what the match does)
const SOAKRES = { samples: [] };
if (argv.includes('--game') && lobbyScreens) {
  // the menus advance per emulated FRAME: this sandbox runs the two emulators at ~30 fps, so every wait and hold is stretched by 60/fps (a phone at 60 fps runs them at K = 1)
  const fpsNow = Math.min((await stats(A))?.emuFps || 60, (await stats(B))?.emuFps || 60), K = Math.max(1, 60 / Math.max(15, fpsNow)); mark('game timing scale', { fps: Math.round(fpsNow), K: +K.toFixed(2) });
  const tap = async (p, x, y, hold = 400, wait = 1500) => { await p.evaluate(([x, y]) => window.dslinkPlay.player.touch(x, y, true), [x, y]); await sleep(hold * K); await p.evaluate(([x, y]) => window.dslinkPlay.player.touch(x, y, false), [x, y]); await sleep(wait * K); };
  const press = async (p, b, hold = 250, wait = 1000) => { await p.evaluate((b) => window.dslinkPlay.player.btn(b, true), b); await sleep(hold * K); await p.evaluate((b) => window.dslinkPlay.player.btn(b, false), b); await sleep(wait * K); };
  const sig = (p) => p.evaluate(async () => { const g = await window.dslinkPlay.grab(), o = []; for (let y = 0; y < 384; y += 4) for (let x = 0; x < 256; x += 4) { const i = (y * 256 + x) * 4; o.push((g[i] + g[i + 1] + g[i + 2]) / 3 | 0); } return o; });
  const diff = (a, b, y0, y1) => { let n = 0; for (let y = y0 / 4; y < y1 / 4; y++) for (let x = 0; x < 64; x++) if (Math.abs(a[y * 64 + x] - b[y * 64 + x]) > 30) n++; return n; };
  const H = A, C = B;
  mark('game: Puzzle Mode'); await tap(H, 0.28, 0.80); await tap(H, 0.88, 0.965, 500, 14000);
  await tap(H, 0.5, 0.645); await tap(H, 0.88, 0.965, 500, 6000);
  await tap(H, 0.2, 0.59, 400, 1500); await tap(C, 0.65, 0.59, 400, 2000);
  await tap(H, 0.88, 0.965, 500, 1000); await tap(C, 0.88, 0.965, 500, 3000);
  await tap(H, 0.33, 0.80); await tap(H, 0.88, 0.965, 500, 8000);
  await press(C, 'a', 250, 2000); await press(H, 'a', 250, 12000);
  let ok = false, dhb = 0, dct = 0, dcb = 0;
  for (let t = 0; t < 8 && !ok; t++) {
    const a0 = await sig(H), b0 = await sig(C); await H.evaluate(() => window.dslinkPlay.player.btn('left', true)); await sleep(1200 * K); await H.evaluate(() => window.dslinkPlay.player.btn('left', false)); await sleep(600 * K);
    const a1 = await sig(H), b1 = await sig(C); dhb = diff(a0, a1, 192, 384); dct = diff(b0, b1, 0, 192); dcb = diff(b0, b1, 192, 384);
    ok = dhb > 15 && dct > 15 && dcb < dhb / 2; if (!ok) await sleep(5000);
  }
  check('GAMEPLAY: a real Block Star match runs on both consoles; each console\'s own input moves its own hand and the mirror on the other', ok, `host-bottom ${dhb} guest-top ${dct} guest-bottom ${dcb}`);
  mark('gameplay running');
  const endSoak = Date.now() + SOAK * 1000; let errs = 0, deauth0 = (await stats(A))?.dl?.dl_counters?.deauth || 0, minFps = 99, n = 0, alive = true;
  while (Date.now() < endSoak && alive) {
    for (const [p, b] of [[H, 'left'], [C, 'right'], [H, 'right'], [C, 'left']]) { await press(p, b, 400, 1500); }
    const sa = await stats(A), sb = await stats(B); n++;
    const st = [sa?.dl?.dl_state, sb?.dl?.dl_state]; if (st.includes('ERROR')) errs++;
    minFps = Math.min(minFps, sa?.emuFps || 0, sb?.emuFps || 0);
    SOAKRES.samples.push({ t: Math.round((Date.now() - T0) / 1000), st, fpsA: Math.round(sa?.emuFps || 0), fpsB: Math.round(sb?.emuFps || 0), deauth: sa?.dl?.dl_counters?.deauth, rtt: sa?.peer?.rtt?.avg, lost: [sa?.peer?.lost, sb?.peer?.lost], drops: [sa?.peer?.droppedHard, sb?.peer?.droppedHard] });
    alive = (await sess(A))?.state === 'playing' && (await sess(B))?.state === 'playing';
    if (n % 6 === 0) mark('soak', SOAKRES.samples[SOAKRES.samples.length - 1]);
  }
  const dA = await stats(A);
  if (SOAK) check(`GAMEPLAY SOAK ${SOAK}s: no transmission error (DS state never ERROR, no deauthentication), session alive, emulation never stalled`, errs === 0 && alive && ((dA?.dl?.dl_counters?.deauth || 0) === deauth0) && minFps > 15, `errors ${errs}, alive ${alive}, deauth ${deA(dA)}, min fps ${minFps}`);
  function deA(x) { return (x?.dl?.dl_counters?.deauth || 0) + '/' + deauth0; }
  await A.screenshot({ path: path.join(OUT, 'host_game.png') }); await B.screenshot({ path: path.join(OUT, 'guest_game.png') });
}
// structured radio traces of both consoles (no payload) -> summaries comparable with the native Runtime's DSLINK_MP_TRACE (tools/mp_trace_summary.py)
const traces = {}; for (const [n, pg] of [['host', A], ['guest', B]]) { const t = await pg.evaluate(() => window.dslinkPlay.player.radioTrace()).catch(() => ({ events: [] })); fs.writeFileSync(path.join(OUT, `trace_${n}.json`), JSON.stringify(t));
  try { traces[n] = JSON.parse(execFileSync('python3', [new URL('../../tools/mp_trace_summary.py', import.meta.url).pathname, n, path.join(OUT, `trace_${n}.json`)], { encoding: 'utf8' })); } catch (e) { traces[n] = { error: String(e).slice(0, 100) }; } }
const summary = { name: NAME, traces, coi: COI, ringMsg: RINGMSG, impair: { delay: opt('delay'), jitter: opt('jitter'), loss: opt('loss') }, hostTimeline: aa?.timeline, guestTimeline: ab?.timeline, host: sa, guest: sb,
  durations: { discoveryToDownloadMs: tb.DOWNLOAD_BEGIN - tb.GUEST_DISCOVERED, downloadMs: tb.DOWNLOAD_COMPLETE - tb.DOWNLOAD_BEGIN, downloadToBootMs: tb.GUEST_BOOT - tb.DOWNLOAD_COMPLETE, bootToLobbyMs: tb.MARIO_LOBBY - tb.GUEST_BOOT, totalMs: Date.now() - tStart }, checks: results, soak: SOAKRES };
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(summary, null, 1));
console.log(JSON.stringify(summary.durations), JSON.stringify({ rtt: sa?.peer?.rtt, jitter: sa?.peer?.jitter, lost: [sa?.peer?.lost, sb?.peer?.lost], ringDropped: [sa?.ringDropped, sb?.ringDropped], lagMax: [sa?.core?.lagMax, sb?.core?.lagMax] }));
await browser.close(); server.close(); sig.close();
const ok = results.filter((r) => r.ok).length; console.log(`${ok}/${results.length} checks passed`); process.exit(ok === results.length ? 0 : 1);
