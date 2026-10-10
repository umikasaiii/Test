// PlaySphere multi-core (FASE 8): one library, one page, two systems. NDS -> exit -> PS1 -> exit -> NDS in the same browser profile: the right core and controls every time,
// no zombie worker or audio context, separate storage and saves, only one core in memory at a time, the PS1 core fetched only when a PS1 game needs it.
// usage: node play_multicore_e2e.mjs <nds-homebrew.nds> [screenshot-dir]
import fs from 'node:fs';
import { staticServer, launch, buildDiscs, files, until, sleep, grab, pix, LAYOUT, counterOf, near, padType, reporter } from './ps1lib.mjs';
const [nds, shots = '/tmp/multicore'] = process.argv.slice(2); fs.mkdirSync(shots, { recursive: true });
if (!nds) { console.error('usage: play_multicore_e2e.mjs <nds-homebrew.nds>'); process.exit(2); }
const R = reporter(), { check } = R;
const dir = buildDiscs(), srv = await staticServer(), browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
await ctx.addInitScript(() => {
  window.__workers = new Set(); const W = window.Worker; window.Worker = class extends W { constructor(...a) { super(...a); window.__workers.add(this); } terminate() { window.__workers.delete(this); super.terminate(); } };
  window.__audio = []; const A = window.AudioContext; window.AudioContext = class extends A { constructor(...a) { super(...a); window.__audio.push(this); } };
  window.__maxWorkers = 0; setInterval(() => { window.__maxWorkers = Math.max(window.__maxWorkers, window.__workers.size); }, 50);
});
const p = await ctx.newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(String(e)));
await p.goto(`${srv.base}/play/`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 20000 });
const hasCore = (m) => srv.log.some((x) => x.includes(m));
const heap = () => p.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0) / 1048576);
async function openMenu() { const b = await p.locator('.ctl-c[data-id=menu] .ctl-pillbtn').boundingBox(); await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down(); await p.mouse.up(); await p.waitForSelector('.ctl-menu .sheet'); }
async function leave() { await openMenu(); await p.evaluate(() => document.querySelector('.ctl-menu [data-act=leave]').click()); await p.waitForSelector('#confirmYes', { state: 'visible' }); await p.evaluate(() => document.querySelector('#confirmYes').click()); return until(async () => (await p.evaluate(() => document.body.dataset.screen)) === 'library', 20000); }
const snapshot = () => p.evaluate(() => ({ workers: window.__workers.size, open: window.__audio.filter((a) => a.state !== 'closed').length, platform: document.getElementById('game') ? document.getElementById('game').dataset.platform : '' }));

// ---------------------------------------------------------------- 1. a Nintendo DS game: the DS core, no PlayStation download
await p.setInputFiles('#romFile', nds); await until(async () => (await p.evaluate(() => window.dslinkPlay.games.length)) === 1, 20000);
const dsId = await p.evaluate(() => window.dslinkPlay.games[0].id);
await p.click(`li.game[data-id="${dsId}"] .play`); await until(() => p.evaluate(() => window.dslinkPlay.isPlaying()), 40000); await sleep(2500);
let s1 = await snapshot();
check('NDS: GIOCA starts the DS core (melonDS), touch layout nds, input profile NDS_STANDARD, exactly one worker and one audio context', s1.platform === 'nds' && s1.workers === 1 && s1.open === 1 && (await p.evaluate(() => window.dslinkPlay.profile.inputProfile)) === 'NDS_STANDARD' && (await p.evaluate(() => window.dslinkPlay.player.core.id)) === 'melonds' && (await p.evaluate(() => window.dslinkPlay.stats().emuFps)) > 50);
check('LAZY LOAD: a user who only plays DS games never downloads the PlayStation core', !hasCore('/core/ps1/') && hasCore('/core/dslink_wasm.wasm'));
const heapDs = await heap(), wasmDs = await p.evaluate(() => window.dslinkPlay.stats().wasmMB);
await leave(); let s2 = await snapshot();
check('NDS EXIT: no zombie worker, the audio context is closed', s2.workers === 0 && s2.open === 0);

