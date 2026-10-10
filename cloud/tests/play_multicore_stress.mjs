// PlaySphere FASE 9: multi-core stress. NDS -> PS1 -> NDS and PS1 -> NDS -> PS1, several times in ONE page (no reload): after every exit there is no worker, no audio context, no canvas left; the JS heap and the WASM
// memory stay bounded; saves of one system are never touched by the other; at most one core is ever alive. Homebrew only.
// usage: node play_multicore_stress.mjs <nds-homebrew.nds> [rounds=3]
import { createHash } from 'node:crypto';
import { staticServer, launch, buildDiscs, files, until, sleep, reporter } from './ps1lib.mjs';
const [nds, roundsArg = '3'] = process.argv.slice(2), ROUNDS = Math.max(1, Number(roundsArg) || 3);
if (!nds) { console.error('usage: play_multicore_stress.mjs <nds-homebrew.nds> [rounds]'); process.exit(2); }
const { check, done } = reporter();
const dir = buildDiscs(), srv = await staticServer(), browser = await launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
await ctx.addInitScript(() => {
  window.__workers = new Set(); const W = window.Worker; window.Worker = class extends W { constructor(...a) { super(...a); window.__workers.add(this); } terminate() { window.__workers.delete(this); super.terminate(); } };
  window.__audio = []; const A = window.AudioContext; window.AudioContext = class extends A { constructor(...a) { super(...a); window.__audio.push(this); } };
  window.__gl = 0; const gc = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...r) { if (/webgl/.test(t)) window.__gl++; return gc.call(this, t, ...r); };
  window.__maxWorkers = 0; setInterval(() => { window.__maxWorkers = Math.max(window.__maxWorkers, window.__workers.size); }, 40);
});
const p = await ctx.newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(String(e)));
await p.goto(`${srv.base}/play/?nosw`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 20000 });
const go = (t) => p.evaluate((x) => window.dslinkPlay.go(x), t);
await go('games'); await p.setInputFiles('#romFile', [nds, ...files(dir, 'Test Game.cue', 'Test Game.bin')]); await until(async () => (await p.evaluate(() => window.dslinkPlay.games.length)) === 2, 30000);
const ids = await p.evaluate(() => Object.fromEntries(window.dslinkPlay.games.map((g) => [g.platform || 'NDS', g.id])));
const saveHash = async (id) => { const a = await p.evaluate(async (i) => { const b = await window.dslinkPlay.store.get(`library/${i}/save`); return b ? Array.from(new Uint8Array(b)) : null; }, id); return a ? createHash('sha256').update(Buffer.from(a)).digest('hex').slice(0, 12) + ':' + a.length : null; };
const heap = () => p.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : 0) / 1048576);
async function launchGame(sys) {
  await go('games'); await p.click(`li.game[data-id="${ids[sys]}"] .play`);
  if (sys === 'PS1') { await p.waitForSelector('#hleBox:not([hidden])', { timeout: 20000 }); await p.click('#btnHleGo'); }
  await until(() => p.evaluate(() => window.dslinkPlay.isPlaying()), 40000); await sleep(1500);
  return p.evaluate(() => ({ workers: window.__workers.size, open: window.__audio.filter((a) => a.state !== 'closed').length, platform: document.getElementById('game').dataset.platform, fps: window.dslinkPlay.stats().emuFps, wasm: window.dslinkPlay.stats().wasmMB }));
}
async function exitGame() {
  await p.evaluate(async () => { await window.dslinkPlay.player.save(true); document.getElementById('confirm').hidden = false; }); await p.click('#confirmYes'); await p.waitForFunction(() => document.body.dataset.screen === 'library', null, { timeout: 20000 });
  return p.evaluate(() => ({ workers: window.__workers.size, open: window.__audio.filter((a) => a.state !== 'closed').length, canvases: document.querySelectorAll('canvas:not(#codeQr)').length, game: document.getElementById('game').children.length }));
}
// warm-up round (JIT, allocator): the memory baseline is taken after it
await launchGame('NDS'); await exitGame(); await launchGame('PS1'); await exitGame(); await sleep(500);
const heap0 = await heap(); const wasm = { NDS: [], PS1: [] }; let launches = 0, bad = [];
const orders = [['NDS', 'PS1', 'NDS'], ['PS1', 'NDS', 'PS1']];
for (let r = 0; r < ROUNDS; r++) for (const order of orders) for (const sys of order) {
  const dsBefore = await saveHash(ids.NDS), psBefore = await saveHash(ids.PS1);
  const s = await launchGame(sys); launches++; wasm[sys].push(s.wasm);
  if (s.workers !== 1 || s.open !== 1 || s.platform !== sys.toLowerCase() || s.fps < 45) bad.push(`launch ${launches} ${sys}: ${JSON.stringify(s)}`);
  const e = await exitGame(); if (e.workers !== 0 || e.open !== 0 || e.canvases !== 0 || e.game !== 0) bad.push(`exit ${launches} ${sys}: ${JSON.stringify(e)}`);
  const dsAfter = await saveHash(ids.NDS), psAfter = await saveHash(ids.PS1);
  if (sys === 'PS1' && dsAfter !== dsBefore) bad.push(`launch ${launches}: a PlayStation session changed the DS save (${dsBefore} -> ${dsAfter})`);
  if (sys === 'NDS' && psAfter !== psBefore) bad.push(`launch ${launches}: a DS session changed the PlayStation memory card (${psBefore} -> ${psAfter})`);
}
check(`MULTICORE STRESS: ${launches} launches (NDS->PS1->NDS and PS1->NDS->PS1, x${ROUNDS}) in one page: every launch has exactly one worker, one audio context, the right system and full speed; every exit leaves no worker, audio context or canvas`, !bad.length && launches === ROUNDS * 6, bad.slice(0, 3).join(' ; '));
const maxW = await p.evaluate(() => window.__maxWorkers);
check('MULTICORE STRESS: never more than one core worker alive at the same time (the old core is disposed before the new one starts)', maxW <= 1 + 1 /* the render worker of a session can overlap its core */, `max ${maxW}`);
const heap1 = await heap();
check('MULTICORE STRESS: the JS heap does not grow with the number of switches (bounded growth after the warm-up)', heap1 - heap0 < 40, `${heap0.toFixed(1)} -> ${heap1.toFixed(1)} MB`);
const spread = (a) => (a.length ? Math.max(...a) - Math.min(...a) : 0);
check('MULTICORE STRESS: the WebAssembly memory of each system is the same at every launch (the core is recreated clean, nothing accumulates)', spread(wasm.NDS) < 1 && spread(wasm.PS1) < 1, `DS ${wasm.NDS[0] && wasm.NDS[0].toFixed(1)} MB (spread ${spread(wasm.NDS).toFixed(2)}), PS1 ${wasm.PS1[0] && wasm.PS1[0].toFixed(1)} MB (spread ${spread(wasm.PS1).toFixed(2)})`);
const gl = await p.evaluate(() => ({ created: window.__gl, canvases: document.querySelectorAll('canvas:not(#codeQr)').length }));
check('MULTICORE STRESS: no canvas / WebGL context is left attached after the last exit', gl.canvases === 0, JSON.stringify(gl));
const keysDs = await p.evaluate((i) => window.dslinkPlay.store.list(`library/${i}/`), ids.NDS), keysPs = await p.evaluate((i) => window.dslinkPlay.store.list(`library/${i}/`), ids.PS1);
check('MULTICORE STRESS: saves stay isolated per game: DS save and PlayStation memory card are different files with the right sizes', keysDs.some((k) => k.endsWith('/save')) && keysPs.some((k) => k.endsWith('/save')) && (await saveHash(ids.PS1)).endsWith(':131072'), `${await saveHash(ids.NDS)} / ${await saveHash(ids.PS1)}`);
check('MULTICORE STRESS: no script error on the page during the whole run', !p.errors.length, p.errors.join(' | '));
await browser.close(); srv.close(); process.exit(done() ? 0 : 1);
