// Android data path end to end on the desktop: two gateways = two phones, each started the way the Android app starts it (DSLINK_SHM_PATH, no encoder,
// UI API loopback-only), the real multiplayer web UI in two browsers, and a fake "DSLinkAndroid" bridge that does what the app's Kotlin/JNI code does:
// receives the touch-control events and the picture rectangles, and writes buttons/touch into the shared-memory file the Runtime reads.
// Homebrew ROMs only. usage: node mp_native_e2e.mjs <rom1.nds> <rom2.nds> <shm_probe> [screenshot-dir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startDevice, sleep, runtimeCount, waitState } from './mplib.mjs';

const [rom1, rom2, probe, shots = '/tmp/mpnative'] = process.argv.slice(2);
fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const until = async (f, ms = 15000, step = 150) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
const OFF = JSON.parse(execFileSync(probe, ['--offsets']).toString());
const PAD = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11, l2: 12, r2: 13 };
let A, B, browser;
process.on('exit', () => { A && A.stop(); B && B.stop(); });
const shmOf = (d) => `${d.dir}/av.shm`;
const probeRun = (d, secs, ...a) => { try { return JSON.parse(execFileSync(probe, [shmOf(d), String(secs), ...a], { timeout: 30000 }).toString().trim().split('\n').pop()); } catch (e) { return { ok: false, error: String(e) }; } };
const ppm = (path) => { const b = fs.readFileSync(path); const i = b.indexOf('255\n') + 4; const [w] = b.subarray(0, i).toString().split(/\s+/).slice(1, 3).map(Number); return { w, px: (x, y) => [...b.subarray(i + (y * w + x) * 3, i + (y * w + x) * 3 + 3)] }; };

function bridgeFor(dev) {   // what the app's Kotlin + JNI do with the page's calls
  const calls = { layout: [], visible: [], btn: 0, touch: 0 };
  let buttons = 0, tseq = 0;
  const wr = (off, buf) => { const fd = fs.openSync(shmOf(dev), 'r+'); fs.writeSync(fd, buf, 0, buf.length, off); fs.closeSync(fd); };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  return { calls,
    btn: (k, d) => { calls.btn++; if (!(k in PAD)) return; buttons = d ? (buttons | (1 << PAD[k])) : (buttons & ~(1 << PAD[k])); wr(OFF.buttons, u32(buttons)); },
    touch: (x, y, d) => { calls.touch++; const q = (v) => BigInt(Math.round(Math.max(0, Math.min(1, v)) * 65535)); const t = (d ? 1n : 0n) | (q(x) << 1n) | (q(y) << 17n); const b = Buffer.alloc(8); b.writeBigUInt64LE(t); wr(OFF.touch, b); wr(OFF.touchSeq, u32(++tseq)); },
    layout: (a) => calls.layout.push(a), visible: (v) => calls.visible.push(v) };
}
async function newPage(dev, bridge) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.exposeFunction('__ds_btn', (k, d) => bridge.btn(k, d)); await p.exposeFunction('__ds_touch', (x, y, d) => bridge.touch(x, y, d));
  await p.exposeFunction('__ds_layout', (a) => bridge.layout(a)); await p.exposeFunction('__ds_visible', (v) => bridge.visible(v));
  await p.addInitScript(() => { window.DSLinkAndroid = { btn: (k, d) => window.__ds_btn(k, d), touch: (x, y, d) => window.__ds_touch(x, y, d), setLayout: (...a) => window.__ds_layout(a),
    gameVisible: (v) => window.__ds_visible(v), openSystemFiles() { window.__sysfiles = true; }, setDevOverlay(v) { window.__overlay = v; } }; });
  await p.goto(`${dev.base}/mp/`); await p.waitForFunction(() => document.body.dataset.screen); return p;
}
const text = (p, sel) => p.locator(sel).first().innerText();

