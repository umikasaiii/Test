// SINGLE PLAYER end to end on the desktop, the way the Android app runs it: ONE gateway, DSLINK_SHM_PATH (no encoder, the app draws the picture), the real library
// screen in a browser with the fake "DSLinkAndroid" bridge. GIOCA starts one Runtime and nothing else. Homebrew ROMs only.
// usage: node mp_single_e2e.mjs <rom1.nds> <rom2.nds> <shm_probe> [screenshot-dir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startDevice, sleep, runtimeCount, runtimePidsFor, waitState } from './mplib.mjs';

const [rom1, rom2, probe, shots = '/tmp/mpsingle'] = process.argv.slice(2);
fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const until = async (f, ms = 15000, step = 150) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
const OFF = JSON.parse(execFileSync(probe, ['--offsets']).toString());
const PAD = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11, l2: 12, r2: 13 };
let S, browser;
process.on('exit', () => { S && S.stop(); });
const shm = () => `${S.dir}/av.shm`;
const probeRun = (secs, ...a) => { try { return JSON.parse(execFileSync(probe, [shm(), String(secs), ...a], { timeout: 30000 }).toString().trim().split('\n').pop()); } catch (e) { return { ok: false, error: String(e) }; } };
const ppm = (path) => { const b = fs.readFileSync(path); const i = b.indexOf('255\n') + 4; const [w] = b.subarray(0, i).toString().split(/\s+/).slice(1, 3).map(Number); return { w, px: (x, y) => [...b.subarray(i + (y * w + x) * 3, i + (y * w + x) * 3 + 3)] }; };
const cmdlineOf = () => { const p = runtimePidsFor('S')[0]; return p ? fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').split('\0') : []; };
const api = async (path, body) => { const r = await fetch(`${S.base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { ok: r.ok, j: await r.json().catch(() => ({})) }; };

function bridge() {
  const calls = { layout: [], visible: [], btn: 0, touch: 0 };
  let buttons = 0, tseq = 0;
  const wr = (off, buf) => { const fd = fs.openSync(shm(), 'r+'); fs.writeSync(fd, buf, 0, buf.length, off); fs.closeSync(fd); };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  return { calls,
    btn: (k, d) => { calls.btn++; if (!(k in PAD)) return; buttons = d ? (buttons | (1 << PAD[k])) : (buttons & ~(1 << PAD[k])); wr(OFF.buttons, u32(buttons)); },
    touch: (x, y, d) => { calls.touch++; const q = (v) => BigInt(Math.round(Math.max(0, Math.min(1, v)) * 65535)); const t = (d ? 1n : 0n) | (q(x) << 1n) | (q(y) << 17n); const b = Buffer.alloc(8); b.writeBigUInt64LE(t); wr(OFF.touch, b); wr(OFF.touchSeq, u32(++tseq)); },
    layout: (a) => calls.layout.push(a), visible: (v) => calls.visible.push(v) };
}
async function newPage(br) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.exposeFunction('__ds_btn', (k, d) => br.btn(k, d)); await p.exposeFunction('__ds_touch', (x, y, d) => br.touch(x, y, d));
  await p.exposeFunction('__ds_layout', (a) => br.layout(a)); await p.exposeFunction('__ds_visible', (v) => br.visible(v));
  await p.addInitScript(() => { window.__rtc = 0; const R = window.RTCPeerConnection; if (R) window.RTCPeerConnection = function (...a) { window.__rtc++; return new R(...a); };
    window.DSLinkAndroid = { btn: (k, d) => window.__ds_btn(k, d), touch: (x, y, d) => window.__ds_touch(x, y, d), setLayout: (...a) => window.__ds_layout(a),
      gameVisible: (v) => window.__ds_visible(v), openSystemFiles() {}, setDevOverlay() {} }; });
  await p.goto(`${S.base}/mp/`); await p.waitForFunction(() => document.body.dataset.screen); return p;
}
const screens = [];

S = startDevice({ name: 'S', port: 8092, udp: 47843, peerUdp: 47844, extraEnv: { DSLINK_NO_ENCODER: '1', DSLINK_UI_LOOPBACK_ONLY: '1', DSLINK_SHM_PATH: '/tmp/mpdev_S/av.shm' } });
await S.ready();
browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox'] });
const br = bridge();
let pa = await newPage(br);
await pa.evaluate(() => { new MutationObserver(() => {}).observe(document.body, { attributes: true }); window.__seen = new Set(); setInterval(() => window.__seen.add(document.body.dataset.screen), 20); });

// ---- library: pick a game, see both CTAs
await pa.click('#btnCreate'); await pa.waitForFunction(() => document.body.dataset.screen === 'create');
check('before a game is selected the two CTAs are not offered', !(await pa.locator('#btnPlay').isVisible()));
await pa.setInputFiles('#romFile', rom1); await until(() => pa.locator('#gameList li.sel').count());
if (!(await pa.locator('#gameList li.sel').count())) await pa.locator('#gameList li').first().click();
check('GIOCA BUTTON: with a game selected the library shows [ GIOCA ]', await pa.locator('#btnPlay').isVisible() && (await pa.locator('#btnPlay').innerText()).trim() === 'GIOCA');
check('GIOCA CON AMICI: ... and [ GIOCA CON AMICI ] next to it', await pa.locator('#btnMakeRoom').isVisible() && (await pa.locator('#btnMakeRoom').innerText()).trim() === 'GIOCA CON AMICI');
const gameId = (await (await fetch(`${S.base}/api/mp/library`)).json()).games[0].id;
await pa.screenshot({ path: `${shots}/library-cta.png` });

// ---- GIOCA
await pa.click('#btnPlay');
const s1 = await waitState(S, (s) => s.state === 'IN_GAME', 30000);
check('SINGLE PLAYER START: GIOCA goes straight to IN_GAME (no lobby, no waiting)', s1.state === 'IN_GAME' && s1.single === true, `${s1.state}`);
await until(() => pa.evaluate(() => !!window.dslinkGame), 8000);
const seen = await pa.evaluate(() => [...window.__seen]);
check('NO ROOM CREATED: no code, no QR, no lobby screen, nothing advertised', !s1.code && !s1.qr && !seen.includes('lobby') && !seen.includes('joining') && (await (await fetch(`${S.base}/api/mp/state?dev=1`)).json()).dev.roomId === '', JSON.stringify(seen));
const cl = cmdlineOf();
check('ONE MELONDS ONLY: exactly one Runtime process', runtimePidsFor('S').length === 1 && runtimeCount() === 1);
check('NO ENCODER / NO NETWORK: the Runtime runs with shared memory only (no --av, no --codec, no --mp-*, no --lan-*)', cl.includes('--shm') && !cl.some((a) => /^--(av|codec|mp-|lan-)/.test(a)), cl.filter((a) => a.startsWith('--')).join(' '));
check('NO WEBRTC: no peer connection in the page, no <video>, no stream socket', (await pa.evaluate(() => window.__rtc === 0 && document.querySelectorAll('#game video').length === 0 && window.dslinkGame.native === true)));
check('the app is told to show the surface', await until(() => br.calls.visible.includes(true), 8000));
await until(() => br.calls.layout.length > 0, 8000);
const lay = br.calls.layout[br.calls.layout.length - 1] || [];
check('UI Touch V1: picture rectangle keeps the 2:3 DS proportions inside the phone', lay.length === 9 && Math.abs((lay[6] - lay[4]) / (lay[7] - lay[5]) - 2 / 3) < 0.01, JSON.stringify(lay.map((n) => Math.round(n))));
await pa.screenshot({ path: `${shots}/single-portrait.png` });
const f = probeRun(3, '--keep-input', '--dump-ppm', `${shots}/S.ppm`);
check('VIDEO LOCAL: raw 256x384 frames at ~60 fps from shared memory', f.ok && f.w === 256 && f.h === 384 && f.fps > 40, JSON.stringify(f).slice(0, 100));
check('AUDIO LOCAL: audio samples written to shared memory', f.ok && f.audio_frames > 30000, `audio_frames ${f.audio_frames}`);

// ---- INPUT + TOUCH
const rectOf = (sel) => pa.evaluate((sel) => { const e = document.querySelector(sel); const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; }, sel);
const face = await rectOf('[data-id=actions] [data-face=a]');
await pa.mouse.move(face.cx, face.cy); await pa.mouse.down(); await sleep(500);
probeRun(0.3, '--keep-input', '--dump-ppm', `${shots}/S_pressed.ppm`);
await pa.mouse.up();
const c = ppm(`${shots}/S_pressed.ppm`).px(214, 74);
check('INPUT: button A on the touch controls reaches the core', br.calls.btn >= 2 && c[0] > 200 && c[1] < 120, `calls ${br.calls.btn}, pixel ${c}`);
const white = (p) => { let n = 0; for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) { const q = p.px(x, y); if (q[0] > 230 && q[1] > 230 && q[2] > 230) n++; } return n; };
const before = white(ppm(`${shots}/S.ppm`));
const l2 = br.calls.layout[br.calls.layout.length - 1];
await pa.mouse.move(((l2[4] + l2[6]) / 2) / 2, (l2[5] + (l2[7] - l2[5]) * 0.75) / 2); await pa.mouse.down(); await sleep(500);
probeRun(0.3, '--keep-input', '--dump-ppm', `${shots}/S_touch.ppm`);
await pa.mouse.up();
const after = white(ppm(`${shots}/S_touch.ppm`));
check('TOUCH: stylus on the bottom screen reaches the DS touchscreen', br.calls.touch >= 2 && after - before > 15, `white px ${before} -> ${after}`);

// ---- ROTATION
const n0 = br.calls.layout.length;
await pa.setViewportSize({ width: 844, height: 390 }); await sleep(900);
const lay3 = br.calls.layout[br.calls.layout.length - 1];
check('ROTATION: landscape sends new rectangles, game keeps running, same Runtime', br.calls.layout.length > n0 && lay3[6] - lay3[4] > 0 && runtimePidsFor('S').length === 1 && probeRun(1, '--keep-input').fps > 40);
await pa.screenshot({ path: `${shots}/single-landscape.png` });
await pa.setViewportSize({ width: 390, height: 844 }); await sleep(500);

// ---- SAVE: the game's save folder is its own (keyed by the library id)
const saveDir = `${S.dir}/library/saves/${gameId}`;
check('SAVE CREATE: the Runtime was given this game\'s own persistent save folder', cl.includes('--save') && cl[cl.indexOf('--save') + 1] === saveDir && fs.existsSync(saveDir), cl[cl.indexOf('--save') + 1]);
// a save the user made earlier: put some bytes where the Runtime reads them, leave, play again -> the Runtime loads them back and writes them on exit
const srm = `${saveDir}/melonDS DS/${gameId}.srm`;
fs.mkdirSync(`${saveDir}/melonDS DS`, { recursive: true });

// ---- EXIT
await pa.evaluate(() => window.dslinkGame.controls.openMenu()); await pa.click('.ctl-menu [data-act=leave]'); await pa.click('#confirmYes');
check('EXIT CLEAN: surface hidden, Runtime gone, back to the library/home', await until(async () => br.calls.visible[br.calls.visible.length - 1] === false && runtimeCount() === 0 && (await pa.evaluate(() => document.body.dataset.screen)) === 'home', 20000), await pa.evaluate(() => document.body.dataset.screen));
const files = fs.existsSync(`${saveDir}/melonDS DS`) ? fs.readdirSync(`${saveDir}/melonDS DS`) : [];
console.log('save files:', files.join(','));
check('SAVE CREATE: the save folder survives the end of the game (not scratch)', fs.existsSync(saveDir));
const st = await S.state(); check('the session is idle again (nothing left of the game)', st.state === 'IDLE', st.state);

// ---- SAVE RELOAD: a mark in the save is loaded back on the next start and written again on exit (the game continues from its save)
const srmFile = `${saveDir}/melonDS DS/${gameId}.srm`;
const sv = fs.readFileSync(srmFile); const mark = Buffer.from('DSLINKSP');
Buffer.concat([mark, sv.subarray(8)]).copy(sv); sv.write('DSLINKSP', 0); fs.writeFileSync(srmFile, sv);
await api('/api/mp/reset'); const rs = await api('/api/mp/single', { gameId });
await waitState(S, (x) => x.state === 'IN_GAME', 30000); await sleep(1500);
await api('/api/mp/cancel'); await api('/api/mp/reset'); await until(() => runtimeCount() === 0, 15000);
const sv2 = fs.readFileSync(srmFile);
check('SAVE RELOAD: reopening the game loads its previous save (the mark survives a play session)', rs.ok && sv2.length === sv.length && sv2.subarray(0, 8).equals(mark), `${sv2.length} bytes`);

// ---- second game: its own folder, other game's untouched
await pa.reload(); await pa.waitForFunction(() => document.body.dataset.screen); await pa.click('#btnCreate'); await pa.waitForFunction(() => document.body.dataset.screen === 'create');
await pa.setInputFiles('#romFile', rom2); await until(async () => (await (await fetch(`${S.base}/api/mp/library`)).json()).games.length === 2);
const games = (await (await fetch(`${S.base}/api/mp/library`)).json()).games; const id2 = games.find((g) => g.id !== gameId).id;
const r2 = await api('/api/mp/single', { gameId: id2 });
await waitState(S, (s) => s.state === 'IN_GAME', 30000);
const cl2 = cmdlineOf();
check('SAVE separate per ROM: the second game gets another folder, the first is not shared', r2.ok && cl2[cl2.indexOf('--save') + 1] === `${S.dir}/library/saves/${id2}` && id2 !== gameId);
// a second start while playing is refused (one game at a time)
check('a second GIOCA while a game runs is refused', !(await api('/api/mp/single', { gameId })).ok);
// app goes to the background and returns: the page reloads (activity recreate) and the same console keeps running
const pidBefore = runtimePidsFor('S')[0];
await pa.reload(); await pa.waitForFunction(() => document.body.dataset.screen); await until(() => pa.evaluate(() => !!window.dslinkGame), 8000);
check('BACKGROUND/FOREGROUND: the page is rebuilt and attached to the same running console', runtimePidsFor('S')[0] === pidBefore && runtimePidsFor('S').length === 1);
await api('/api/mp/cancel'); await api('/api/mp/reset');
check('EXIT CLEAN (API): Runtime gone', await until(() => runtimeCount() === 0, 15000));
await browser.close();
const ok = results.filter(Boolean).length;
console.log(`${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
