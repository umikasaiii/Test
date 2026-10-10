// PlaySphere PS1 (FASE 8): the PlayStation runs inside the page, picked automatically for a PlayStation game by the RuntimeResolver. Only the redistributable test disc (tools/ps1) is used:
// own homebrew program, HLE BIOS chosen explicitly through the page's own dialog (no Sony BIOS exists in the CI).
// usage: node play_ps1_e2e.mjs [nds-homebrew.nds] [screenshot-dir]
import fs from 'node:fs';
import { staticServer, launch, openApp, buildDiscs, files, until, sleep, grab, pix, LAYOUT, PSX, counterOf, discOf, buttons, buttons2, padType, barLen, near, reporter } from './ps1lib.mjs';
const [nds, shots = '/tmp/ps1e2e'] = process.argv.slice(2); fs.mkdirSync(shots, { recursive: true });
const R = reporter(), { check } = R;
const dir = buildDiscs(), srv = await staticServer(), browser = await launch();
const hasCore = () => srv.log.some((x) => x.includes('/core/ps1/'));

async function app(query = '', ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2, ...ctxOpts });
  await ctx.addInitScript(() => {                                                  // bookkeeping for the cleanup checks: every worker and audio context the page creates
    window.__workers = new Set(); const W = window.Worker; window.Worker = class extends W { constructor(...a) { super(...a); window.__workers.add(this); } terminate() { window.__workers.delete(this); super.terminate(); } };
    window.__audio = []; const A = window.AudioContext; window.AudioContext = class extends A { constructor(...a) { super(...a); window.__audio.push(this); } };
  });
  const p = await ctx.newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(String(e)));
  await p.goto(`${srv.base}/play/${query}`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 20000 });
  p.ctx = ctx; return p;
}
const gamesOf = (p) => p.evaluate(() => window.dslinkPlay.games.length);
async function importGame(p, ...names) { const n = await gamesOf(p); await p.setInputFiles('#romFile', files(dir, ...names)); return until(async () => (await gamesOf(p)) > n, 60000); }
async function play(p, { hle = true, id = '' } = {}) {
  await p.click(id ? `li.game[data-id="${id}"] .play` : 'li.game[data-platform=PS1] .play');
  if (hle) { await p.waitForSelector('#hleBox:not([hidden])', { timeout: 20000 }); await p.click('#btnHleGo'); }
  return until(() => p.evaluate(() => window.dslinkPlay.isPlaying()), 60000);
}
async function leave(p) {
  await p.evaluate(() => window.dslinkPlay.controls ? 0 : 0); await p.evaluate(() => { document.querySelector('.ctl-c[data-id=menu]') && 0; });
  await openMenu(p); await p.evaluate(() => document.querySelector('.ctl-menu [data-act=leave]').click());
  await p.waitForSelector('#confirmYes', { state: 'visible' }); await p.evaluate(() => document.querySelector('#confirmYes').click());
  return until(async () => (await p.evaluate(() => document.body.dataset.screen)) === 'library', 20000);
}
async function center(p, sel) { const b = await p.locator(sel).first().boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height, left: b.x, top: b.y }; }
async function openMenu(p) { if (await p.locator('.ctl-menu').count()) return; const c = await center(p, '.ctl-c[data-id=menu] .ctl-pillbtn'); await p.mouse.move(c.x, c.y); await p.mouse.down(); await p.mouse.up(); await p.waitForSelector('.ctl-menu .sheet'); if (await p.evaluate(() => document.getElementById('game').dataset.platform === 'ps1')) await p.waitForSelector('.ps1-section'); }
async function resume(p) { await p.evaluate(() => document.querySelector('.ctl-menu [data-act=resume]').click()); }
async function tap(p, sel, ms = 350, dx = 0, dy = 0) { const c = await center(p, sel); await p.mouse.move(c.x + dx, c.y + dy); await p.mouse.down(); await sleep(ms); return async () => { await p.mouse.up(); }; }