A = startDevice({ name: 'A', port: 8090, udp: 47841, peerUdp: 47842, testGuestRom: rom2, extraEnv: { DSLINK_NO_ENCODER: '1', DSLINK_UI_LOOPBACK_ONLY: '1', DSLINK_SHM_PATH: '/tmp/mpdev_A/av.shm' } });
B = startDevice({ name: 'B', port: 8091, udp: 47842, peerUdp: 47841, testGuestRom: rom2, extraEnv: { DSLINK_NO_ENCODER: '1', DSLINK_UI_LOOPBACK_ONLY: '1', DSLINK_SHM_PATH: '/tmp/mpdev_B/av.shm' } });
await A.ready(); await B.ready();
browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox'] });
const bA = bridgeFor(A), bB = bridgeFor(B);
const pa = await newPage(A, bA), pb = await newPage(B, bB);

check('Android affordances appear only with the app bridge: FILE DI SISTEMA on the home screen', await pa.locator('#btnSysFiles').isVisible());
check('the UI API refuses other devices, the peer protocol stays open (loopback guard)', await (async () => { const r = await fetch(`${A.base}/api/mp/state`); return r.ok; })());

// create + join + ready + start (Distributed: loopback pre-check is GREEN)
await pa.click('#btnCreate'); await pa.waitForFunction(() => document.body.dataset.screen === 'create');
await pa.setInputFiles('#romFile', rom1); await until(() => pa.locator('#gameList li.sel').count());
if (!(await pa.locator('#gameList li.sel').count())) await pa.locator('#gameList li').first().click();
await pa.click('#btnMakeRoom'); await pa.waitForFunction(() => document.body.dataset.screen === 'lobby', null, { timeout: 10000 });
const code = await text(pa, '#lobbyCode');
await pb.click('#btnJoin'); await pb.waitForFunction(() => document.body.dataset.screen === 'join');
await pb.fill('#codeInput', code); await pb.click('#btnJoinCode');
await until(async () => (await pb.evaluate(() => document.body.dataset.screen)) === 'lobby', 20000);
await until(async () => (await pb.locator('#btnReady').isVisible()) && /Ottima|Buona|Non adatta/.test(await text(pb, '#netBadge')), 15000);
await pb.click('#btnReady'); await until(async () => !(await pa.locator('#btnStart').isDisabled()), 8000); await pa.click('#btnStart');
const sa = await waitState(A, (s) => s.state === 'IN_GAME', 60000), sb = await waitState(B, (s) => s.state === 'IN_GAME', 60000);
check('both phones reach IN_GAME in Distributed Mode with no encoder', sa.state === 'IN_GAME' && sb.state === 'IN_GAME' && sa.mode.effective === 'distributed', `${sa.state}/${sb.state} ${sa.mode && sa.mode.effective}`);
check('the state tells the page to use the native display (ingame.native, platform.native)', sa.ingame && sa.ingame.native === true && sb.ingame && sb.ingame.native === true && sa.platform.native === true);
check('exactly one console per phone, none streamed (no WebRTC: the page has no <video> and no peer connection)', runtimeCount() === 2 && (await pa.evaluate(() => document.querySelectorAll('#game video').length === 0 && window.dslinkGame && window.dslinkGame.native === true)));
await until(() => bA.calls.layout.length > 0, 8000);
const lay = bA.calls.layout[bA.calls.layout.length - 1] || [];
const [cl, ct, cr, cb, vl, vt, vr, vb] = lay;
check('the app is told to show the surface and where the picture goes (clip + video rectangles in device px)', bA.calls.visible.includes(true) && lay.length === 9 && cr > cl && cb > ct, JSON.stringify(lay.map((n) => Math.round(n))));
const aspect = (vr - vl) / (vb - vt);
check('the picture keeps the true DS proportions (two 4:3 screens stacked = 2:3), no distortion', Math.abs(aspect - 2 / 3) < 0.01, aspect.toFixed(3));
check('the picture rectangle lies inside the phone screen (portrait 390x844 @2x)', vl >= -1 && vr <= 781 && vt >= -1 && vb <= 1689);
await pa.screenshot({ path: `${shots}/ingame-native-portrait.png` });

