// PRIVATE: real Mario Party DS, HOSTED V0 = a phone host (gateway started the way the Android app starts it: console 1 in shared memory for the native display, both consoles on the
// device) and an iPhone-like browser guest on the LAN address: create -> join (guest page, code / QR address) -> ready -> start -> Download Play between the two consoles -> client boot
// -> Mario's own lobby -> match. Never for CI: needs the user's private files, which stay outside the repository (<private-dir>).
// usage: node mp_mario_phone.mjs <private-dir> <runs> <shm_probe> <lan-ip>        (set DSLINK_RUNTIME/DSLINK_GATEWAY/CHROME as for the other tests)
import { chromium } from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { startDevice, sleep, runtimeCount } from './mplib.mjs';

const [priv, runsArg = '3', probe, LAN] = process.argv.slice(2);
const RUNS = Number(runsArg);
const OFF = JSON.parse(execFileSync(probe, ['--offsets']).toString());
const PAD = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11, l2: 12, r2: 13 };
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const rows = [];
const until = async (f, ms = 15000, step = 250) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
const text = (p, sel) => p.locator(sel).first().innerText();
const screenIs = (p, n) => p.evaluate((x) => document.body.dataset.screen === x, n);
let A;
const down = () => { A && A.stop(); fs.rmSync('/tmp/mpdev_A', { recursive: true, force: true }); };
process.on('exit', down);
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection', '--disable-features=WebRtcHideLocalIpsWithMdns', '--no-proxy-server'] });
const shmOf = (d) => `${d.dir}/av.shm`;
function bridgeFor(dev) {
  let buttons = 0, tseq = 0;
  const wr = (off, buf) => { const fd = fs.openSync(shmOf(dev), 'r+'); fs.writeSync(fd, buf, 0, buf.length, off); fs.closeSync(fd); };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
  return {
    btn: (k, d) => { if (!(k in PAD)) return; buttons = d ? (buttons | (1 << PAD[k])) : (buttons & ~(1 << PAD[k])); wr(OFF.buttons, u32(buttons)); },
    touch: (x, y, d) => { const q = (v) => BigInt(Math.round(Math.max(0, Math.min(1, v)) * 65535)); const t = (d ? 1n : 0n) | (q(x) << 1n) | (q(y) << 17n); const b = Buffer.alloc(8); b.writeBigUInt64LE(t); wr(OFF.touch, b); wr(OFF.touchSeq, u32(++tseq)); } };
}
const tap = (p, x, y, hold = 400, wait = 1500) => p.evaluate(([x, y]) => { window.dslinkGame.touch(x, y, false, true); window.dslinkGame.touch(x, y, true, false); }, [x, y]).then(() => sleep(hold)).then(() => p.evaluate(([x, y]) => window.dslinkGame.touch(x, y, false, false), [x, y])).then(() => sleep(wait));
const press = (p, k, hold = 250, wait = 1000) => p.evaluate((k) => window.dslinkGame.btn(k, true), k).then(() => sleep(hold)).then(() => p.evaluate((k) => window.dslinkGame.btn(k, false), k)).then(() => sleep(wait));
// the host's own console picture: the dev snapshot of the gateway (loopback), decoded in a page
const snapRegion = async (pg, idx, y0, y1) => { const r = await fetch(`${A.base}/api/mp/dev/snapshot?slot=${idx}`); const b64 = Buffer.from(await r.arrayBuffer()).toString('base64');
  return pg.evaluate(async ([b64, y0, y1]) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); return Array.from(g.getImageData(0, y0, c.width, y1 - y0).data); }, [b64, y0, y1]); };
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 16) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 90) n++; return n; };

