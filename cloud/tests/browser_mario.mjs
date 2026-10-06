// PRIVATE end-to-end: real Mario Party DS Download Play driven ENTIRELY from two real browsers over WebRTC (video/audio out, touch/buttons in).
// Browser A = player 1 (host, Mario Party DS ROM), browser B = player 2 (no ROM, user's firmware -> DS menu -> DS Download Play).
// Not for CI: needs the user's private files. usage: node browser_mario.mjs <gateway-url> <mario.nds> <refs.json>
// (the gateway must run with DSLINK_FIRMWARE_DIR=<private dir>; refs.json holds only 16x16 average-hashes of reference screens)
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:8080', romPath = process.argv[3], refs = JSON.parse(fs.readFileSync(process.argv[4], 'utf8'));
const chrome = process.env.CHROME || undefined;
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await fetch(base + '/api/room', { method: 'DELETE' });
const browser = await chromium.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection'] });
const A = await (await browser.newContext({ viewport: { width: 540, height: 1000 } })).newPage();
const B = await (await browser.newContext({ viewport: { width: 540, height: 1000 } })).newPage();
await A.goto(base);
const sess = await A.evaluate(async (b64) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const fd = new FormData(); fd.append('rom', new Blob([bin]), 'p1.nds');
  return (await fetch('/api/room', { method: 'POST', body: fd })).json();
}, fs.readFileSync(romPath).toString('base64'));
check('room created from the private ROM (host only)', !!sess.code, sess.code || JSON.stringify(sess));
await A.evaluate((s) => window.__dslinkStart(s), sess);
await B.goto(base + '/#' + sess.code); await B.click('#btnEnter');
await Promise.all([A, B].map((p) => p.waitForFunction(() => window.dslink && window.dslink.pc.connectionState === 'connected', null, { timeout: 40000 })));
await Promise.all([A, B].map((p) => p.waitForFunction(() => window.dslink.video.videoWidth > 0, null, { timeout: 40000 })));
check('both browsers connected over WebRTC and receive video', true);
const rtcStats = (p) => p.evaluate(async () => { const r = await window.dslink.pc.getStats(); const o = {}; r.forEach((x) => {
  if (x.type === 'inbound-rtp' && x.kind === 'video') Object.assign(o, { vBytes: x.bytesReceived, frames: x.framesDecoded, jitter: x.jitter, lost: x.packetsLost, t: x.timestamp });
  if (x.type === 'inbound-rtp' && x.kind === 'audio') o.aBytes = x.bytesReceived;
  if (x.type === 'candidate-pair' && x.state === 'succeeded' && x.nominated) { o.rtt = x.currentRoundTripTime; o.pair = [x.localCandidateId, x.remoteCandidateId]; } });
  if (o.pair) o.path = o.pair.map((id) => r.get(id)?.candidateType).join('<->'); return o; });
const rtc0 = [await rtcStats(A), await rtcStats(B)];

// ---- in-page helpers: 16x16 average-hash of the top / bottom screen of the received video, identical sampling to the Python tests (video = 2x)
const hash = (p) => p.evaluate(() => {
  const v = window.dslink.video, c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight;
  const g = c.getContext('2d'); g.drawImage(v, 0, 0);
  const one = (y0) => { const s = []; for (let y = y0 + 6; y < y0 + 192; y += 12) for (let x = 8; x < 256; x += 16) { const d = g.getImageData(x * 2, y * 2, 1, 1).data; s.push((d[0] + d[1] + d[2]) / 3 | 0); } const a = s.reduce((x, y) => x + y, 0) / s.length; return s.map((v) => (v > a ? '1' : '0')).join(''); };
  return { top: one(0), bot: one(192) };
});
const dist = (a, b) => [...a].reduce((n, c, i) => n + (c !== b[i]), 0);
const last = {};
const is = async (p, name, which = 'both', tol = 50) => { const h = await hash(p), r = refs[name]; const d = { top: dist(h.top, r.top), bot: dist(h.bot, r.bot) }; last[name] = d; return which === 'both' ? d.top <= tol && d.bot <= tol : d[which] <= tol; };
const waitIs = async (p, name, secs, which = 'both', tol = 50) => { const end = Date.now() + secs * 1000; while (Date.now() < end) { if (await is(p, name, which, tol)) return true; await sleep(700); } return false; };
const tap = async (p, x, y, hold = 400, wait = 1500) => { await p.evaluate(([x, y]) => { window.dslink.touch(x, y, false, true); window.dslink.touch(x, y, true, false); }, [x, y]); await sleep(hold); await p.evaluate(([x, y]) => window.dslink.touch(x, y, false, false), [x, y]); await sleep(wait); };
const press = async (p, k, hold = 250, wait = 1000) => { await p.evaluate((k) => window.dslink.btn(k, true), k); await sleep(hold); await p.evaluate((k) => window.dslink.btn(k, false), k); await sleep(wait); };
const goto = async (p, name, act, which = 'both', tries = 6, wait = 3000, tol = 50) => { for (let i = 0; i < tries; i++) { if (await is(p, name, which, tol)) return true; await act(); await sleep(wait); } return is(p, name, which, tol); };
const ifIs = async (p, name, which, fn, tol = 50) => { if (await is(p, name, which, tol)) await fn(); };
const status = async () => (await (await fetch(base + '/api/status')).json()).room;
const rms = (p) => p.evaluate(async () => {
  const ac = new AudioContext(); await ac.resume();
  const src = ac.createMediaStreamSource(new MediaStream(window.dslink.video.srcObject.getAudioTracks()));
  const an = ac.createAnalyser(); an.fftSize = 2048; src.connect(an);
  await new Promise((r) => setTimeout(r, 1200));
  const b = new Float32Array(an.fftSize); let s = 0, n = 0;
  for (let k = 0; k < 10; k++) { an.getFloatTimeDomainData(b); for (const x of b) { s += x * x; n++; } await new Promise((r) => setTimeout(r, 60)); }
  return 20 * Math.log10(Math.sqrt(s / n) + 1e-9);
});

