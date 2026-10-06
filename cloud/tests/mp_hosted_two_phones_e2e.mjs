// Hosted V0 with TWO iPhone guests, end to end on the desktop (the same setup as mp_hosted_phone_e2e.mjs, one more browser): ONE gateway started the way the Android app starts it (its own console P1 in shared memory for the native
// display, UI API loopback-only, the web guest page and the stream open to the LAN) and a SECOND device that is only a browser (iPhone user agent, touch, a LAN address,
// not loopback): it opens the guest page, joins by the QR's web address and by code, receives the second console as video/audio over WebRTC and sends buttons/touch back.
// Homebrew ROMs only. usage: node mp_hosted_two_phones_e2e.mjs <rom1.nds> <rom2.nds> <shm_probe> <lan-ip> [screenshot-dir]
// (the codec is VP8 here because Playwright's Chromium has no H.264 decoder; the Android build's H.264 comes from MediaCodec and is covered by the emulator tests.)
import { chromium } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startDevice, sleep, runtimeCount, waitState } from './mplib.mjs';

const [rom1, rom2, probe, LAN, shots = '/tmp/mphosted2'] = process.argv.slice(2);
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
  let buttons = 0, tseq = 0;
  const wr = (off, buf) => { const fd = fs.openSync(shmOf(dev), 'r+'); fs.writeSync(fd, buf, 0, buf.length, off); fs.closeSync(fd); };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  return { calls,
    btn: (k, d) => { calls.btn++; if (!(k in PAD)) return; buttons = d ? (buttons | (1 << PAD[k])) : (buttons & ~(1 << PAD[k])); wr(OFF.buttons, u32(buttons)); },
    touch: (x, y, d) => { calls.touch++; const q = (v) => BigInt(Math.round(Math.max(0, Math.min(1, v)) * 65535)); const t = (d ? 1n : 0n) | (q(x) << 1n) | (q(y) << 17n); const b = Buffer.alloc(8); b.writeBigUInt64LE(t); wr(OFF.touch, b); wr(OFF.touchSeq, u32(++tseq)); },
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

// ---- two iPhones: separate Safari-like browsers, same code
const phones = [];
async function newPhone(label) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, userAgent: IPHONE_UA });
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${LANBASE}/guest/`); await page.waitForFunction(() => document.body.dataset.screen);
  return { label, ctx, page, errors };
}
const A1 = await newPhone('iPhone 1'), A2 = await newPhone('iPhone 2'); phones.push(A1, A2);
await A1.page.fill('#codeInput', code); await A1.page.click('#btnJoinCode');
check('iPhone 1 joins by the room code', await until(async () => (await screenIs(A1.page, 'lobby')), 20000));
await A2.page.goto((await A.state()).qr);   // iPhone 2: the QR's web address (what the Camera app opens)
check('iPhone 2 joins with the same room (the QR address)', await until(async () => (await screenIs(A2.page, 'lobby')), 20000));
check('the host lobby lists HOST, PLAYER 2 and PLAYER 3 (both iPhones)', await until(async () => { const t = await text(pa, '#players'); return /PLAYER 2 · iPhone/.test(t) && /PLAYER 3 · iPhone/.test(t); }, 15000), (await text(pa, '#players')).replace(/\n/g, ' | '));
check('each iPhone sees both players and its own ready button', await until(async () => (await text(A1.page, '#players')).includes('PLAYER 3 · iPhone') && (await text(A2.page, '#players')).includes('PLAYER 2 · iPhone') && await A1.page.locator('#btnReady').isVisible() && await A2.page.locator('#btnReady').isVisible(), 15000));
await A1.page.click('#btnReady');
await sleep(1500);
check('START stays disabled while PLAYER 3 is not ready', await pa.locator('#btnStart').isDisabled());
await A2.page.click('#btnReady');
await until(async () => !(await pa.locator('#btnStart').isDisabled()), 10000);
await pa.screenshot({ path: `${shots}/host-lobby-3.png` }); await A1.page.screenshot({ path: `${shots}/iphone1-lobby.png` }); await A2.page.screenshot({ path: `${shots}/iphone2-lobby.png` });
const third = await newPhone('iPhone 3'); phones.push(third);
await third.page.fill('#codeInput', code); await third.page.click('#btnJoinCode');
check('a third browser finds the room full', await until(async () => /completo/i.test(await text(third.page, '#joinErr')), 10000), await text(third.page, '#joinErr'));
await pa.click('#btnStart');
const sa = await waitState(A, (s) => s.state === 'IN_GAME', 120000);
check('Hosted with two guests: the host reaches IN_GAME', sa.state === 'IN_GAME' && sa.mode.effective === 'hosted', `${sa.state} ${sa.mode && sa.mode.effective}`);
check('THREE consoles run on the host device', await until(() => runtimeCount() === 3, 15000), `runtimes ${runtimeCount()}`);
const mounted = async (p) => until(() => p.page.evaluate(() => document.body.classList.contains('ingame') && document.querySelectorAll('#game .ctl-c').length > 0 && !!window.dslinkGame && !!window.dslinkGame.pc), 40000);
check('both iPhones show the game screen with the frozen touch controls', (await mounted(A1)) && (await mounted(A2)));
for (const p of phones.slice(0, 2)) p.player = Number(await p.page.evaluate(() => new URL(window.dslinkGame.ws.url).searchParams.get('player')));
check('each iPhone was given a different console (PLAYER 2 and PLAYER 3)', new Set([A1.player, A2.player]).size === 2 && A1.player + A2.player === 5, `${A1.player}/${A2.player}`);
const stats = (p) => p.page.evaluate(async () => { const out = { v: 0, a: 0, vfd: 0, conn: '' }; const s = await window.dslinkGame.pc.getStats(); out.conn = window.dslinkGame.pc.connectionState;
  s.forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'video') out.vfd = r.framesDecoded || 0; if (r.type === 'inbound-rtp' && r.kind === 'audio') out.a = r.packetsReceived; }); return out; });
await until(async () => (await stats(A1)).vfd > 30 && (await stats(A2)).vfd > 30, 40000);
const a1 = await stats(A1), a2 = await stats(A2); await sleep(2000); const b1 = await stats(A1), b2 = await stats(A2);
check('WEBRTC P2: direct LAN peer connection', a1.conn === 'connected' && (A1.player === 2 ? true : true), `${a1.conn}`);
check('WEBRTC P3: direct LAN peer connection', a2.conn === 'connected', `${a2.conn}`);
check('VIDEO (iPhone 1): decoded frames keep arriving', b1.vfd - a1.vfd > 60, `${a1.vfd} -> ${b1.vfd}`);
check('VIDEO (iPhone 2): decoded frames keep arriving', b2.vfd - a2.vfd > 60, `${a2.vfd} -> ${b2.vfd}`);
check('AUDIO (iPhone 1): Opus packets arriving', b1.a - a1.a > 60, `${a1.a} -> ${b1.a}`);
check('AUDIO (iPhone 2): Opus packets arriving', b2.a - a2.a > 60, `${a2.a} -> ${b2.a}`);
const dev = (await A.state(true)).dev.slots;
const sl = (id) => dev.find((s) => s.id === id) || {};
check('all three consoles run at full speed; both guests connected; the host overlay data is there (fps, WebRTC RTT)', [1, 2, 3].every((i) => sl(i).fps > 50) && sl(2).peer_connected === true && sl(3).peer_connected === true && sl(2).peer_rtt_ms > 0 && sl(3).peer_rtt_ms > 0,
  `fps ${[1, 2, 3].map((i) => Math.round(sl(i).fps))} rtt ${sl(2).peer_rtt_ms}/${sl(3).peer_rtt_ms}`);
await A1.page.screenshot({ path: `${shots}/iphone1-ingame.png` }); await A2.page.screenshot({ path: `${shots}/iphone2-ingame.png` });

// ---- input isolation: iPhone N -> console N only
const snap = async (idx, path) => { const r = await fetch(`${A.base}/api/mp/dev/snapshot?slot=${idx}`); fs.writeFileSync(path, Buffer.from(await r.arrayBuffer())); return r.ok; };
const decodePng = (path) => pa.evaluate(async (b64) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d'); g.drawImage(img, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; return { w: c.width, h: c.height, px: Array.from(d) }; }, fs.readFileSync(path).toString('base64'));
const aLit = async (idx, name) => { await snap(idx, `${shots}/${name}.png`); const im = await decodePng(`${shots}/${name}.png`); const o = (74 * im.w + 214) * 4; return im.px[o] > 200 && im.px[o + 1] < 120; };
const countWhite = (im) => { let n = 0; for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) { const o = (y * im.w + x) * 4; if (im.px[o] > 230 && im.px[o + 1] > 230 && im.px[o + 2] > 230) n++; } return n; };
const rectOf = (p, sel) => p.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; }, sel);
for (const P of [A1, A2]) P.cdp = await P.ctx.newCDPSession(P.page);
const pressA = async (P) => { const f = await rectOf(P.page, '[data-id=actions] [data-face=a]'); await P.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: f.cx, y: f.cy, id: 1 }] }); await sleep(600); };
const release = (P) => P.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
for (const [P, Q, nameP] of [[A1, A2, 'INPUT P' + 'x'], [A2, A1, 'INPUT P' + 'y']]) {
  await pressA(P);
  const mine = await aLit(P.player - 1, `lit_${P.label.replace(' ', '')}`), others = [0, 1, 2].filter((i) => i !== P.player - 1);
  const oth = [await aLit(others[0], `lit_o1_${P.label.replace(' ', '')}`), await aLit(others[1], `lit_o2_${P.label.replace(' ', '')}`)];
  await release(P);
  check(`INPUT P${P.player}: A on ${P.label}'s controls lights console ${P.player} and NO other console`, mine && !oth[0] && !oth[1], `own ${mine} others ${oth}`);
  await sleep(500);
}
for (const P of [A1, A2]) {   // stylus: the bottom screen of THIS iPhone's console only
  await snap(P.player - 1, `${shots}/t_before_${P.player}.png`); const before = await decodePng(`${shots}/t_before_${P.player}.png`);
  const bb = await P.page.evaluate(() => { const v = window.dslinkGame.video.getBoundingClientRect(); return { x: v.x, y: v.y, w: v.width, h: v.height }; });
  await P.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bb.x + bb.w * 0.5, y: bb.y + bb.h * 0.75, id: 2 }] }); await sleep(600);
  await snap(P.player - 1, `${shots}/t_after_${P.player}.png`); const after = await decodePng(`${shots}/t_after_${P.player}.png`);
  const o = [0, 1, 2].filter((i) => i !== P.player - 1); const others = []; for (const i of o) { await snap(i, `${shots}/t_other_${P.player}_${i}.png`); others.push(countWhite(await decodePng(`${shots}/t_other_${P.player}_${i}.png`))); }
  await P.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  check(`TOUCH P${P.player}: stylus on ${P.label} appears on console ${P.player} only`, countWhite(after) - countWhite(before) > 15 && others.every((n) => n < countWhite(after) - 10), `${countWhite(before)} -> ${countWhite(after)}, others ${others}`);
  await sleep(500);
}

