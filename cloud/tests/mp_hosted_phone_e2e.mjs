// Hosted V0, "phone host + iPhone guest", end to end on the desktop: ONE gateway started the way the Android app starts it (its own console P1 in shared memory for the native
// display, UI API loopback-only, the web guest page and the stream open to the LAN) and a SECOND device that is only a browser (iPhone user agent, touch, a LAN address,
// not loopback): it opens the guest page, joins by the QR's web address and by code, receives the second console as video/audio over WebRTC and sends buttons/touch back.
// Homebrew ROMs only. usage: node mp_hosted_phone_e2e.mjs <rom1.nds> <rom2.nds> <shm_probe> <lan-ip> [screenshot-dir]
// (the codec is VP8 here because Playwright's Chromium has no H.264 decoder; the Android build's H.264 comes from MediaCodec and is covered by the emulator tests.)
import { chromium } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startDevice, sleep, runtimeCount, waitState } from './mplib.mjs';

const [rom1, rom2, probe, LAN, shots = '/tmp/mphosted'] = process.argv.slice(2);
fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const until = async (f, ms = 15000, step = 150) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
const OFF = JSON.parse(execFileSync(probe, ['--offsets']).toString());
const PAD = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11, l2: 12, r2: 13 };
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
let A, browser;
process.on('exit', () => { A && A.stop(); });
const shmOf = (d) => `${d.dir}/av.shm`;
const probeRun = (d, secs, ...a) => { try { return JSON.parse(execFileSync(probe, [shmOf(d), String(secs), ...a], { timeout: 30000 }).toString().trim().split('\n').pop()); } catch (e) { return { ok: false, error: String(e) }; } };
const ppm = (path) => { const b = fs.readFileSync(path); const i = b.indexOf('255\n') + 4; const [w] = b.subarray(0, i).toString().split(/\s+/).slice(1, 3).map(Number); return { w, px: (x, y) => [...b.subarray(i + (y * w + x) * 3, i + (y * w + x) * 3 + 3)] }; };
const whiteTop = (p) => { let n = 0; for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) { const q = p.px(x, y); if (q[0] > 230 && q[1] > 230 && q[2] > 230) n++; } return n; };
const text = (p, sel) => p.locator(sel).first().innerText();
const screenIs = (p, name) => p.evaluate((n) => document.body.dataset.screen === n, name);

function bridgeFor(dev) {   // what the app's Kotlin + JNI do with the page's calls (P1, the host's own console)
  const calls = { layout: [], visible: [], btn: 0, touch: 0 };
  let buttons = 0;
  const wr = (off, buf) => { const fd = fs.openSync(shmOf(dev), 'r+'); fs.writeSync(fd, buf, 0, buf.length, off); fs.closeSync(fd); };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  return { calls,
    btn: (k, d) => { calls.btn++; if (!(k in PAD)) return; buttons = d ? (buttons | (1 << PAD[k])) : (buttons & ~(1 << PAD[k])); wr(OFF.buttons, u32(buttons)); },
    touch: () => { calls.touch++; },
    layout: (a) => calls.layout.push(a), visible: (v) => calls.visible.push(v) };
}

// the gateway as the Android app starts it (no NO_ENCODER: the phone has MediaCodec), reachable on the LAN address
A = startDevice({ name: 'A', port: 8090, udp: 47841, peerUdp: 47842, testGuestRom: rom2,
  extraEnv: { DSLINK_UI_LOOPBACK_ONLY: '1', DSLINK_SHM_PATH: '/tmp/mpdev_A/av.shm', DSLINK_ADVERTISE_IP: LAN, DSLINK_DEV: '1', DSLINK_WEBRTC_ADVERTISE: '1' } });
await A.ready();
const LANBASE = `http://${LAN}:8090`;
browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns', '--no-proxy-server'] });

// ---- the host phone's page (its own WebView: loopback, with the app bridge)
const bA = bridgeFor(A);
const hctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
const pa = await hctx.newPage();
await pa.exposeFunction('__ds_btn', (k, d) => bA.btn(k, d)); await pa.exposeFunction('__ds_touch', (x, y, d) => bA.touch(x, y, d));
await pa.exposeFunction('__ds_layout', (a) => bA.layout(a)); await pa.exposeFunction('__ds_visible', (v) => bA.visible(v));
await pa.addInitScript(() => { window.DSLinkAndroid = { btn: (k, d) => window.__ds_btn(k, d), touch: (x, y, d) => window.__ds_touch(x, y, d), setLayout: (...a) => window.__ds_layout(a),
  gameVisible: (v) => window.__ds_visible(v), openSystemFiles() {}, setDevOverlay() {} }; });
await pa.goto(`${A.base}/mp/`); await pa.waitForFunction(() => document.body.dataset.screen);