await sleep(14000);
check('MARIO_HOST_BOOT (browser A): Mario Party DS title screen', await waitIs(A, 'host_title', 15));
check('CLIENT_FIRMWARE_BOOT (browser B): the user\'s firmware boots with NO cartridge', await waitIs(B, 'client_health', 15));
check('CLIENT_DS_MENU (browser B): the DS menu with DS Download Play', await goto(B, 'client_ds_menu', () => tap(B, 0.5, 0.75), 'bot'));
check('CLIENT_DOWNLOAD_PLAY_OPEN (browser B)', await goto(B, 'client_dl_open', () => tap(B, 0.68, 0.72, 300, 2000), 'bot'));
check('host: Select Data', await goto(A, 'host_select_data', () => tap(A, 0.5, 0.9, 300, 3000), 'both', 8));
check('host: main menu', await goto(A, 'host_main_menu', () => ifIs(A, 'host_select_data', 'both', async () => { await tap(A, 0.5, 0.66); await tap(A, 0.88, 0.97, 400, 3000); }), 'bot'));
check('MARIO_MULTIPLAYER_MENU (browser A): Find Players', await goto(A, 'host_find_players', () => ifIs(A, 'host_main_menu', 'bot', async () => { await tap(A, 0.5, 0.80); await tap(A, 0.88, 0.97, 400, 3000); }), 'top'));
check('GAME_DISCOVERED (browser B): Mario Party DS appears in the Download Play list', await waitIs(B, 'client_discovered', 25, 'bot'));
const dl = async (i) => (await status()).slots[i].dl_state;
const waitDl = async (i, states, secs) => { const end = Date.now() + secs * 1000; while (Date.now() < end) { if (states.includes(await dl(i))) return true; await sleep(700); } return false; };
for (let i = 0; i < 6; i++) { if (['DOWNLOAD_HANDSHAKE', 'DOWNLOAD_TRANSFER', 'DOWNLOAD_VERIFY'].includes(await dl(1))) break; await tap(B, 0.5, 0.67, 300, 2000); await press(B, 'a', 250, 3000); }
check('DOWNLOAD_HANDSHAKE + DOWNLOAD_TRANSFER (radio diagnostics inside the container)', await waitDl(1, ['DOWNLOAD_TRANSFER', 'DOWNLOAD_VERIFY'], 40), await dl(1));
check('DOWNLOAD_VERIFY: payload complete, client waits for the host', await waitDl(1, ['DOWNLOAD_VERIFY'], 90), await dl(1));
check('host (browser A) lists the client as a player', await waitIs(A, 'host_p2_joined', 20, 'bot', 40));
await tap(A, 0.88, 0.97, 400, 3000);                       // host: OK -> start
check('CLIENT_GAME_BOOT + GAME_HANDSHAKE (radio): the client boots the downloaded software and rejoins', await waitDl(1, ['CLIENT_GAME_BOOT', 'GAME_HANDSHAKE', 'LOBBY'], 60) && await waitDl(1, ['GAME_HANDSHAKE', 'LOBBY'], 90), await dl(1));
check('GAME_HANDSHAKE (browser B): the downloaded game says "You are P2"', await waitIs(B, 'client_you_are_p2', 60, 'bot', 40));
check('GAME_HANDSHAKE (browser A): "You are P1"', await waitIs(A, 'host_you_are_p1', 40, 'bot', 40));
await goto(B, 'client_lobby', async () => { await ifIs(A, 'host_you_are_p1', 'bot', () => tap(A, 0.5, 0.79, 400, 1000)); await ifIs(B, 'client_you_are_p2', 'bot', () => tap(B, 0.5, 0.79, 400, 4000)); }, 'bot', 6, 3000, 60);
check('LOBBY: both in the same session (B: "P1 is making selections", A: Select Mode)', (await is(B, 'client_lobby', 'bot', 110)) && (await is(A, 'host_select_mode', 'bot', 120)), JSON.stringify({ b: last.client_lobby, a: last.host_select_mode }));
const st = await status();
check('gateway: both emulators joined over the Multiplayer Bridge, client has no cartridge, MACs differ', st.slots.every((s) => s.netplay_joined) && !st.slots[1].has_cartridge && st.macs_differ, JSON.stringify({ joined: st.slots.map((s) => s.netplay_joined) }));
const [dbA, dbB] = [await rms(A), await rms(B)];
check('audio from both consoles reaches its own browser (game music on the host, downloaded game on the client)', dbA > -60 && dbB > -60, `A ${dbA.toFixed(0)} dB, B ${dbB.toFixed(0)} dB`);
const shot = async (n) => { await A.screenshot({ path: `/home/user/private/out/br_${n}_A.png` }); await B.screenshot({ path: `/home/user/private/out/br_${n}_B.png` }); };
await shot('lobby');
// ---- a real match, driven only from the two browsers: Puzzle Mode -> Puzzle Collection -> characters (P1 touch in A, P2 touch in B) -> Block Star
await tap(A, 0.28, 0.80); await tap(A, 0.88, 0.965, 500, 14000);
await tap(A, 0.5, 0.645); await tap(A, 0.88, 0.965, 500, 6000);
await tap(A, 0.2, 0.59, 400, 1500); await tap(B, 0.65, 0.59, 400, 2500);
await shot('characters');
await tap(A, 0.88, 0.965, 500, 1000); await tap(B, 0.88, 0.965, 500, 4000);
await tap(A, 0.33, 0.80); await tap(A, 0.88, 0.965, 500, 8000);
await press(B, 'a', 250, 2000); await press(A, 'a', 250, 5500);
await shot('game');
const region = (p, y0, y1) => p.evaluate(([y0, y1]) => { const v = window.dslink.video, c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext('2d'); g.drawImage(v, 0, 0); return Array.from(g.getImageData(0, y0, 512, y1 - y0).data); }, [y0, y1]);
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 16) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 90) n++; return n; };
let dA, dBbot, dBtop, ok = false;
for (let k = 0; k < 4 && !ok; k++) {
  const [a0b, a0t, b0b, b0t] = [await region(A, 384, 768), await region(A, 0, 384), await region(B, 384, 768), await region(B, 0, 384)];
  await A.evaluate(() => window.dslink.btn('left', true)); await sleep(1200); await A.evaluate(() => window.dslink.btn('left', false)); await sleep(600);
  const [a1b, a1t, b1b, b1t] = [await region(A, 384, 768), await region(A, 0, 384), await region(B, 384, 768), await region(B, 0, 384)];
  dA = diff(a0b, a1b); dBbot = diff(b0b, b1b); dBtop = diff(b0t, b1t);
  ok = dA > 60;
  if (!ok) await sleep(4000);
}
check('IN_GAME over WebRTC: a Block Star match runs; browser A\'s D-pad LEFT moves A\'s own hand (own bottom screen changes)', ok, `A-bottom ${dA}`);
await shot('before_input');
await A.evaluate(() => window.dslink.btn('left', true)); await sleep(1000); await A.evaluate(() => window.dslink.btn('left', false)); await sleep(300);
await shot('after_A_left');
await B.evaluate(() => window.dslink.btn('right', true)); await sleep(1000); await B.evaluate(() => window.dslink.btn('right', false)); await sleep(300);
await shot('after_B_right');
console.log('INFO  input-independence screenshots written (br_before_input / br_after_A_left / br_after_B_right, _A and _B): reviewed by eye, not auto-asserted');
const [gA, gB] = [await rms(A), await rms(B)];
check('game audio reaches both browsers during the match', gA > -60 && gB > -60, `A ${gA.toFixed(0)} dB  B ${gB.toFixed(0)} dB`);
const fin = await status();
check('both consoles real-time during the whole run (>= 55 fps)', fin.slots.every((x) => x.fps >= 55), fin.slots.map((x) => x.fps && x.fps.toFixed(1)).join(' / '));
const rtc1 = [await rtcStats(A), await rtcStats(B)];
const summary = rtc1.map((b, i) => { const a = rtc0[i], dt = (b.t - a.t) / 1000; return { fps: +((b.frames - a.frames) / dt).toFixed(1), videoKbps: Math.round(((b.vBytes - a.vBytes) * 8) / dt / 1000), audioKbps: Math.round(((b.aBytes - a.aBytes) * 8) / dt / 1000), jitterMs: +(b.jitter * 1000).toFixed(2), packetsLost: b.lost, rttMs: b.rtt != null ? +(b.rtt * 1000).toFixed(1) : null, icePath: b.path, seconds: Math.round(dt) }; });
console.log('WEBRTC_STATS ' + JSON.stringify(summary));
check('direct WebRTC on the LAN: selected ICE pair is host<->host (no TURN/relay, no Cloudflare)', summary.every((x) => x.icePath === 'host<->host'), summary.map((x) => x.icePath).join(' | '));
const bad = results.filter((r) => !r.ok).length;
console.log(`${results.length - bad}/${results.length} checks passed`);
await browser.close();
process.exit(bad ? 1 : 0);
