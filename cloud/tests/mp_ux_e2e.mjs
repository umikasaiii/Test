// Multiplayer UX end to end, driven ONLY through the user interface (two real browsers, two gateways = two DEVICES, LAN/local, no cloud, no Cloudflare).
// Homebrew test ROMs (no Download Play: the consoles just link their radios). usage: node mp_ux_e2e.mjs <rom1.nds> <rom2.nds> [screenshot-dir]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { startDevice, sleep, runtimeCount, runtimePidsFor, waitState } from './mplib.mjs';

const [rom1, rom2, shots = '/tmp/mpshots'] = process.argv.slice(2);
fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const until = async (f, ms = 15000, step = 150) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
let A, B, browser;
const down = () => { A && A.stop(); B && B.stop(); };
process.on('exit', down);
async function boot(optsA = {}, optsB = {}) {
  down(); await sleep(500);
  A = startDevice({ name: 'A', port: 8090, udp: 47841, peerUdp: 47842, testGuestRom: rom2, ...optsA });
  B = startDevice({ name: 'B', port: 8091, udp: 47842, peerUdp: 47841, testGuestRom: rom2, ...optsB });
  await A.ready(); await B.ready();
}
const text = (p, sel) => p.locator(sel).first().innerText();
const screenIs = (p, name) => p.evaluate((n) => document.body.dataset.screen === n, name);
const shot = (p, name) => p.screenshot({ path: `${shots}/${name}.png` });
const inGame = (p) => p.evaluate(() => document.body.classList.contains('ingame') && document.querySelectorAll('#game .ctl-c').length > 0);
async function newPage(dev, vp = { width: 390, height: 844 }, dev_ = false) {
  const ctx = await browser.newContext({ viewport: vp, hasTouch: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage(); await p.goto(`${dev.base}/mp/${dev_ ? '?dev=1' : ''}`); await p.waitForFunction(() => document.body.dataset.screen); return p;
}
async function hostRoom(pa, first = true) {
  await pa.click('#btnCreate'); await pa.waitForFunction(() => document.body.dataset.screen === 'create');
  if (first) await pa.setInputFiles('#romFile', rom1);
  await until(() => pa.locator('#gameList li.sel').count());
  if (!(await pa.locator('#gameList li.sel').count())) await pa.locator('#gameList li').first().click();
  await pa.click('#btnMakeRoom'); await pa.waitForFunction(() => document.body.dataset.screen === 'lobby', null, { timeout: 10000 });
  return text(pa, '#lobbyCode');
}
async function guestJoin(pb, code) {
  await pb.click('#btnJoin'); await pb.waitForFunction(() => document.body.dataset.screen === 'join');
  await pb.fill('#codeInput', code); await pb.click('#btnJoinCode');
  return until(async () => (await screenIs(pb, 'lobby')), 20000);
}
async function readyAndStart(pa, pb) {
  await until(async () => (await pb.locator('#btnReady').isVisible()) && /Ottima|Buona|Non adatta/.test(await text(pb, '#netBadge')), 15000);
  await pb.click('#btnReady'); await until(async () => !(await pa.locator('#btnStart').isDisabled()), 8000); await pa.click('#btnStart');
}
const bothIn = async (pa, pb, ms = 60000) => (await until(() => inGame(pa), ms)) && (await until(() => inGame(pb), ms));

browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection'] });
try {
  // =============================================================== S1: the main flow, Distributed (AUTOMATIC on a clean LAN)
  await boot();
  let pa = await newPage(A), pb = await newPage(B);
  check('Multiplayer home shows CREA PARTITA and UNISCITI (CTA >= 44 px)', (await screenIs(pa, 'home')) && (await pa.locator('#btnCreate').boundingBox()).height >= 44 && (await pa.locator('#btnJoin').boundingBox()).height >= 44);
  await shot(pa, '01-home');
  await pa.click('#btnCreate'); await pa.waitForFunction(() => document.body.dataset.screen === 'create'); await pa.setInputFiles('#romFile', rom1);
  await until(() => pa.locator('#gameList li.sel').count());
  check('library: the added game is listed and selected', (await pa.locator('#gameList li.sel').count()) === 1); await shot(pa, '02-create');
  await pa.click('#btnMakeRoom'); await pa.waitForFunction(() => document.body.dataset.screen === 'lobby', null, { timeout: 10000 });
  const code = await text(pa, '#lobbyCode');
  check('host lobby: 6-digit code, HOST ready, PLAYER 2 waiting', /^\d{6}$/.test(code) && (await text(pa, '#players li:nth-child(2)')).includes('In attesa'), code);
  check('QR on screen decodes (jsQR) to the join payload; the payload carries no private data', await pa.evaluate(async () => { const s = await (await fetch('/api/mp/state')).json(); const c = document.getElementById('qr'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height); const r = window.jsQR(d.data, c.width, c.height); return !!r && r.data === s.qr && s.qr.startsWith('dslink://join?') && !/bios|\.nds|firmware/i.test(s.qr); }));
  await shot(pa, '03-lobby-host');
  await pb.click('#btnJoin'); await pb.waitForFunction(() => document.body.dataset.screen === 'join');
  const nearby = await until(async () => (await pb.locator('#nearbyList li').count()) === 1 && (await text(pb, '#nearbyList li')), 12000);
  check('PARTITE VICINE: the room on the same network is listed automatically, no IP shown', !!nearby && !/\d+\.\d+\.\d+\.\d+/.test(nearby), String(nearby).replace(/\n/g, ' | ')); await shot(pb, '04-join-nearby');
  await pb.fill('#codeInput', code); await shot(pb, '04b-join-code'); await pb.fill('#codeInput', code === '000000' ? '000001' : '000000'); await pb.click('#btnJoinCode');
  check('invalid code -> "Codice partita non valido o scaduto."', (await until(async () => (await text(pb, '#joinErr')) || false, 8000)) === 'Codice partita non valido o scaduto.');
  await pb.evaluate(() => { window.__seen = []; new MutationObserver(() => window.__seen.push(document.body.dataset.screen)).observe(document.body, { attributes: true, attributeFilter: ['data-screen'] }); });
  await pb.fill('#codeInput', code); await pb.click('#btnJoinCode');
  const t0 = Date.now(); let shotNet = false; while (Date.now() - t0 < 15000 && !/Ottima/.test(await text(pa, '#netBadge'))) { if (!shotNet && (await screenIs(pb, 'netcheck'))) { await shot(pb, '05-network-check'); shotNet = true; } await sleep(40); }
  check('guest joined by code (discovery) and went through the network-check screen', !!(await until(() => screenIs(pb, 'lobby'), 8000)) && (await pb.evaluate(() => window.__seen)).includes('netcheck'), await pb.evaluate(() => window.__seen.join('>')));
  check('host lobby: PLAYER 2 connected, network "Ottima", START disabled until the guest is ready', (await text(pa, '#players li:nth-child(2)')).includes('Connesso') && (await pa.locator('#btnStart').isDisabled()));
  await shot(pb, '06-lobby-guest'); await pb.click('#btnReady');
  check('guest READY enables AVVIA PARTITA; mode "Distribuita"; no milliseconds anywhere in the UI', (await until(async () => !(await pa.locator('#btnStart').isDisabled()), 6000)) && (await text(pa, '#lobbyMode')).toLowerCase().includes('distribuita') && !/\bms\b|rtt/i.test(await pa.locator('#app').innerText()));
  await shot(pa, '07-lobby-ready'); await pa.click('#btnStart');
  let sawStarting = false; const t1 = Date.now(); while (Date.now() - t1 < 60000 && !(await inGame(pa))) { if (!sawStarting && (await screenIs(pa, 'starting'))) { await sleep(1500); await shot(pa, '08-starting'); sawStarting = true; } await sleep(100); }
  check('START: the setup steps were shown, both devices reached the game with the touch controls', sawStarting && (await bothIn(pa, pb)));
  const sa = await A.state(true), sb = await B.state(true);
  check('Distributed: each device runs ONE console, radio over the LAN, no game stream between devices', sa.mode.effective === 'distributed' && sa.dev.slots.length === 1 && sb.dev.slots.length === 1 && sa.dev.slots[0].radio === 'lan' && sb.dev.slots[0].radio === 'lan' && sa.dev.slots[0].stream === 'none', `${sa.state}/${sb.state}`);
  await sleep(1200); await shot(pa, '09-ingame-portrait');
  await pa.setViewportSize({ width: 844, height: 390 }); await sleep(600);
  check('rotation: the touch controls re-layout to landscape and stay inside the screen', await pa.evaluate(() => document.getElementById('game').dataset.orientation === 'landscape' && [...document.querySelectorAll('#game .ctl-c')].every((e) => { const r = e.getBoundingClientRect(); return r.x >= -1 && r.y >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; })));
  await shot(pa, '10-ingame-landscape'); await pa.setViewportSize({ width: 390, height: 844 });

  // =============================================================== S2: the guest device vanishes mid-game (SIGKILL of its console): clean end, no 6 fps host, resources freed, back to the lobby, play again
  const hostRtBefore = runtimePidsFor('A').length;
  for (const pid of runtimePidsFor('B')) process.kill(pid, 'SIGKILL');
  check('guest crash: the host shows "Connessione persa / Riconnessione in corso" (no frozen game)', !!(await until(() => pa.locator('#reconnect').isVisible(), 20000)));
  await shot(pa, '11-reconnecting');
  const ended = await until(() => screenIs(pa, 'ended'), 45000);
  check('after the grace window the host ends the session: "Connessione con il giocatore persa." with TORNA ALLA LOBBY / CHIUDI PARTITA', !!ended && (await text(pa, '#endMsg')) === 'Connessione con il giocatore persa.' && (await pa.locator('#btnBackLobby').isVisible()) && (await pa.locator('#btnCloseGame').isVisible()));
  await shot(pa, '12-connection-lost');
  check('the host console process and room were released (no leftover runtime, no room)', hostRtBefore === 1 && runtimePidsFor('A').length === 0 && (await (await fetch(`${A.base}/api/status`)).json()).room === null);
  check('the guest device also ends cleanly (its own console died)', !!(await until(() => screenIs(pb, 'ended'), 20000)) && runtimePidsFor('B').length === 0);
  await pa.click('#btnBackLobby'); await pb.click('#btnBackLobby');
  check('TORNA ALLA LOBBY: host waiting again, guest re-joined the same room', !!(await until(async () => (await screenIs(pa, 'lobby')) && (await screenIs(pb, 'lobby')) && (await text(pa, '#players li:nth-child(2)')).includes('Connesso'), 25000)));
  await readyAndStart(pa, pb);
  check('play again after the loss: both devices back in the game', await bothIn(pa, pb));

  // =============================================================== S3: a short network blip (guest gateway frozen 7 s, then resumes): RECONNECTING, then the game resumes
  B.pause(); const sawRec = await until(() => pa.locator('#reconnect').isVisible(), 20000); await sleep(1000); B.resume();
  check('short outage: the host shows the reconnecting overlay', !!sawRec);
  check('the guest comes back inside the window: the game resumes (same session, no restart)', !!(await until(async () => !(await pa.locator('#reconnect').isVisible()) && (await A.state()).state === 'IN_GAME' && (await B.state()).state === 'IN_GAME', 30000)));

  // =============================================================== S6/S8: host cancel with the guest in the lobby; Back button, refresh, background
  await pa.evaluate(() => window.dslinkGame.controls.openMenu()); await pa.click('.ctl-menu [data-act=leave]'); await pa.click('#confirmYes');   // the in-game menu's own "leave" button
  check('host closes the game: the guest is told "L\'host ha chiuso la partita." and its console stops', !!(await until(async () => (await screenIs(pb, 'ended')) && (await text(pb, '#endMsg')) === "L'host ha chiuso la partita.", 20000)) && (await until(() => runtimePidsFor('B').length === 0, 10000)));
  await shot(pb, '13-host-closed'); await pb.click('#btnCloseGame'); await pa.reload(); await pa.waitForFunction(() => document.body.dataset.screen);
  await pb.reload(); await pb.waitForFunction(() => document.body.dataset.screen);
  const code2 = await hostRoom(pa, false); await guestJoin(pb, code2);
  await until(async () => /Ottima|Buona|Non adatta/.test(await text(pb, '#netBadge')), 12000);
  await sleep(1500); await pb.goBack(); await sleep(800);
  const backInfo = await pb.evaluate(() => [location.pathname, document.body.dataset.screen, document.getElementById('confirm').hidden, document.getElementById('confirmTitle').textContent].join('|'));
  check('Back button inside a lobby asks for confirmation instead of silently leaving', backInfo.split('|')[2] === 'false' && backInfo.includes('Uscire') && backInfo.split('|')[1] === 'lobby', backInfo);
  await pb.click('#confirmNo');
  check('the app\'s Back hook (window.dslinkBack) asks inside a session and does not depend on history entries', (await pb.evaluate(() => window.dslinkBack() === true && !document.getElementById('confirm').hidden)) === true);
  await pb.click('#confirmNo'); await pb.reload(); await pb.waitForFunction(() => document.body.dataset.screen);
  check('refresh in the lobby: the session continues (the UI re-reads the server state)', await until(async () => (await screenIs(pb, 'lobby')) && (await text(pb, '#lobbyCode')) === code2, 8000));
  await pb.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
  await sleep(1500);
  check('short background / foreground: still in the lobby', await screenIs(pb, 'lobby'));
  await pb.click('#btnCancel'); await pb.click('#confirmYes');
  check('GUEST LEAVE: the host lobby goes back to "In attesa…"', !!(await until(async () => (await text(pa, '#players li:nth-child(2)')).includes('In attesa'), 12000)));
  await pa.click('#btnCancel'); await pa.click('#confirmYes'); await sleep(800);
  check('HOST CANCEL: both devices are back to a clean state (IDLE, no room, no console)', (await A.state()).state === 'IDLE' && (await B.state()).state === 'IDLE' && runtimeCount() === 0);

  // =============================================================== S4: AUTOMATIC on a slow network -> HOSTED (host impairs the network check)
  await boot({ impair: 'delay=25' }); pa = await newPage(A); pb = await newPage(B);
  const code3 = await hostRoom(pa); await guestJoin(pb, code3);
  await until(async () => /Non adatta/.test(await text(pb, '#netBadge')), 15000);
  check('slow network: badge "Non adatta" and the message "Per maggiore stabilità verrà utilizzata la modalità Hosted."', /Non adatta/.test(await text(pa, '#netBadge')) && (await pa.locator('#app').innerText()).includes('Per maggiore stabilità verrà utilizzata la modalità Hosted.') && (await text(pa, '#lobbyMode')).toLowerCase().includes('hosted'));
  await shot(pa, '14-lobby-hosted-note');
  await readyAndStart(pa, pb);
  check('Hosted flow: both devices reach the game', await bothIn(pa, pb));
  const ha = await A.state(true), hb = await B.state(true);
  check('Hosted: both consoles run on the HOST (local radio), the guest device runs none and watches the host\'s stream over direct WebRTC', ha.mode.effective === 'hosted' && ha.dev.slots.length === 2 && ha.dev.slots[0].radio === 'local' && runtimePidsFor('B').length === 0 && hb.ingame.base.startsWith('http://127.0.0.1:8090') && (await pb.evaluate(() => window.dslinkGame.pc.connectionState === 'connected' && window.dslinkGame.video.videoWidth > 0)));
  await shot(pb, '15-ingame-hosted-guest');
  await pa.evaluate(() => window.dslinkGame.controls.openMenu()); await pa.click('.ctl-menu [data-act=leave]'); await pa.click('#confirmYes');
  check('Hosted: closing ends both sides cleanly', !!(await until(async () => (await screenIs(pb, 'ended')) && runtimeCount() === 0, 20000)));

  // =============================================================== S5: developer menu overrides the automatic choice
  await boot(); pa = await newPage(A, { width: 390, height: 844 }, true); pb = await newPage(B);
  await pa.selectOption('#devMode', 'hosted'); const code4 = await hostRoom(pa); await guestJoin(pb, code4);
  await until(async () => /Ottima/.test(await text(pb, '#netBadge')), 12000);
  check('developer menu: Hosted forced on an excellent network', (await text(pa, '#lobbyMode')).toLowerCase().includes('hosted'));
  await pa.click('#btnCancel'); await pa.click('#confirmYes'); await sleep(500);

  // =============================================================== mobile viewports: CTA >= 44, no horizontal scroll, nothing outside the safe area
  for (const [w, h] of [[360, 800], [390, 844], [412, 915], [430, 932], [800, 360], [844, 390]]) {
    const p = await newPage(A, { width: w, height: h }); const bad = [];
    const audit = async (name) => { const r = await p.evaluate(() => ({ sx: document.documentElement.scrollWidth - innerWidth, small: [...document.querySelectorAll('.screen.on .cta')].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).length, tiny: [...document.querySelectorAll('.screen.on *')].filter((e) => e.offsetParent && e.children.length === 0 && parseFloat(getComputedStyle(e).fontSize) < 12 && e.textContent.trim()).length })); if (r.sx > 1 || r.small || r.tiny) bad.push(`${name}:${JSON.stringify(r)}`); };
    await audit('home'); await p.click('#btnCreate'); await p.waitForFunction(() => document.body.dataset.screen === 'create'); await audit('create'); await p.goBack(); await p.waitForFunction(() => document.body.dataset.screen === 'home');
    await p.click('#btnJoin'); await p.waitForFunction(() => document.body.dataset.screen === 'join'); await audit('join'); await p.goBack();
    check(`viewport ${w}x${h}: home/create/join have no horizontal scroll, CTAs >= 44 px, text >= 12 px`, bad.length === 0, bad.join(' '));
    if (w === 360) await shot(p, '16-small-viewport-join');
  }
} finally { await browser.close(); down(); }
const bad = results.filter((x) => !x).length; console.log(`${results.length - bad}/${results.length} checks passed`); process.exit(bad ? 1 : 0);
