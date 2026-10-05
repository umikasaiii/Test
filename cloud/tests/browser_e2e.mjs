// End-to-end browser test: two real Chromium browsers (A = player 1, B = player 2) against the gateway.
// Verifies, with real WebRTC: independent video, independent audio, independent keyboard/pad input, independent
// touch screen, and that the two emulators are Netplay-connected INSIDE the container (gateway /api/status).
// usage: node browser_e2e.mjs <base-url> <rom1.nds> <rom2.nds>
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:8080';
const rom1 = process.argv[3], rom2 = process.argv[4];
const chrome = process.env.CHROME || undefined; // undefined = Playwright's own Chromium; locally: CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitStatus = async (pred, ms = 40000) => { const end = Date.now() + ms; let st; while (Date.now() < end) { st = (await (await fetch(base + '/api/status')).json()).room; if (st && pred(st)) return st; await sleep(500); } return st; };

await fetch(base + '/api/room', { method: 'DELETE' }); // start from a clean container
const browser = await chromium.launch({
  executablePath: chrome, headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection'],
});

// ---- create the room (compatibility mode: slot 2 also gets a test cartridge so that its audio/video differ)
const ctxA = await browser.newContext({ viewport: { width: 540, height: 1000 } });
const A = await ctxA.newPage();
await A.goto(base);
const sessA = await A.evaluate(async ([r1, r2]) => {
  const bin = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const fd = new FormData();
  fd.append('rom', new Blob([bin(r1)]), 'p1.nds');
  if (r2) fd.append('rom2', new Blob([bin(r2)]), 'p2.nds');
  const r = await fetch('/api/room', { method: 'POST', body: fd });
  return r.json();
}, [fs.readFileSync(rom1).toString('base64'), rom2 ? fs.readFileSync(rom2).toString('base64') : null]);
check('room created with a join code', !!sessA.code, sessA.code);

// ---- browser A connects as player 1; browser B joins with the code as player 2 (simultaneously)
await A.evaluate((s) => window.__dslinkStart(s), sessA);
const ctxB = await browser.newContext({ viewport: { width: 540, height: 1000 } });
const B = await ctxB.newPage();
await B.goto(base + '/#' + sessA.code);
await B.click('#btnEnter');
await Promise.all([A, B].map((p) => p.waitForFunction(() => window.dslink && window.dslink.pc.connectionState === 'connected', null, { timeout: 30000 })));
check('browser A and browser B connected at the same time (WebRTC)', true);
await Promise.all([A, B].map((p) => p.waitForFunction(() => { const v = window.dslink.video; return v.videoWidth > 0; }, null, { timeout: 30000 })));
const sessB = await B.evaluate(() => window.dslink.session);
check('B joined as player 2 via the room code', sessB.player === 2 && sessB.code === sessA.code);

// ---- helpers run inside the pages
const sample = (page, pts) => page.evaluate((pts) => {
  const v = window.dslink.video, c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  const g = c.getContext('2d'); g.drawImage(v, 0, 0);
  return { w: c.width, h: c.height, px: pts.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data.slice(0, 3))) };
}, pts);
const whiteCount = (page, y0, y1) => page.evaluate(([y0, y1]) => {
  const v = window.dslink.video, c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  const g = c.getContext('2d'); g.drawImage(v, 0, 0);
  const d = g.getImageData(0, y0, c.width, y1 - y0).data; let n = 0;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 230 && d[i + 1] > 230 && d[i + 2] > 230) n++;
  return n;
}, [y0, y1]);
const dominant = (rgb) => (rgb[2] > rgb[0] + 40 ? 'blue' : rgb[0] > rgb[2] + 40 ? 'red' : 'other');

// wait for a real (non-black) frame on both videos before sampling
const nonBlack = () => { const v = window.dslink.video, c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext('2d'); g.drawImage(v, 0, 0); const d = g.getImageData(250, 250, 1, 1).data; return d[0] + d[1] + d[2] > 30; };
await Promise.all([A, B].map((p) => p.waitForFunction(nonBlack, null, { timeout: 20000, polling: 200 })));
await A.screenshot({ path: (process.env.E2E_SHOTS || '/tmp') + '/e2e_A.png' });
await B.screenshot({ path: (process.env.E2E_SHOTS || '/tmp') + '/e2e_B.png' });
// ---- 1. two independent framebuffers
const sA = await sample(A, [[250, 250]]), sB = await sample(B, [[250, 250]]);
check('video A is player 1\'s screen (blue background)', dominant(sA.px[0]) === 'blue', JSON.stringify(sA.px[0]));
check('video B is player 2\'s screen (red background) - a different framebuffer', dominant(sB.px[0]) === 'red', JSON.stringify(sB.px[0]));
check('video resolution 512x768 (2 DS screens, 2x)', sA.w === 512 && sA.h === 768, `${sA.w}x${sA.h}`);