// ---- LAN exposure: what another device may and may not reach
const code0 = async (path, method = 'GET') => (await fetch(LANBASE + path, { method })).status;
check('LAN: the guest page, its scripts and the touch controls are served', (await code0('/guest/')) === 200 && (await code0('/mp/mp.js')) === 200 && (await code0('/controls/controls.js')) === 200 && (await code0('/guest/manifest.webmanifest')) === 200);
check('LAN: the host\'s own UI API and pages stay private (library, create, state, /mp/, dev snapshot)', (await code0('/api/mp/library')) === 403 && (await code0('/api/mp/create', 'POST')) === 403 && (await code0('/api/mp/state')) === 403 && (await code0('/mp/')) === 403 && (await code0('/api/mp/dev/snapshot?slot=1')) === 403);
check('LAN: the host UI still works from the app itself (loopback)', (await code0.call(null, '/api/mp/state')) === 403 && (await fetch(`${A.base}/api/mp/state`)).ok);

// ---- host: create a room with the homebrew game
await pa.click('#btnCreate'); await pa.waitForFunction(() => document.body.dataset.screen === 'create');
await pa.setInputFiles('#romFile', rom1); await until(() => pa.locator('#gameList li.sel').count());
if (!(await pa.locator('#gameList li.sel').count())) await pa.locator('#gameList li').first().click();
await pa.click('#btnMakeRoom'); await pa.waitForFunction(() => document.body.dataset.screen === 'lobby', null, { timeout: 10000 });
const code = await text(pa, '#lobbyCode');
const hs = await A.state();
check('host lobby: 6-digit code and a QR that is a web address on the LAN (no IP shown to the user)', /^\d{6}$/.test(code) && hs.qr.startsWith(`http://${LAN}:8090/guest/?c=${code}&s=`) && !(await pa.locator('body').innerText()).includes(LAN), hs.qr.slice(0, 60));

// ---- the iPhone: Safari-like browser on the LAN address
const ictx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, userAgent: IPHONE_UA });
const pi = await ictx.newPage();
const iErrors = []; pi.on('pageerror', (e) => iErrors.push(String(e)));
if (process.env.DEBUG_E2E) { pi.on('console', (m) => console.log('[iphone console]', m.text())); pi.on('websocket', (w) => { console.log('[iphone ws]', w.url()); w.on('close', () => console.log('[iphone ws] closed')); w.on('socketerror', (e) => console.log('[iphone ws] error', e)); w.on('framereceived', (f) => console.log('[iphone ws] <-', String(f.payload).slice(0, 80))); w.on('framesent', (f) => console.log('[iphone ws] ->', String(f.payload).slice(0, 80))); }); }
await pi.goto(`${LANBASE}/guest/`); await pi.waitForFunction(() => document.body.dataset.screen);
check('guest page: join screen, no create/library/scan/nearby/IP, Home-Screen app metadata present', await pi.evaluate(() => {
  const vis = (s) => { const e = document.querySelector(s); return e && getComputedStyle(e).display !== 'none'; };
  return document.body.classList.contains('guest') && document.body.dataset.screen === 'join' && !vis('#btnCreate') && !vis('#btnScan') && !vis('#nearbyList') &&
    !!document.querySelector('link[rel=manifest]') && !!document.querySelector('link[rel=apple-touch-icon]') && document.querySelector('meta[name=apple-mobile-web-app-capable]').content === 'yes'; }));