// ---- iPhone 1 vanishes for good: its console is released, the host and iPhone 2 keep playing
const gone = A1, stay = A2;
await gone.ctx.close();
check('one iPhone gone: only its console is stopped (2 consoles left)', await until(() => runtimeCount() === 2, 60000), `runtimes ${runtimeCount()}`);
const mid = await A.state();
check('the game goes on (no reconnect screen, no end) for the host and the other iPhone', mid.state === 'IN_GAME' && (await stay.page.evaluate(() => document.body.classList.contains('ingame'))), mid.state);
const c0 = await stats(stay); await sleep(2000); const c1 = await stats(stay);
check('the other iPhone still receives its console (video keeps flowing)', c1.vfd - c0.vfd > 60 && c1.conn === 'connected', `${c0.vfd} -> ${c1.vfd}`);
await stay.ctx.close();
const ended = await waitState(A, (s) => s.state === 'ENDED' || s.state === 'ERROR', 60000);
check('last iPhone gone: the host is told "Connessione con il giocatore persa."', ended.state === 'ENDED' && ended.error && ended.error.message === 'Connessione con il giocatore persa.', `${ended.state} ${ended.error && ended.error.message}`);
check('cleanup: every console and stream is released', await until(() => runtimeCount() === 0, 20000), `runtimes ${runtimeCount()}`);
check('the host\'s native surface is hidden again', await until(() => bA.calls.visible[bA.calls.visible.length - 1] === false, 10000));
check('no JavaScript error on either iPhone page', A1.errors.length === 0 && A2.errors.length === 0, [...A1.errors, ...A2.errors].join(' | ').slice(0, 200));
await browser.close();
const ok = results.filter(Boolean).length;
console.log(`${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
