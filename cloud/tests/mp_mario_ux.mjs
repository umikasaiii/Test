// PRIVATE: real Mario Party DS through the NEW multiplayer UX only (create -> join -> ready -> start -> Download Play -> lobby -> match), on two "devices"
// (two gateways on this machine), with two real browsers. Never for CI: needs the user's private files, which stay outside the repository (<private-dir>).
// usage: node mp_mario_ux.mjs <private-dir> <distributed|hosted> <runs> [join: code|qr|nearby|mixed]
import { chromium } from 'playwright';
import fs from 'node:fs';
import { startDevice, sleep, runtimeCount } from './mplib.mjs';

const [priv, mode, runsArg = '3', joinArg = 'mixed'] = process.argv.slice(2);
const RUNS = Number(runsArg);
const rows = [];
const until = async (f, ms = 15000, step = 250) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
const text = (p, sel) => p.locator(sel).first().innerText();
const screenIs = (p, n) => p.evaluate((x) => document.body.dataset.screen === x, n);
let A, B;
const down = () => { A && A.stop(); B && B.stop(); fs.rmSync('/tmp/mpdev_A', { recursive: true, force: true }); fs.rmSync('/tmp/mpdev_B', { recursive: true, force: true }); };
process.on('exit', down);

const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection'] });
const tap = (p, x, y, hold = 400, wait = 1500) => p.evaluate(([x, y]) => { window.dslinkGame.touch(x, y, false, true); window.dslinkGame.touch(x, y, true, false); }, [x, y]).then(() => sleep(hold)).then(() => p.evaluate(([x, y]) => window.dslinkGame.touch(x, y, false, false), [x, y])).then(() => sleep(wait));
const press = (p, k, hold = 250, wait = 1000) => p.evaluate((k) => window.dslinkGame.btn(k, true), k).then(() => sleep(hold)).then(() => p.evaluate((k) => window.dslinkGame.btn(k, false), k)).then(() => sleep(wait));
const region = (p, y0, y1) => p.evaluate(([y0, y1]) => { const v = window.dslinkGame.video, c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const g = c.getContext('2d'); g.drawImage(v, 0, 0); return Array.from(g.getImageData(0, y0, c.width, y1 - y0).data); }, [y0, y1]);
const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 16) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 90) n++; return n; };