// =================================================================================== 1. lazy load: nothing PlayStation is fetched until it is needed
const p = await app();
check('LAZY LOAD: the library opens and the PlayStation core is not downloaded (no request for it)', !hasCore());
check('RUNTIME RESOLVER: PS1 -> LOCAL_PS1_WASM / pcsx-rearmed, NDS -> LOCAL_NDS_WASM / melonds, a future system is refused (no crash)',
  await p.evaluate(() => { const a = window.dslinkPlay.resolve('PS1'), b = window.dslinkPlay.resolve('NDS'), c = window.dslinkPlay.resolve('GBA'); return a.ok && a.runtime === 'LOCAL_PS1_WASM' && a.coreId === 'pcsx-rearmed' && b.ok && b.runtime === 'LOCAL_NDS_WASM' && b.coreId === 'melonds' && !c.ok && /non è ancora disponibile/.test(c.reason); }));

// =================================================================================== 2. import: platform detected, one profile per game
check('IMPORT BIN/CUE: cue + bin picked together become ONE PlayStation game (serial read from the disc)', await importGame(p, 'Test Game.cue', 'Test Game.bin'));
const g1 = await p.evaluate(() => window.dslinkPlay.games[0]);
check('GAME PROFILE: platform PS1, serial PSPH00001, one disc, files kept as picked, runtime chosen by the platform',
  g1.platform === 'PS1' && g1.serial === 'PSPH00001' && g1.discs.length === 1 && g1.files.length === 2 && (await p.evaluate(() => { const r = window.dslinkPlay.resolve(window.dslinkPlay.games[0].platform); return r.coreId; })) === 'pcsx-rearmed', JSON.stringify({ title: g1.title, region: g1.region }));