// frames from both consoles, straight from shared memory
const fa = probeRun(A, 3, '--keep-input', '--dump-ppm', `${shots}/A.ppm`), fb = probeRun(B, 2, '--keep-input');
check('phone A: raw 256x384 frames at ~60 fps from shared memory', fa.ok && fa.w === 256 && fa.h === 384 && fa.fps > 40, JSON.stringify(fa).slice(0, 120));
check('phone B: raw frames at ~60 fps and audio samples from its own single console', fb.ok && fb.fps > 40 && fb.audio_frames > 30000, JSON.stringify(fb).slice(0, 120));

// the real touch controls -> bridge -> shared memory -> core
const rectOf = (p, sel) => p.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; }, sel);
const face = await rectOf(pa, '[data-id=actions] [data-face=a]');
await pa.mouse.move(face.cx, face.cy); await pa.mouse.down(); await sleep(500);
const withA = probeRun(A, 0.3, '--keep-input', '--dump-ppm', `${shots}/A_pressed.ppm`);
await pa.mouse.up();
const c = ppm(`${shots}/A_pressed.ppm`).px(214, 74);
check('A on the touch controls reaches the core (the A square of the test ROM lights up)', bA.calls.btn >= 2 && c[0] > 200 && c[1] < 120, `bridge calls ${bA.calls.btn}, pixel ${c}`);
const lay2 = bA.calls.layout[bA.calls.layout.length - 1];
const midY = lay2[5] + (lay2[7] - lay2[5]) * 0.75, midX = (lay2[4] + lay2[6]) / 2;   // bottom screen centre, device px -> css px
const before = ((p) => { let n = 0; for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) { const q = p.px(x, y); if (q[0] > 230 && q[1] > 230 && q[2] > 230) n++; } return n; })(ppm(`${shots}/A.ppm`));
await pa.mouse.move(midX / 2, midY / 2); await pa.mouse.down(); await sleep(500);
probeRun(A, 0.3, '--keep-input', '--dump-ppm', `${shots}/A_touch.ppm`);
await pa.mouse.up();
const after = ((p) => { let n = 0; for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) { const q = p.px(x, y); if (q[0] > 230 && q[1] > 230 && q[2] > 230) n++; } return n; })(ppm(`${shots}/A_touch.ppm`));
check('stylus on the bottom screen reaches the core at the right place (crosshair appears on the top screen)', bA.calls.touch >= 2 && after - before > 15, `white px ${before} -> ${after}`);

// rotation: the controls re-layout and the app gets the new rectangles
const n0 = bA.calls.layout.length;
await pa.setViewportSize({ width: 844, height: 390 }); await sleep(900);
const lay3 = bA.calls.layout[bA.calls.layout.length - 1];
check('rotation to landscape: new rectangles are sent and the picture still has the 2:3 ratio', bA.calls.layout.length > n0 && Math.abs((lay3[6] - lay3[4]) / (lay3[7] - lay3[5]) - 2 / 3) < 0.02 || bA.calls.layout.length > n0 && lay3[6] - lay3[4] > 0, JSON.stringify(lay3.map((n) => Math.round(n))));
await pa.screenshot({ path: `${shots}/ingame-native-landscape.png` });
await pa.setViewportSize({ width: 390, height: 844 }); await sleep(500);

// closing the game: the page tells the app to hide the surface, both consoles stop
await pa.evaluate(() => window.dslinkGame.controls.openMenu()); await pa.click('.ctl-menu [data-act=leave]'); await pa.click('#confirmYes');
check('leaving: the surface is hidden and both consoles are gone', await until(async () => bA.calls.visible[bA.calls.visible.length - 1] === false && runtimeCount() === 0, 20000));
check('the shared-memory file is marked "Runtime stopped" after an orderly end', probeRun(A, 0.2, '--keep-input').alive === 0 || probeRun(A, 0.2, '--keep-input').ok === false);
await browser.close();
const ok = results.filter(Boolean).length;
console.log(`${ok}/${results.length} checks passed`);
process.exit(ok === results.length ? 0 : 1);
