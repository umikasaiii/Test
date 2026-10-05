// The real product flow through the UI only (no test hooks): host uploads a .nds and gets a room code; the guest enters the
// code. Emulator 2 starts WITHOUT a cartridge (Download Play client). Without the user's DS firmware the core cannot boot the
// DS menu and shows its own error screen: that is the expected, verified state here (Mario Party DS needs the firmware).
// usage: node browser_ui_nocart.mjs <base-url> <rom1.nds>
import { chromium } from 'playwright';
import fs from 'node:fs';

const base = process.argv[2] || 'http://localhost:8080', rom1 = process.argv[3];
const chrome = process.env.CHROME || undefined; // undefined = Playwright's own Chromium; locally: CHROME=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitStatus = async (pred, ms = 40000) => { const end = Date.now() + ms; let st; while (Date.now() < end) { st = (await (await fetch(base + '/api/status')).json()).room; if (st && pred(st)) return st; await sleep(500); } return st; };

await fetch(base + '/api/room', { method: 'DELETE' });
const browser = await chromium.launch({ executablePath: chrome, headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns'] });
const A = await (await browser.newContext({ viewport: { width: 540, height: 1000 } })).newPage();
const B = await (await browser.newContext({ viewport: { width: 540, height: 1000 } })).newPage();

await A.goto(base);
check('home shows CREA PARTITA and ENTRA', (await A.textContent('#menu')).includes('CREA PARTITA') && (await A.textContent('#menu')).includes('ENTRA'));
await A.click('#btnCreate');
await A.setInputFiles('#rom', rom1);
await A.click('#btnUpload');
await A.waitForSelector('#lobby:not([hidden])', { timeout: 90000 });
const code = (await A.textContent('#roomCode')).trim();
check('host uploaded the .nds and got a room code', /^[A-Z0-9]{5}$/.test(code), code);
check('host sees a join link', (await A.textContent('#roomLink')).includes('#' + code));
await A.click('#btnStart');

await B.goto(base);
await B.click('#btnJoin');
await B.fill('#code', code.toLowerCase());
await B.click('#btnEnter');
await Promise.all([A, B].map((p) => p.waitForFunction(() => window.dslink && window.dslink.pc.connectionState === 'connected', null, { timeout: 30000 })));
check('guest joined with the code; both browsers connected at the same time', true);

await Promise.all([A, B].map((p) => p.waitForFunction(() => { const v = window.dslink.video; if (!v.videoWidth) return false; const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext('2d'); g.drawImage(v, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 97) s += d[i]; return s > 5000; }, null, { timeout: 30000, polling: 250 })));
check('both browsers receive a live video stream', true);

const hash = (p) => p.evaluate(() => { const v = window.dslink.video, c = document.createElement('canvas'); c.width = 64; c.height = 96; const g = c.getContext('2d'); g.drawImage(v, 0, 0, 64, 96); return Array.from(g.getImageData(0, 0, 64, 96).data).filter((_, i) => i % 4 < 3); });
const [ha, hb] = [await hash(A), await hash(B)];
let diff = 0; for (let i = 0; i < ha.length; i++) diff += Math.abs(ha[i] - hb[i]);
check('the two framebuffers are different (emulator 1 runs the game, emulator 2 has no cartridge)', diff / ha.length > 5, `mean abs diff ${(diff / ha.length).toFixed(1)}`);

const st = await waitStatus((r) => r.slots.every((x) => x.netplay_joined && x.core_multiplayer));
const [s1, s2] = st.slots;
check('emulator 1 has the cartridge, emulator 2 has none', s1.has_cartridge && !s2.has_cartridge);
check('Netplay between the emulators connected inside the container (client = no-cartridge slot)', s1.netplay_joined && s2.netplay_joined && s1.host && !s2.host);
check('DS multiplayer layer started in both cores', s1.core_multiplayer && s2.core_multiplayer);
check('different DS MACs (DSLink DeviceIdentity)', st.macs_differ, `${s1.expected_mac} / ${s2.expected_mac}`);
check('MAC reported by the core == DSLink derivation', st.core_macs_match_dslink && s1.mac === s1.expected_mac, `core: ${s1.mac}`);
const log2 = await (await fetch(base + '/api/slotlog?slot=2')).text();
check('emulator 2 core reports it needs bootable firmware (expected without the user firmware)', /can't be used to boot to the DS menu|firmware/i.test(log2));
// the guest's touch only reaches emulator 2
await B.evaluate(() => { window.dslink.touch(0.5, 0.5, false, true); window.dslink.touch(0.5, 0.5, true, false); });
await sleep(300);
const ev = (await (await fetch(base + '/api/status')).json()).room.slots.map((s) => s.input_events);
check('guest input reaches only its own emulator', ev[1] > 0 && ev[0] === 0, JSON.stringify(ev));
await B.evaluate(() => window.dslink.touch(0.5, 0.5, false, false));

await A.screenshot({ path: '/tmp/ui_A.png' }); await B.screenshot({ path: '/tmp/ui_B.png' });
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