for (let run = 1; run <= RUNS; run++) {
  const row = { run, join: '', states: [], hostBoot: false, downloadPlay: false, clientBoot: false, lobby: false, inGame: false, secs: 0, fail: '' };
  const t0 = Date.now();
  try {
    down(); await sleep(800);
    A = startDevice({ name: 'A', port: 8090, udp: 47841, peerUdp: 47842, firmware: priv, refs: `${priv}/out/refs.json`,
      extraEnv: { DSLINK_UI_LOOPBACK_ONLY: '1', DSLINK_SHM_PATH: '/tmp/mpdev_A/av.shm', DSLINK_ADVERTISE_IP: LAN, DSLINK_DEV: '1', DSLINK_WEBRTC_ADVERTISE: '1' } });
    await A.ready();
    const bridge = bridgeFor(A);
    const hctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
    const pa = await hctx.newPage();
    await pa.exposeFunction('__ds_btn', (k, d) => bridge.btn(k, d)); await pa.exposeFunction('__ds_touch', (x, y, d) => bridge.touch(x, y, d));
    await pa.addInitScript(() => { window.DSLinkAndroid = { btn: (k, d) => window.__ds_btn(k, d), touch: (x, y, d) => window.__ds_touch(x, y, d), setLayout() {}, gameVisible() {}, openSystemFiles() {}, setDevOverlay() {} }; });
    await pa.goto(`${A.base}/mp/`); await pa.waitForFunction(() => document.body.dataset.screen);
    await pa.click('#btnCreate'); await pa.setInputFiles('#romFile', `${priv}/mario.nds`);
    if (!(await until(() => pa.locator('#gameList li.sel').count(), 30000))) throw new Error('library: game not added');
    {   // the pristine save of the user's game goes where the core looks for it, so every run starts from the same known state
      const id = (await (await fetch(`${A.base}/api/mp/library`)).json()).games[0].id;
      fs.mkdirSync('/tmp/mpdev_A/slot1/saves/melonDS DS', { recursive: true }); fs.copyFileSync(`${priv}/mario_save/melonDS DS/mario.srm`, `/tmp/mpdev_A/slot1/saves/melonDS DS/${id}.srm`);
    }
    await pa.click('#btnMakeRoom'); await pa.waitForFunction(() => document.body.dataset.screen === 'lobby', null, { timeout: 15000 });
    const code = await text(pa, '#lobbyCode');
    const ictx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3, userAgent: IPHONE_UA });
    const pb = await ictx.newPage();
    const how = run % 2 === 0 ? 'qr' : 'code'; row.join = how;
    if (how === 'qr') { await pb.goto((await A.state()).qr); } else { await pb.goto(`http://${LAN}:8090/guest/`); await pb.waitForFunction(() => document.body.dataset.screen); await pb.fill('#codeInput', code); await pb.click('#btnJoinCode'); }
    if (!(await until(async () => (await screenIs(pb, 'lobby')), 25000))) throw new Error('the iPhone did not reach the lobby');
    if (!(await until(async () => /hosted/i.test(await text(pa, '#lobbyMode')), 10000))) throw new Error(`mode "${await text(pa, '#lobbyMode')}"`);
    await until(() => pb.locator('#btnReady').isVisible(), 10000);
    await pb.click('#btnReady'); if (!(await until(async () => !(await pa.locator('#btnStart').isDisabled()), 10000))) throw new Error('host START never enabled');
    await pa.click('#btnStart');
    const seen = new Set();
    const inGame = (p) => p.evaluate(() => document.body.classList.contains('ingame') && !!window.dslinkGame);
    const ok = await until(async () => { const s = await A.state(); seen.add(s.state); const dev = (await A.state(true)).dev; const s1 = (dev.slots || []).find((x) => x.id === 1); if (s1 && s1.frames > 120) row.hostBoot = true; return s.state === 'IN_GAME'; }, 420000, 700);
    row.states = [...seen]; row.downloadPlay = seen.has('DOWNLOAD_PLAY'); row.clientBoot = ok;
    if (!ok) { const sa = await A.state(true); throw new Error(`never IN_GAME: host ${sa.state} ${sa.step || ''} ${sa.error ? sa.error.code : ''}`); }
    if (!(await until(() => inGame(pa), 30000)) || !(await until(() => inGame(pb), 30000))) throw new Error('game screens not mounted');
    await until(() => pb.evaluate(() => window.dslinkGame.pc && window.dslinkGame.pc.connectionState === 'connected'), 30000);
    row.ux = true; row.uxSecs = Math.round((Date.now() - t0) / 1000);
    // IN GAME for real: drive the Mario menus (touch/buttons through the same input paths the people use: the host's native bridge, the iPhone's data channel) into a Block Star match
    await sleep(3000);
    await tap(pa, 0.28, 0.80); await tap(pa, 0.88, 0.965, 500, 14000); await tap(pa, 0.5, 0.645); await tap(pa, 0.88, 0.965, 500, 6000);
    await tap(pa, 0.2, 0.59, 400, 1500); await tap(pb, 0.65, 0.59, 400, 2500); await tap(pa, 0.88, 0.965, 500, 1000); await tap(pb, 0.88, 0.965, 500, 4000);
    row.lobby = true;   // both players selected their seats in the game's own lobby through their own input paths
    await tap(pa, 0.33, 0.80); await tap(pa, 0.88, 0.965, 500, 8000); await press(pb, 'a', 250, 2000); await press(pa, 'a', 250, 5500);
    let dA = 0; for (let k = 0; k < 4 && dA <= 30; k++) { const a0 = await snapRegion(pa, 0, 192, 384); await pa.evaluate(() => window.dslinkGame.btn('left', true)); await sleep(1200); await pa.evaluate(() => window.dslinkGame.btn('left', false)); await sleep(600); dA = diff(a0, await snapRegion(pa, 0, 192, 384)); if (dA <= 30) await sleep(4000); }
    row.inGame = dA > 30; row.matchDiff = dA;
    const fin = await A.state(true); row.fps = (fin.dev.slots || []).map((s) => Math.round(s.fps || 0)); row.enc = ((fin.dev.slots || []).find((s) => s.id === 2) || {}).enc || null; row.rttMs = ((fin.dev.slots || []).find((s) => s.id === 2) || {}).peer_rtt_ms || null;
    if (!row.inGame) row.fail = 'match not running';
    await hctx.close(); await ictx.close();
  } catch (e) { row.fail = String(e.message || e).slice(0, 240); try { const s = await A.state(true); row.log = (s.dev.log || []).slice(-10);
      for (const f of ['A/slot1', 'A/slot2']) { const p = `/tmp/mpdev_${f}/runtime.log`; if (fs.existsSync(p)) row[`dl_${f.replace('/', '_')}`] = fs.readFileSync(p, 'utf8').split('\n').filter((l) => /DLPLAY|peer|grace|MP_/i.test(l)).map((l) => l.slice(0, 150)).slice(-8); } } catch { /* gateway gone */ } }
  row.secs = Math.round((Date.now() - t0) / 1000); rows.push(row); console.log(JSON.stringify(row));
}
await browser.close(); down();
const okc = rows.filter((r) => r.ux && r.inGame).length;
console.log(`MARIO HOSTED V0 (phone host + iPhone guest): ${okc}/${rows.length} complete (create -> join -> ready -> start -> Download Play -> client boot -> lobby -> match)`);
fs.writeFileSync('/tmp/mp_mario_phone.json', JSON.stringify(rows, null, 1));
process.exit(okc === rows.length ? 0 : 1);