check('IMPORT: the PlayStation core is downloaded only now (to read the disc)', hasCore());
check('LIBRARY: the game shows its platform (PS1) in the single library', (await p.locator('li.game[data-platform=PS1] .plat').innerText()) === 'PS1');
await p.setInputFiles('#romFile', files(dir, 'Test Game.cue'));
await sleep(1500); const e1 = await p.innerText('#libErr');
check('IMPORT: a .cue without its .bin is refused with a clear message (nothing is stored)', /Manca il file/.test(e1) && (await gamesOf(p)) === 1, e1);
fs.writeFileSync(`${dir}/broken.bin`, Buffer.alloc(5000, 7));
await p.setInputFiles('#romFile', files(dir, 'broken.bin')); await sleep(2500); const e2 = await p.innerText('#libErr');
check('IMPORT: a file that is not a PlayStation disc is refused with a clear message', /non è un disco|non è un'immagine|non riesco|valido/i.test(e2) && (await gamesOf(p)) === 1, e2);
check('IMPORT CHD: a .chd is recognised by the core (libchdr) and added as its own game', await importGame(p, 'Test Game.chd'));
const chd = await p.evaluate(() => window.dslinkPlay.games.find((g) => g.format === 'chd'));
check('CHD: the format and serial come from the disc inside the CHD', chd && chd.serial === 'PSPH00001', chd && chd.format);
check('MULTI-DISC IMPORT: two discs picked together with their .m3u are ONE game with two discs', await importGame(p, 'Two Disc Game.m3u', 'Two Disc Game (Disc 1).cue', 'Two Disc Game (Disc 1).bin', 'Two Disc Game (Disc 2).cue', 'Two Disc Game (Disc 2).bin'));
const two = await p.evaluate(() => window.dslinkPlay.games.find((g) => g.discs.length === 2));
check('MULTI-DISC: one profile with disc metadata (Disco 1, Disco 2)', two && two.discs.map((d) => d.label).join() === 'Disco 1,Disco 2');
// CHD: a game played from a .chd (compressed, one file) boots like any other
{ const cid = await p.evaluate(() => window.dslinkPlay.games.find((g) => g.format === 'chd').id);
  const up = await play(p, { id: cid }); await sleep(3500); const fc = await grab(p);
  check('CHD PLAY: a game stored as .chd boots (the core reads the compressed image through its own libchdr) and draws its picture', up && near(pix(fc, ...LAYOUT.header), [0, 121, 57]) && padType(fc) === 'digital' && discOf(fc) === 1);
  await leave(p);
  await p.evaluate(async () => { const s = window.dslinkPlay.store; for (const g of window.dslinkPlay.games.filter((x) => x.format === 'chd')) { for (const f of g.files) await s.del(`library/${g.id}/disc/${f.name}`); for (const k of ['meta.json', 'save', 'save.meta.json']) await s.del(`library/${g.id}/${k}`); } }); }
await p.reload(); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
// the single-disc bin/cue game is the one the next sections play: put it first
const ids = await p.evaluate(() => window.dslinkPlay.games.map((g) => ({ id: g.id, t: g.title, d: g.discs.length })));

// =================================================================================== 3. BIOS policy: never HLE silently
await p.evaluate((id) => { window.__only = id; document.querySelectorAll('li.game').forEach((li) => { if (li.dataset.id !== id) li.remove(); }); }, ids.find((x) => x.d === 1 && /Test Game/.test(x.t)).id);
await p.click('li.game .play'); await p.waitForSelector('#hleBox:not([hidden])', { timeout: 20000 });
check('BIOS POLICY: with no BIOS the page asks and explains (HLE is never used silently); the player has not started', (await p.innerText('#hleBox')).includes('compatibilità') && !(await p.evaluate(() => window.dslinkPlay.isPlaying())));
await p.click('#btnHleNo'); await sleep(500);
check('BIOS POLICY: ANNULLA goes back to the library, nothing runs, no worker is left', (await p.evaluate(() => document.body.dataset.screen)) === 'library' && !(await p.evaluate(() => window.dslinkPlay.isPlaying())) && (await p.evaluate(() => window.__workers.size)) === 0);
const biosTests = await p.evaluate(async () => {
  const { inspectBios, BIOS_SIZE, biosForGame } = await import('./ps1bios.js'); const mk = (txt, n = BIOS_SIZE) => { const u = new Uint8Array(n); const e = new TextEncoder().encode(txt); u.set(e, 1000); return u.buffer; };
  const na = inspectBios(mk('System ROM Version 2.0 05/07/95 A')), eu = inspectBios(mk('System ROM Version 4.1 12/16/97 E')), jp = inspectBios(mk('System ROM Version 2.2 12/04/95 J')), small = inspectBios(new ArrayBuffer(1000)), junk = inspectBios(mk('hello'));
  const have = new Map([['ps1bios_na', mk('System ROM Version 2.0 05/07/95 A')]]);
  return { na: na.ok && na.slot.region, eu: eu.ok && eu.slot.region, jp: jp.ok && jp.slot.region, small: small.error, junk: junk.error, matchNa: biosForGame('NTSC-U', have).status, otherEu: biosForGame('PAL', have).status, none: biosForGame('PAL', new Map()).status };
});
check('BIOS: recognised by content (region from the version string), wrong size / not a BIOS refused, region matching reported honestly',
  biosTests.na === 'NTSC-U' && biosTests.eu === 'PAL' && biosTests.jp === 'NTSC-J' && biosTests.small === 'size' && biosTests.junk === 'not_bios' && biosTests.matchNa === 'match' && biosTests.otherEu === 'other' && biosTests.none === 'none', JSON.stringify(biosTests));
fs.writeFileSync(`${dir}/not-a-bios.bin`, Buffer.alloc(524288, 1));
await p.setInputFiles('#ps1BiosFile', `${dir}/not-a-bios.bin`); await sleep(800);
check('BIOS IMPORT: a 512 KB file that is not a BIOS is refused with a message and not stored', /non sembra un BIOS/.test(await p.innerText('#libErr')) && (await p.evaluate(() => window.dslinkPlay.store.get('system/ps1-bios-na.bin'))) === null);
await p.reload(); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');

// =================================================================================== 4. single player: boot, video, audio, input
const t0 = Date.now(); const playing = await play(p); const bootMs = Date.now() - t0;
check('PS1 BOOT: GIOCA -> resolver -> PlayStation core -> the program boots from the disc (HLE BIOS chosen in the dialog)', !!playing, `${bootMs} ms`);
await sleep(3500);
const f0 = await grab(p), st = await p.evaluate(() => { const s = window.dslinkPlay.stats(); return { emu: s.emuFps, render: s.renderFps, core: s.core, ps1: s.ps1, audio: s.audio, peak: s.audioPeak, video: s.video, produced: s.audioFramesProduced, dropped: s.audioSourceDropped, wasm: s.wasmMB }; });
check('PS1 VIDEO: a 320x240 picture reaches the screen, the program drew its layout (header bar, pad, memory card, disc id squares)', f0.w === 320 && f0.h === 240 && near(pix(f0, ...LAYOUT.header), [0, 121, 57]) && padType(f0) === 'digital' && near(pix(f0, ...LAYOUT.mc), [0, 255, 0]) && discOf(f0) === 1, `${f0.w}x${f0.h}`);
check('PS1 FULL SPEED: emulation ~60 fps, render ~60 fps (NTSC)', st.emu > 54 && st.render > 50, `emu ${st.emu.toFixed(1)} render ${st.render.toFixed(1)} fps; core ${st.core && st.core.name} ${st.core && st.core.version}`);
check('PS1 AUDIO: the core produces sound at 44.1 kHz through the shared AudioWorklet path (non silent, none dropped)', st.produced > 44100 && st.peak > 1000 && st.dropped === 0 && /worklet|scriptprocessor/.test(st.audio.backend), `peak ${st.peak} backend ${st.audio.backend}`);
check('ASPECT: the picture is shown in a 4:3 box (ASPECT CORRECT), the core reports 4:3', Math.abs((await p.evaluate(() => window.dslinkPlay.player.stats.aspect)) - 4 / 3) < 0.01 && await p.evaluate(() => { const c = document.querySelector('.ctl-clip canvas'); const r = c.getBoundingClientRect(); return Math.abs(r.width / r.height - 4 / 3) < 0.02; }));
check('INPUT PROFILE: the touch layout is the PlayStation one and the profile follows the game (PS1_DIGITAL)', (await p.evaluate(() => document.getElementById('game').dataset.platform)) === 'ps1' && (await p.evaluate(() => window.dslinkPlay.profile.inputProfile)) === 'PS1_DIGITAL');

// touch controls: every PlayStation button reaches the program
const names = { l: 'l1', l2: 'l2', r: 'r1', r2: 'r2' }; let okTouch = [], badTouch = [];
for (const [id, nm] of Object.entries(names)) { const up = await tap(p, `.ctl-c[data-id=${id}]`); const f = await grab(p); const b = buttons(f); await up(); (b[PSX[nm]] && b.filter(Boolean).length === 1 ? okTouch : badTouch).push(nm); await sleep(120); }
for (const [face, nm] of [['x', 'triangle'], ['a', 'circle'], ['b', 'cross'], ['y', 'square']]) { const up = await tap(p, `.ctl-c[data-id=actions] .ctl-face[data-face=${face}]`); const f = await grab(p); const b = buttons(f); await up(); (b[PSX[nm]] && b.filter(Boolean).length === 1 ? okTouch : badTouch).push(nm); await sleep(120); }
for (const [id, nm] of [['start', 'start'], ['select', 'select']]) { const up = await tap(p, `.ctl-c[data-id=${id}] .ctl-pillbtn`); const f = await grab(p); const b = buttons(f); await up(); (b[PSX[nm]] && b.filter(Boolean).length === 1 ? okTouch : badTouch).push(nm); await sleep(120); }
{ const c = await center(p, '.ctl-c[data-id=dpad]');
  for (const [nm, dx, dy] of [['up', 0, -0.35], ['down', 0, 0.35], ['left', -0.35, 0], ['right', 0.35, 0]]) { await p.mouse.move(c.x + dx * c.w, c.y + dy * c.h); await p.mouse.down(); await sleep(250); const f = await grab(p); const b = buttons(f); await p.mouse.up(); (b[PSX[nm]] && b.filter(Boolean).length === 1 ? okTouch : badTouch).push(nm); await sleep(120); } }
check('PS1 DIGITAL INPUT: D-pad, △ ○ × □, L1 L2 R1 R2, Start and Select (on-screen controls -> core -> program), each seen alone', badTouch.length === 0 && okTouch.length === 14, `ok ${okTouch.join(' ')} bad ${badTouch.join(' ')}`);
await p.keyboard.down('z'); await sleep(250); const fk = await grab(p); await p.keyboard.up('z');
check('PS1 KEYBOARD: the key map of the PlayStation profile reaches the program (z = ×)', buttons(fk)[PSX.cross]);

// physical controller (Gamepad API; a scripted pad stands in for the hardware)
await p.evaluate(() => {
  const mk = (idx) => ({ index: idx, id: 'Standard Gamepad (Vendor: 054c Product: 09cc)', connected: true, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), vibrationActuator: { playEffect: (t, o) => { window.__rumble = o; return Promise.resolve(); }, reset: () => Promise.resolve() } });
  window.__pads = [mk(0), mk(1)]; Object.defineProperty(navigator, 'getGamepads', { value: () => window.__pads, configurable: true }); window.dispatchEvent(new Event('gamepadconnected'));
});
await sleep(300);
const setBtn = (pad, i, v) => p.evaluate(([pd, k, val]) => { window.__pads[pd].buttons[k] = { pressed: val, touched: val, value: val ? 1 : 0 }; }, [pad, i, v]);
await setBtn(0, 0, true); await setBtn(0, 5, true); await sleep(300); const fg = await grab(p);
check('PHYSICAL GAMEPAD: a standard pad (cross + R1 pressed) reaches the program through the Gamepad API mapping', buttons(fg)[PSX.cross] && buttons(fg)[PSX.r1] && buttons(fg).filter(Boolean).length === 2);
await setBtn(0, 0, false); await setBtn(0, 5, false);
await setBtn(1, 1, true); await setBtn(1, 12, true); await sleep(300); const fg2 = await grab(p);
check('LOCAL MULTIPLAYER: a second pad is player 2 on the same console (circle + up on pad 2 seen in player 2\'s buffer, player 1 unaffected)', buttons2(fg2)[PSX.circle] && buttons2(fg2)[PSX.up] && !buttons(fg2).some(Boolean), JSON.stringify(buttons2(fg2).map((x) => +x)));
await setBtn(1, 1, false); await setBtn(1, 12, false);
check('PHYSICAL GAMEPAD: the pad is reported to the menu / overlay (feature detected, rumble actuator present)', await p.evaluate(() => !!window.dslinkPlay.gamepad.info && window.dslinkPlay.gamepad.info.rumble));
await p.screenshot({ path: `${shots}/ps1_play.png` });