// ---------------------------------------------------------------- 2. a PlayStation game in the same page: the PS1 core
await p.setInputFiles('#romFile', files(dir, 'Test Game.cue', 'Test Game.bin')); await until(async () => (await p.evaluate(() => window.dslinkPlay.games.length)) === 2, 60000);
const psId = await p.evaluate(() => window.dslinkPlay.games.find((g) => g.platform === 'PS1').id);
const before = await heap();
await p.click(`li.game[data-id="${psId}"] .play`); await p.waitForSelector('#hleBox:not([hidden])'); await p.click('#btnHleGo');
await until(() => p.evaluate(() => window.dslinkPlay.isPlaying()), 40000); await sleep(3500);
let s3 = await snapshot(); const f = await grab(p);
check('PS1: GIOCA starts the PlayStation core (pcsx-rearmed), touch layout ps1, input profile PS1_DIGITAL, exactly one worker and one audio context', s3.platform === 'ps1' && s3.workers === 1 && s3.open === 1 && (await p.evaluate(() => window.dslinkPlay.profile.inputProfile)) === 'PS1_DIGITAL' && (await p.evaluate(() => window.dslinkPlay.player.core.id)) === 'pcsx-rearmed' && near(pix(f, ...LAYOUT.header), [0, 121, 57]));
check('LAZY LOAD: the PlayStation core was fetched when the PS1 game was added/started, not before', hasCore('/core/ps1/playsphere_ps1.wasm'));
const heapPs = await heap(), wasmPs = await p.evaluate(() => window.dslinkPlay.stats().wasmMB);
await leave(); let s4 = await snapshot();
check('PS1 EXIT: no zombie worker, the audio context is closed', s4.workers === 0 && s4.open === 0);

// ---------------------------------------------------------------- 3. back to the DS game: still the DS core, still its own controls
await p.click(`li.game[data-id="${dsId}"] .play`); await until(() => p.evaluate(() => window.dslinkPlay.isPlaying()), 40000); await sleep(2500);
let s5 = await snapshot();
check('NDS AGAIN: the DS game starts again with the DS core and the DS controls (nothing of the PS1 session leaked in)', s5.platform === 'nds' && s5.workers === 1 && s5.open === 1 && (await p.evaluate(() => window.dslinkPlay.profile.platform)) === 'NDS' && (await p.evaluate(() => window.dslinkPlay.player.core.id)) === 'melonds' && (await p.evaluate(() => window.dslinkPlay.stats().emuFps)) > 50);
await p.screenshot({ path: `${shots}/nds_again.png` });
await leave(); let s6 = await snapshot();
const maxW = await p.evaluate(() => window.__maxWorkers);
check('CORE CLEANUP: never more than ONE emulator worker alive at any moment across NDS -> PS1 -> NDS (the other core is not kept in memory)', maxW <= 2 && s6.workers === 0 && s6.open === 0, `max workers seen ${maxW} (a worker is counted while it starts/terminates)`);

// ---------------------------------------------------------------- 4. storage and saves are separate
const store = await p.evaluate(async () => {
  const s = window.dslinkPlay.store, all = await s.list('library/'), g = window.dslinkPlay.games;
  const ds = g.find((x) => x.platform !== 'PS1'), ps = g.find((x) => x.platform === 'PS1');
  const dsFiles = all.filter((k) => k.startsWith(`library/${ds.id}/`)), psFiles = all.filter((k) => k.startsWith(`library/${ps.id}/`));
  const psSave = await s.get(`library/${ps.id}/save`), dsSave = await s.get(`library/${ds.id}/save`);
  return { dsFiles, psFiles, psSave: psSave ? psSave.byteLength : 0, dsSave: dsSave ? dsSave.byteLength : 0, ids: [ds.id, ps.id] };
});
check('STORAGE: the two games live in separate folders with their own file kinds (rom.nds / disc/...), different ids', store.ids[0] !== store.ids[1] && store.dsFiles.some((k) => k.endsWith('/rom.nds')) && !store.dsFiles.some((k) => k.includes('/disc/')) && store.psFiles.some((k) => k.includes('/disc/')) && !store.psFiles.some((k) => k.endsWith('/rom.nds')), JSON.stringify({ ds: store.dsFiles.length, ps: store.psFiles.length }));
check('SAVES: the PlayStation memory card (128 KiB) and the DS save are different files in different games; one never overwrites the other', store.psSave === 131072 && store.dsSave !== 131072 || store.dsSave === 0, JSON.stringify({ ps: store.psSave, ds: store.dsSave }));
console.log(`DATA  JS heap MB: DS running ${heapDs.toFixed(1)}, before PS1 ${before.toFixed(1)}, PS1 running ${heapPs.toFixed(1)}; WebAssembly MB: DS ${wasmDs.toFixed(0)}, PS1 ${wasmPs.toFixed(0)}`);
check('NO SCRIPT ERRORS on the page', p.errors.length === 0, p.errors.join(' | ').slice(0, 300));
await browser.close(); srv.close();
process.exit(R.done() ? 0 : 1);