// ---- 2. two independent audio streams (FFT peak: 440 Hz vs 660 Hz)
const peak = (page) => page.evaluate(async () => {
  const v = window.dslink.video;
  const ac = new AudioContext(); await ac.resume();
  const src = ac.createMediaStreamSource(new MediaStream(v.srcObject.getAudioTracks()));
  const an = ac.createAnalyser(); an.fftSize = 16384; src.connect(an);
  await new Promise((r) => setTimeout(r, 1500));
  const f = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(f);
  let best = 0; for (let i = 1; i < f.length; i++) if (f[i] > f[best]) best = i;
  return { hz: best * ac.sampleRate / an.fftSize, db: f[best] };
});
const [pA, pB] = [await peak(A), await peak(B)];
check('audio A carries player 1\'s 440 Hz tone', Math.abs(pA.hz - 440) < 15 && pA.db > -80, `${pA.hz.toFixed(0)} Hz ${pA.db.toFixed(0)} dB`);
check('audio B carries player 2\'s 660 Hz tone (separate stream)', Math.abs(pB.hz - 660) < 15 && pB.db > -80, `${pB.hz.toFixed(0)} Hz ${pB.db.toFixed(0)} dB`);

// ---- 3. independent buttons: A presses "A" -> only emulator 1 shows it (red square at DS (200,60) -> px (428,148))
const aPix = [[428, 148]];
await A.evaluate(() => window.dslink.btn('a', true)); await sleep(700);
const [a1, a2] = [await sample(A, aPix), await sample(B, aPix)];
check('button A pressed in browser A lights emulator 1 only', a1.px[0][0] > 200 && a1.px[0][1] < 120 && a2.px[0][0] < 120, `A:${a1.px[0]} B:${a2.px[0]}`);
await A.evaluate(() => window.dslink.btn('a', false));
await B.evaluate(() => window.dslink.btn('up', true)); await sleep(700);   // Up square at DS (40,36) -> px (108,100)
const [u1, u2] = [await sample(A, [[108, 100]]), await sample(B, [[108, 100]])];
check('D-pad Up pressed in browser B lights emulator 2 only', u2.px[0][0] > 200 && u2.px[0][2] > 200 && u1.px[0][0] < 100, `A:${u1.px[0]} B:${u2.px[0]}`);
await B.evaluate(() => window.dslink.btn('up', false));

// ---- 4. independent touch screen: B touches the bottom screen -> crosshair on emulator 2's top screen only
const before = await whiteCount(B, 0, 360);
await B.evaluate(() => { window.dslink.touch(0.5, 0.4, false, true); window.dslink.touch(0.5, 0.4, true, false); });
await sleep(900);
const [tB, tA] = [await whiteCount(B, 0, 360), await whiteCount(A, 0, 360)];
check('touch in browser B shows the stylus crosshair on emulator 2 (ARM7 read the touch panel)', tB - before > 30, `white px ${before} -> ${tB}`);
check('...and not on emulator 1', tA < 30, `white px on A: ${tA}`);
await B.evaluate(() => window.dslink.touch(0.5, 0.4, false, false)); await sleep(300);

// ---- 5. DS multiplayer link is internal: status from the container
const stAll = await waitStatus((r) => r.slots.every((x) => x.netplay_joined && x.core_multiplayer));
const st = { room: stAll };
const [s1, s2] = st.room.slots;
check('both emulators Netplay-connected inside the container', s1.netplay_joined && s2.netplay_joined);
check('core multiplayer layer started on both', s1.core_multiplayer && s2.core_multiplayer);
check('distinct DS MAC addresses (core-reported, equal to the DSLink derivation)', st.room.macs_differ && s1.mac === s1.expected_mac && s2.mac === s2.expected_mac, `${s1.mac} / ${s2.mac}`);
check('emulator 2 is the Netplay client of emulator 1 (host)', s1.host && !s2.host);

const failed = results.filter((r) => !r.ok);
fs.writeFileSync(process.env.E2E_REPORT || '/tmp/e2e_report.json', JSON.stringify({ results, status: st }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