for (let run = 1; run <= RUNS; run++) {
  const row = { run, mode, join: '', ux: false, match: false, secs: 0, fail: '' };
  const t0 = Date.now();
  try {
    down(); await sleep(800);
    const refs = `${priv}/out/refs.json`;
    A = startDevice({ name: 'A', port: 8090, udp: 47841, peerUdp: 47842, firmware: priv, refs, impair: mode === 'hosted' ? 'delay=25' : '' });
    B = startDevice({ name: 'B', port: 8091, udp: 47842, peerUdp: 47841, firmware: priv, refs });
    await A.ready(); await B.ready();
    const ctxA = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true }), ctxB = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const pa = await ctxA.newPage(), pb = await ctxB.newPage();
    await pa.goto(`${A.base}/mp/`); await pb.goto(`${B.base}/mp/`);
    // host: CREA PARTITA -> game from the local library (added through the UI) -> CREA STANZA
    await pa.click('#btnCreate'); await pa.setInputFiles('#romFile', `${priv}/mario.nds`);
    if (!(await until(() => pa.locator('#gameList li.sel').count(), 30000))) throw new Error('library: game not added');
    {   // the pristine save of the user's game goes where the core looks for it (<library id>.srm), so the flow starts from the same known state every time
      const id = (await (await fetch(`${A.base}/api/mp/library`)).json()).games[0].id;
      fs.mkdirSync('/tmp/mpdev_A/slot1/saves/melonDS DS', { recursive: true }); fs.copyFileSync(`${priv}/mario_save/melonDS DS/mario.srm`, `/tmp/mpdev_A/slot1/saves/melonDS DS/${id}.srm`);
    }
    await pa.click('#btnMakeRoom'); await pa.waitForFunction(() => document.body.dataset.screen === 'lobby', null, { timeout: 15000 });
    const code = await text(pa, '#lobbyCode');
    // guest: UNISCITI by code, by QR payload or from PARTITE VICINE (host approves)
    const how = joinArg === 'mixed' ? ['code', 'qr', 'nearby'][(run - 1) % 3] : joinArg; row.join = how;
    await pb.click('#btnJoin'); await pb.waitForFunction(() => document.body.dataset.screen === 'join');
    if (how === 'code') { await pb.fill('#codeInput', code); await pb.click('#btnJoinCode'); }
    else if (how === 'qr') { const payload = (await A.state()).qr; await pb.evaluate((p) => window.__mp.joinPayload(p), payload); }
    else { await until(() => pb.locator('#nearbyList li button').count(), 12000); await pb.click('#nearbyList li button'); await until(() => pa.locator('#btnApprove').isVisible(), 10000); await pa.click('#btnApprove'); }
    if (!(await until(async () => (await screenIs(pb, 'lobby')), 25000))) throw new Error('guest did not reach the lobby');
    await until(async () => /Ottima|Buona|Non adatta/.test(await text(pb, '#netBadge')), 15000);
    const wantMode = mode === 'hosted' ? 'hosted' : 'distribuita';
    if (!(await until(async () => (await text(pa, '#lobbyMode')).toLowerCase().includes(wantMode), 10000))) throw new Error(`automatic mode chose "${(await text(pa, '#lobbyMode')).toLowerCase()}"`);
    await pb.click('#btnReady'); if (!(await until(async () => !(await pa.locator('#btnStart').isDisabled()), 10000))) throw new Error('host START never enabled');
    await pa.click('#btnStart');
    const inGame = (p) => p.evaluate(() => document.body.classList.contains('ingame') && !!window.dslinkGame);
    const ok = await until(async () => (await A.state()).state === 'IN_GAME' && (await B.state()).state === 'IN_GAME', 420000, 1000);
    if (!ok) { const sa = await A.state(true), sb = await B.state(true); throw new Error(`UX never reached IN_GAME: host ${sa.state} ${sa.step || ''} ${sa.error ? sa.error.code : ''} / guest ${sb.state} ${sb.step || ''} ${sb.error ? sb.error.code : ''}`); }
    if (!(await until(() => inGame(pa), 30000)) || !(await until(() => inGame(pb), 30000))) throw new Error('game screens not mounted');
    row.ux = true; row.uxSecs = Math.round((Date.now() - t0) / 1000);
    // IN GAME for real: drive the Mario menus from the two browsers (touch/buttons through the UI's input path) into a Block Star match
    await sleep(3000);
    await tap(pa, 0.28, 0.80); await tap(pa, 0.88, 0.965, 500, 14000); await tap(pa, 0.5, 0.645); await tap(pa, 0.88, 0.965, 500, 6000);
    await tap(pa, 0.2, 0.59, 400, 1500); await tap(pb, 0.65, 0.59, 400, 2500); await tap(pa, 0.88, 0.965, 500, 1000); await tap(pb, 0.88, 0.965, 500, 4000);
    await tap(pa, 0.33, 0.80); await tap(pa, 0.88, 0.965, 500, 8000); await press(pb, 'a', 250, 2000); await press(pa, 'a', 250, 5500);
    let dA = 0; for (let k = 0; k < 4 && dA <= 60; k++) { const a0 = await region(pa, 384, 768); await pa.evaluate(() => window.dslinkGame.btn('left', true)); await sleep(1200); await pa.evaluate(() => window.dslinkGame.btn('left', false)); await sleep(600); dA = diff(a0, await region(pa, 384, 768)); if (dA <= 60) await sleep(4000); }
    row.match = dA > 60; row.matchDiff = dA;
    const fin = await A.state(true); row.fps = (fin.dev.slots || []).map((s) => Math.round(s.fps || 0));
    if (!row.match) row.fail = 'match not running';
  } catch (e) { row.fail = String(e.message || e).slice(0, 220); try { for (const d of [A, B]) { const s = await d.state(true); row[`log_${d.name}`] = (s.dev.log || []).slice(-10); }
      for (const f of ['A/slot1', 'A/slot2', 'B/slot1']) { const p = `/tmp/mpdev_${f}/runtime.log`; if (fs.existsSync(p)) row[`tail_${f.replace('/', '_')}`] = fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).slice(-14).map((l) => l.slice(0, 160)); row[`dl_${f.replace('/', '_')}`] = fs.readFileSync(p, 'utf8').split('\n').filter((l) => /DLPLAY|peer|grace|MP_/i.test(l)).map((l) => l.slice(0, 150)).slice(-9); } } catch { /* devices gone */ } }
  row.secs = Math.round((Date.now() - t0) / 1000); rows.push(row); console.log(JSON.stringify(row));
}
await browser.close(); down();
const okc = rows.filter((r) => r.ux && r.match).length;
console.log(`MARIO VIA UX (${mode}): ${okc}/${rows.length} complete (create -> join -> ready -> start -> Download Play -> lobby -> match)`);
fs.writeFileSync(`/tmp/mp_mario_${mode}.json`, JSON.stringify(rows, null, 1));
process.exit(okc === rows.length ? 0 : 1);