// =================================================================================== 5. analog (DualShock): off by default, the menu switches it on, sticks reach the program
check('PS1 ANALOG: off by default (digital pad): the program reads a digital pad (0x41)', padType(await grab(p)) === 'digital');
await openMenu(p); await p.waitForSelector('.ps1-section'); await p.evaluate(() => { const c = document.querySelector('.ps1-section input[type=checkbox]'); c.checked = true; c.dispatchEvent(new Event('change')); }); await resume(p); await sleep(2200);
const fa = await grab(p);
check('PS1 ANALOG: switched on from the menu -> the pad becomes a DualShock in analog mode (0x73) and the sticks section appears', padType(fa) === 'analog' && !(await p.locator('.ps1-sticks[hidden]').count()));
await p.evaluate(() => window.dslinkPlay.player.analog(32767, -32768, 0, 0, 0)); await sleep(400); const fa2 = await grab(p);
check('PS1 ANALOG: left stick right/up reaches the program (LX near 255, LY near 0), right stick centred', barLen(fa2, LAYOUT.bar(2)[1]) > 200 && barLen(fa2, LAYOUT.bar(3)[1]) < 12 && Math.abs(barLen(fa2, LAYOUT.bar(0)[1]) - 128) < 12, [0, 1, 2, 3].map((i) => barLen(fa2, LAYOUT.bar(i)[1])).join());
await p.evaluate(() => window.dslinkPlay.player.analog(0, 0, 0, 0, 0));
{ const v = await p.evaluate(() => { const r = document.querySelector('.ctl-clip').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await p.mouse.move(v.x + v.w * 0.75, v.y + v.h * 0.5); await p.mouse.down(); await p.mouse.move(v.x + v.w * 0.75 + 70, v.y + v.h * 0.5 - 40, { steps: 4 }); await sleep(400); const fs1 = await grab(p); await p.mouse.up();
  check('PS1 ANALOG: the floating right stick on the picture drives RX / RY (touch drag)', barLen(fs1, LAYOUT.bar(0)[1]) > 190 && barLen(fs1, LAYOUT.bar(1)[1]) < 80, [0, 1].map((i) => barLen(fs1, LAYOUT.bar(i)[1])).join()); }
await p.evaluate(() => { window.__pads[0].axes = [-1, 0.5, 0, 0]; }); await sleep(400); const fa3 = await grab(p);
check('PHYSICAL GAMEPAD: in analog mode the pad\'s left stick is the analog stick (LX near 0, LY about 3/4)', barLen(fa3, LAYOUT.bar(2)[1]) < 40 && barLen(fa3, LAYOUT.bar(3)[1]) > 150, [2, 3].map((i) => barLen(fa3, LAYOUT.bar(i)[1])).join());
await p.evaluate(() => { window.__pads[0].axes = [0, 0, 0, 0]; });
check('RUMBLE: the core\'s vibration request is forwarded to the controller when it has an actuator (wiring present; the test program does not vibrate)', await p.evaluate(() => typeof window.dslinkPlay.gamepad.rumble === 'function'));

// =================================================================================== 6. memory card
const cardInfo = await p.evaluate(async () => { const g = window.dslinkPlay.games.find((x) => x.discs.length === 1 && /Test Game/.test(x.title)); await window.dslinkPlay.player.save(true); await window.dslinkPlay.whenSaved(); const b = await window.dslinkPlay.store.get(`library/${g.id}/save`); return { id: g.id, size: b ? b.byteLength : 0 }; });
check('MEMORY CARD: the core\'s memory card (128 KiB) is written to the device storage under library/<id>/save (separate from any DS save)', cardInfo.size === 131072, JSON.stringify(cardInfo));
check('MEMORY CARD: first boot counted 1 (written, read back and compared by the program itself)', counterOf(await grab(p)) === 1);

// =================================================================================== 7. save states
await openMenu(p);
await p.evaluate(() => document.querySelector('[data-act=state-save][data-slot="1"]').click()); await sleep(1200);
const stMeta = await p.evaluate(async () => { const g = window.dslinkPlay.games.find((x) => x.discs.length === 1 && /Test Game/.test(x.title)); const m = await window.dslinkPlay.store.get(`library/${g.id}/state1.json`); const d = await window.dslinkPlay.store.get(`library/${g.id}/state1`); return { meta: m ? JSON.parse(new TextDecoder().decode(m)) : null, size: d ? d.byteLength : 0 }; });
check('SAVE STATE: slot 1 stores the core state stamped with core id, core version and state format', stMeta.meta && stMeta.meta.core === 'pcsx-rearmed' && stMeta.meta.coreVersion === 'c8816799b503' && stMeta.meta.stateFormat === 1 && stMeta.size > 1000000 && stMeta.size === stMeta.meta.size, JSON.stringify(stMeta.meta) + ' ' + stMeta.size);
await resume(p); await p.evaluate(() => window.dslinkPlay.player.btn('start', true)); await sleep(300); const fb = await grab(p); const pressedBefore = buttons(fb)[PSX.start];
await openMenu(p); await p.evaluate(() => document.querySelector('[data-act=state-load][data-slot="1"]').click()); await sleep(1200); await resume(p);
await p.evaluate(() => window.dslinkPlay.player.btn('start', false)); await sleep(400);
check('LOAD STATE: restoring the state keeps the game running (video continues, program alive)', pressedBefore && (await p.evaluate(() => window.dslinkPlay.isPlaying())) && near(pix(await grab(p), ...LAYOUT.header), [0, 121, 57]));
await p.evaluate(async () => { const g = window.dslinkPlay.games.find((x) => x.discs.length === 1 && /Test Game/.test(x.title)); const m = JSON.parse(new TextDecoder().decode(await window.dslinkPlay.store.get(`library/${g.id}/state1.json`))); m.coreVersion = 'other'; await window.dslinkPlay.store.put(`library/${g.id}/state1.json`, new TextEncoder().encode(JSON.stringify(m)).buffer); });
// the menu fills its slot rows asynchronously: on a slow runner the first click can land on a row that is being rebuilt, so click again until the refusal appears
await openMenu(p);
const refusedMsg = await until(async () => {
  await p.evaluate(() => { const b = document.querySelector('[data-act=state-load][data-slot="1"]'); if (b) b.click(); });
  await sleep(250);
  const t = await p.innerText('#cloudToast'); return /altra versione del core/.test(t) ? t : null;
}, 12000, 100);
check('SAVE STATE VERSIONING: a state from another core version is refused with a message, never loaded silently', !!refusedMsg && await p.evaluate(() => window.dslinkPlay.isPlaying()), refusedMsg ? '' : 'toast: ' + JSON.stringify(await p.innerText('#cloudToast')) + ' menu: ' + (await p.evaluate(() => !!document.querySelector('[data-act=state-load]'))));
await resume(p);

// =================================================================================== 8. leave, come back: the memory card persists
check('PS1 EXIT: leaving closes the session (worker terminated, audio closed), the library is back', await leave(p) && (await p.evaluate(() => window.__workers.size)) === 0 && (await p.evaluate(() => window.__audio.every((a) => a.state === 'closed'))));
const again = await play(p); await sleep(3500);
const fr = await grab(p);
check('MEMORY CARD RELOAD: the next boot loads the saved card: the counter went 1 -> 2 (written by the program in the previous session)', again && counterOf(fr) === 2 && near(pix(fr, ...LAYOUT.mc), [0, 255, 0]), 'counter ' + counterOf(fr));
await leave(p);

// =================================================================================== 9. multi disc + disc swap
await p.evaluate(() => { document.querySelectorAll('li.game').forEach((li) => { li.hidden = li.querySelector('.t').textContent.indexOf('Two Disc') < 0; }); });
await p.click('li.game:not([hidden]) .play'); await p.waitForSelector('#hleBox:not([hidden])'); await p.click('#btnHleGo');
await until(() => p.evaluate(() => window.dslinkPlay.isPlaying()), 60000); await sleep(3500);
const d1 = await grab(p);
check('MULTI-DISC: the game boots from disc 1 (the program reads disc number 1 from the CD)', discOf(d1) === 1 && (await p.evaluate(() => window.dslinkPlay.player.disc.count)) === 2);
await openMenu(p); await p.evaluate(() => { const s = document.querySelector('.ps1-section select'); s.value = '1'; document.querySelector('[data-act=disc]').click(); });
const swapped = await until(() => p.evaluate(() => window.dslinkPlay.player.disc.index === 1), 15000);
await resume(p); await sleep(600);
await p.evaluate(() => window.dslinkPlay.player.btn('r3', true)); await sleep(500); await p.evaluate(() => window.dslinkPlay.player.btn('r3', false)); await sleep(3500);
const d2 = await grab(p);
check('DISC SWAP: MENU -> CAMBIA DISCO goes through the core\'s disc control (eject, new disc, close), no restart: the program now reads disc number 2', swapped && discOf(d2) === 2 && near(pix(d2, ...LAYOUT.header), [0, 121, 57]), 'discs squares ' + discOf(d2));
await p.screenshot({ path: `${shots}/ps1_disc2.png` });
await leave(p);

// =================================================================================== 10. PAL: 50 Hz, never forced to 60
await importGame(p, 'Pal Game.cue', 'Pal Game.bin');
const palId = await p.evaluate(async () => { const g = window.dslinkPlay.games.find((x) => /Pal Game/.test(x.title)); g.region = 'PAL'; await window.dslinkPlay.store.put(`library/${g.id}/meta.json`, new TextEncoder().encode(JSON.stringify(g)).buffer); return g.id; });
await p.reload(); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
const upPal = await play(p, { id: palId }); await sleep(4000); const fp = await grab(p);
const palSt = await p.evaluate(() => { const s = window.dslinkPlay.stats(); return { fps: s.ps1.fps, emu: s.emuFps, render: s.renderFps, w: s.ps1.w, h: s.ps1.h, region: window.__ps1Start.region }; });
check('PAL: a PAL game runs at 50 Hz (not forced to 60): the core reports 50 fps, the emulation and the renderer follow it', upPal && palSt.region === 'PAL' && Math.abs(palSt.fps - 50) < 0.6 && palSt.emu > 45 && palSt.emu < 52.5 && palSt.render < 52.5 && near(pix(fp, ...LAYOUT.header), [0, 121, 57]), JSON.stringify(palSt));
await leave(p);

check('NO SCRIPT ERRORS on the page', p.errors.length === 0, p.errors.join(' | ').slice(0, 300));
await browser.close(); srv.close();
process.exit(R.done() ? 0 : 1);