await pi.screenshot({ path: `${shots}/iphone-join.png` });
// wrong code first, inline error
await pi.fill('#codeInput', code === '000000' ? '111111' : '000000'); await pi.click('#btnJoinCode');
check('wrong code: the message appears inline on the join screen', await until(async () => /non valido|scaduto/i.test(await text(pi, '#joinErr')), 8000));
await pi.fill('#codeInput', code); await pi.click('#btnJoinCode');
check('join by code: the iPhone reaches the lobby', await until(async () => (await screenIs(pi, 'lobby')), 20000));
check('the host\'s lobby shows the iPhone as the second player', await until(async () => /iPhone/.test(await text(pa, '#players')), 10000));
await pi.screenshot({ path: `${shots}/iphone-lobby.png` });
check('guest lobby: no network quality row for a browser guest, PRONTO available', await pi.evaluate(() => getComputedStyle(document.querySelector('.netrow')).display === 'none') && await until(() => pi.locator('#btnReady').isVisible(), 8000));
await pi.click('#btnReady');
await until(async () => !(await pa.locator('#btnStart').isDisabled()), 10000);
await pa.screenshot({ path: `${shots}/host-lobby.png` });
await pa.click('#btnStart');
const sa = await waitState(A, (s) => s.state === 'IN_GAME', 90000);
check('Hosted is chosen by itself for a browser guest and the host reaches IN_GAME', sa.state === 'IN_GAME' && sa.mode.effective === 'hosted', `${sa.state} ${sa.mode && sa.mode.effective}`);
check('two consoles run on the host device (P1 + the guest\'s)', await until(() => runtimeCount() === 2, 10000), `runtimes ${runtimeCount()}`);
if (process.env.DEBUG_E2E) { console.log('[debug] api/status', JSON.stringify((await (await fetch(`${A.base}/api/status`)).json()).room).slice(0, 200)); console.log('[debug] guest ingame', JSON.stringify((await (await fetch(`${LANBASE}/g/${await pi.evaluate(() => localStorage.getItem('dslink.guest.sid'))}/api/mp/state`)).json()).ingame)); }
const inGameIphone = await until(() => pi.evaluate(() => document.body.classList.contains('ingame') && document.querySelectorAll('#game .ctl-c').length > 0 && !!window.dslinkGame && !!window.dslinkGame.pc), 30000);
check('the iPhone shows the game screen with the frozen touch controls', inGameIphone);
await until(() => bA.calls.visible.includes(true), 10000);
check('the host\'s own page uses the native display for P1 (no <video>, surface shown)', bA.calls.visible.includes(true) && (await pa.evaluate(() => document.querySelectorAll('#game video').length === 0)));

// ---- video / audio of P2 reach the iPhone
const stats = () => pi.evaluate(async () => { const out = { v: 0, vb: 0, a: 0, vw: 0, vfd: 0, conn: '' }; const s = await window.dslinkGame.pc.getStats(); out.conn = window.dslinkGame.pc.connectionState;
  s.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') { out.v = r.packetsReceived; out.vb = r.bytesReceived; out.vfd = r.framesDecoded || 0; } if (r.type === 'inbound-rtp' && r.kind === 'audio') out.a = r.packetsReceived; });
  const v = window.dslinkGame.video; out.vw = v ? v.videoWidth : 0; return out; });
await until(async () => (await stats()).vfd > 30, 30000);
const s1 = await stats(); await sleep(2000); const s2 = await stats();
check('WebRTC direct on the LAN: connected', s1.conn === 'connected', s1.conn);
check('VIDEO P2: frames decoded and still arriving (~60 fps stream)', s2.vfd - s1.vfd > 60 && s2.vw > 0, `decoded ${s1.vfd} -> ${s2.vfd}, ${s2.vw}px wide`);
check('AUDIO P2: Opus packets arriving (50/s)', s2.a - s1.a > 60, `${s1.a} -> ${s2.a}`);
check('the page started the video muted for iOS autoplay and unmutes on the first touch', await pi.evaluate(() => window.dslinkGame.video.muted === true));
await pi.screenshot({ path: `${shots}/iphone-ingame.png` });
await pa.screenshot({ path: `${shots}/host-ingame.png` });
const sdev = await A.state(true);
const slot2 = (sdev.dev.slots || []).find((s) => s.id === 2) || {};
check('the second console runs at full speed and reports its encoder to the developer overlay', slot2.fps > 50 && slot2.peer_connected === true, `fps ${slot2.fps} enc ${JSON.stringify(slot2.enc)} rtt ${slot2.peer_rtt_ms}`);

// ---- input isolation: iPhone -> P2 only, host -> P1 only
const snap = async (idx, path) => { const r = await fetch(`${A.base}/api/mp/dev/snapshot?slot=${idx}`); fs.writeFileSync(path, Buffer.from(await r.arrayBuffer())); return r.ok; };
const decodePng = (path) => pa.evaluate(async (b64) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; return { w: c.width, h: c.height, px: Array.from(d) }; }, fs.readFileSync(path).toString('base64'));
const aLit = async (idx, name) => { await snap(idx, `${shots}/${name}.png`); const im = await decodePng(`${shots}/${name}.png`); const o = (74 * im.w + 214) * 4; return im.px[o] > 200 && im.px[o + 1] < 120; };
const rectOf = (p, sel) => p.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; }, sel);
const cdp = await ictx.newCDPSession(pi);
const face = await rectOf(pi, '[data-id=actions] [data-face=a]');
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: face.cx, y: face.cy, id: 1 }] }); await sleep(600);
const p2Lit = await aLit(1, 'p2_A'), p1Lit = await aLit(0, 'p1_while_iphone_A');
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
check('INPUT P2: A on the iPhone\'s touch controls lights the A square of console 2 and NOT console 1', p2Lit && !p1Lit, `P2 ${p2Lit} P1 ${p1Lit}`);
check('after the first touch the iPhone\'s video is unmuted (sound on)', await pi.evaluate(() => window.dslinkGame.video.muted === false));
await pa.evaluate(() => window.dslinkGame.btn('a', true)); await sleep(600);
const p1Lit2 = await aLit(0, 'p1_A'), p2Lit2 = await aLit(1, 'p2_while_host_A');
await pa.evaluate(() => window.dslinkGame.btn('a', false));
check('INPUT P1: A on the host\'s own controls lights console 1 and NOT console 2', p1Lit2 && !p2Lit2, `P1 ${p1Lit2} P2 ${p2Lit2}`);
// stylus on the iPhone: bottom screen -> crosshair on console 2's top screen
await snap(1, `${shots}/p2_before.png`); const before = await decodePng(`${shots}/p2_before.png`);
const countWhite = (im) => { let n = 0; for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) { const o = (y * im.w + x) * 4; if (im.px[o] > 230 && im.px[o + 1] > 230 && im.px[o + 2] > 230) n++; } return n; };
const bb = await pi.evaluate(() => { const v = window.dslinkGame.video.getBoundingClientRect(); return { x: v.x, y: v.y, w: v.width, h: v.height }; });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bb.x + bb.w * 0.5, y: bb.y + bb.h * 0.75, id: 2 }] }); await sleep(600);
await snap(1, `${shots}/p2_touch.png`); const after = await decodePng(`${shots}/p2_touch.png`);
await snap(0, `${shots}/p1_touch.png`); const p1t = await decodePng(`${shots}/p1_touch.png`);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
check('TOUCH P2: stylus on the iPhone\'s bottom screen appears on console 2 only (white pixels)', countWhite(after) - countWhite(before) > 15 && countWhite(p1t) < countWhite(after) - 10, `P2 ${countWhite(before)} -> ${countWhite(after)}, P1 ${countWhite(p1t)}`);
check('exactly the events of the iPhone reached console 2 (input counter), the host\'s went to shared memory', ((await A.state(true)).dev.slots.find((s) => s.id === 2).input_events || 0) >= 4 && bA.calls.btn >= 2);

// ---- rotation + safe area on the iPhone
await pi.setViewportSize({ width: 844, height: 390 }); await sleep(900);
const land = await pi.evaluate(() => { const v = window.dslinkGame.video.getBoundingClientRect(); return { w: v.width, h: v.height, ctl: document.querySelectorAll('#game .ctl-c').length }; });
check('rotation: the picture keeps its 2:3 ratio and the controls re-lay out', Math.abs(land.w / land.h - 2 / 3) < 0.02 && land.ctl > 0, JSON.stringify(land));
await pi.screenshot({ path: `${shots}/iphone-landscape.png` });
await pi.setViewportSize({ width: 390, height: 844 }); await sleep(500);

// ---- Safari goes to the background briefly and comes back: the same session continues
const sid = await pi.evaluate(() => localStorage.getItem('dslink.guest.sid'));
await pi.goto('about:blank'); await sleep(7000);
const mid = await A.state();
check('iPhone away for a few seconds: the host shows the reconnection state, the game is kept', ['RECONNECTING', 'IN_GAME'].includes(mid.state), mid.state);
await pi.goto(`${LANBASE}/guest/`);
const back = await until(() => pi.evaluate(() => document.body.classList.contains('ingame') && !!window.dslinkGame && window.dslinkGame.pc && window.dslinkGame.pc.connectionState === 'connected'), 40000);
const sBack = await A.state();
check('back within the grace period: same session, stream rebuilt, host IN_GAME again', back && sBack.state === 'IN_GAME' && (await pi.evaluate(() => localStorage.getItem('dslink.guest.sid'))) === sid, sBack.state);
const s3 = await stats(); await sleep(1500); const s4 = await stats();
check('video flows again after the reconnection', s4.vfd - s3.vfd > 40, `${s3.vfd} -> ${s4.vfd}`);

// ---- the iPhone disappears for good: the session ends cleanly, everything is released
await ictx.close();
const ended = await waitState(A, (s) => s.state === 'ENDED' || s.state === 'ERROR', 45000);
check('iPhone gone for good: the host is told "Connessione con il giocatore persa."', ended.state === 'ENDED' && ended.error && ended.error.message === 'Connessione con il giocatore persa.', `${ended.state} ${ended.error && ended.error.message}`);
check('cleanup: both consoles and the stream are released', await until(() => runtimeCount() === 0, 20000), `runtimes ${runtimeCount()}`);
check('the host\'s native surface is hidden again', await until(() => bA.calls.visible[bA.calls.visible.length - 1] === false, 10000));
check('no JavaScript error on the iPhone page', iErrors.length === 0, iErrors.join(' | ').slice(0, 200));
await browser.close();
const ok = results.filter(Boolean).length;
console.log(`${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
