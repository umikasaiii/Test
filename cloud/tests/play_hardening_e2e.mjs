// PlaySphere FASE 9 hardening, in real Chrome against the source tree: storage (IndexedDB fallback, quota exceeded, partial write, corrupt entries, corrupt saves), saves that cannot be
// written, a core that dies silently, errors reported by a core, a Cloud that never answers. Every failure must leave the app usable, say what happened, and lose nothing.
// Homebrew only. usage: node play_hardening_e2e.mjs <nds-homebrew.nds>
import { staticServer, launch, buildDiscs, files, until, sleep, reporter } from './ps1lib.mjs';
const [nds] = process.argv.slice(2);
if (!nds) { console.error('usage: play_hardening_e2e.mjs <nds-homebrew.nds>'); process.exit(2); }
const { check, done } = reporter();
const srv = await staticServer(), browser = await launch(), discs = buildDiscs();
const go = (p, t) => p.evaluate((x) => window.dslinkPlay.go(x), t);
async function open(query = '', ctxOpts = {}, setup) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, ...ctxOpts });
  await ctx.addInitScript(() => { window.__workers = new Set(); const W = window.Worker; window.Worker = class extends W { constructor(...a) { super(...a); window.__workers.add(this); } terminate() { window.__workers.delete(this); super.terminate(); } }; });
  const p = await ctx.newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(String(e))); if (setup) await setup(p);
  await p.goto(`${srv.base}/play/${query}`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 20000 }); p.ctx = ctx; return p;
}
const addDs = async (p, n = 1) => { await go(p, 'games'); await p.setInputFiles('#romFile', nds); await until(async () => (await p.evaluate(() => window.dslinkPlay.games.length)) === n, 20000); return p.evaluate(() => window.dslinkPlay.games[0].id); };
const play = async (p, id) => { await go(p, 'games'); await p.click(`li.game[data-id="${id}"] .play`); await until(() => p.evaluate(() => window.dslinkPlay.isPlaying()), 40000); };
const exitGame = async (p) => { await p.evaluate(() => { document.getElementById('confirm').hidden = false; }); await p.click('#confirmYes'); await p.waitForFunction(() => document.body.dataset.screen === 'library', null, { timeout: 20000 }); };
const keys = (p) => p.evaluate(() => window.dslinkPlay.store.list('library/'));

// ============================================================================ 1. storage backends
let p = await open('?nosw&store=idb');
check('STORAGE: with ?store=idb the IndexedDB backend works end to end (import, list, play, save, reload)', (await p.evaluate(() => window.dslinkPlay.store.kind)) === 'idb');
let id = await addDs(p); await play(p, id); await sleep(1500); await p.evaluate(() => window.dslinkPlay.player.save(true)); await exitGame(p);
const saveLen = await p.evaluate(async (i) => { const b = await window.dslinkPlay.store.get(`library/${i}/save`); return b ? b.byteLength : 0; }, id);
check('STORAGE: IndexedDB keeps the save the game wrote', saveLen > 0, String(saveLen));
await p.reload(); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
check('STORAGE: after a reload the game and its save are still there', (await p.evaluate(() => window.dslinkPlay.games.length)) === 1 && (await p.evaluate(async (i) => !!(await window.dslinkPlay.store.get(`library/${i}/save`)), id)));
await p.ctx.close();

// ============================================================================ 2. quota exceeded, partial write
p = await open('?nosw'); await go(p, 'games');
await p.evaluate(() => { const s = window.dslinkPlay.store, put = s.put.bind(s); s.__put = put; s.put = async () => { throw new DOMException('no space', 'QuotaExceededError'); }; });
await p.setInputFiles('#romFile', nds); await sleep(1500);
check('QUOTA EXCEEDED: importing with a full device says so in plain words (also as a toast) and adds nothing', /Spazio .* esaurito/.test(await p.innerText('#libErr')) && /Spazio/.test(await p.innerText('#cloudToast')) && (await p.evaluate(() => window.dslinkPlay.games.length)) === 0);
check('QUOTA EXCEEDED: no half-imported file is left behind', (await keys(p)).length === 0, JSON.stringify(await keys(p)));
await p.evaluate(() => { const s = window.dslinkPlay.store; let n = 0; s.put = async (path, data) => { if (++n === 2) throw new DOMException('no space', 'QuotaExceededError'); return s.__put(path, data); }; });
await p.setInputFiles('#romFile', nds); await sleep(1500);
check('PARTIAL WRITE: the ROM was written but the entry (meta) could not be: the ROM is removed again (no invisible leftover taking space)', (await keys(p)).length === 0 && (await p.evaluate(() => window.dslinkPlay.games.length)) === 0, JSON.stringify(await keys(p)));
await p.evaluate(() => { const s = window.dslinkPlay.store; s.put = s.__put; });
await p.setInputFiles('#romFile', nds); id = null; await until(async () => (await p.evaluate(() => window.dslinkPlay.games.length)) === 1, 15000);
check('QUOTA EXCEEDED: once there is space again the same file imports normally (nothing stuck)', (await p.evaluate(() => window.dslinkPlay.games.length)) === 1);
id = await p.evaluate(() => window.dslinkPlay.games[0].id);

// ============================================================================ 3. corrupt entries and corrupt saves
await p.evaluate(async () => { const s = window.dslinkPlay.store; await s.put('library/zz-broken/meta.json', new TextEncoder().encode('{not json').buffer); await s.put('library/zz-empty/meta.json', new ArrayBuffer(0)); });
await p.reload(); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
check('CORRUPT ENTRY: a damaged library entry is ignored; the other games are listed and the app starts normally', (await p.evaluate(() => window.dslinkPlay.games.length)) === 1 && !p.errors.length, p.errors.join('|'));
await p.evaluate(async (i) => { await window.dslinkPlay.store.put(`library/${i}/save`, new Uint8Array([1, 2, 3]).buffer); }, id);
await play(p, id); await sleep(2500);
check('CORRUPT SAVE (DS): a 3-byte "save" does not stop the game: it boots and runs at full speed', (await p.evaluate(() => window.dslinkPlay.stats().emuFps)) > 45 && !p.errors.length, p.errors.join('|'));
await exitGame(p);
await p.evaluate(() => { const o = window.dslinkPlay.store; o.__put = o.put.bind(o); });

// ============================================================================ 4. a save that cannot be written is never silent, and is retried
await play(p, id); await sleep(1200);
await p.evaluate(() => { const s = window.dslinkPlay.store; s.put = async (path, d) => { if (/\/save$/.test(path)) throw new DOMException('no space', 'QuotaExceededError'); return s.__put(path, d); }; });
await p.evaluate(() => window.dslinkPlay.player.save(true)); await sleep(800);
check('SAVE FAILURE: when the save cannot be written the user is told at once (toast "Salvataggio non riuscito") instead of losing it silently', /Salvataggio non riuscito/.test(await p.innerText('#cloudToast')));
await p.evaluate(async (i) => { const s = window.dslinkPlay.store; s.put = s.__put; await s.del(`library/${i}/save`); }, id);
await p.evaluate(() => window.dslinkPlay.player.save(true)); await exitGame(p);
check('SAVE FAILURE: space is back: the save that was waiting is written when the game is closed (retry), nothing lost', await p.evaluate(async (i) => { const b = await window.dslinkPlay.store.get(`library/${i}/save`); return !!b && b.byteLength > 16; }, id));

// ============================================================================ 5. error recovery: a core that reports an error, a core that dies silently
await play(p, id); await sleep(800);
await p.evaluate(() => window.dslinkPlay.player.onError('RuntimeError: unreachable\n    at wasm-function[3]'));
await p.waitForFunction(() => document.body.dataset.screen === 'error', null, { timeout: 10000 });
check('CORE ERROR: the app lands on a friendly error screen (no stack), the worker is gone, nothing needs a reload', /fermato/.test(await p.innerText('#errorTitle')) && !/wasm-function|RuntimeError/.test(await p.innerText('[data-screen=error]')) && (await p.evaluate(() => window.__workers.size)) === 0);
await p.click('#btnErrBack'); await play(p, id); await sleep(1500);
check('CORE ERROR: after the error the very same game starts again in the same page (back to a safe UI without reloading)', (await p.evaluate(() => window.dslinkPlay.isPlaying())) && (await p.evaluate(() => window.dslinkPlay.stats().emuFps)) > 45);
await p.evaluate(() => window.dslinkPlay.player.worker.terminate());           // the browser kills the worker (out of memory): no message, no error event
const t0 = Date.now(); await p.waitForFunction(() => document.body.dataset.screen === 'error', null, { timeout: 25000 });
check('WORKER CRASH: a core that stops silently is detected (no new frames for ~10 s) and the app returns to a safe screen', /fermato/.test(await p.innerText('#errorTitle')) && Date.now() - t0 < 20000, `${Date.now() - t0} ms`);
await p.click('#btnErrBack');
check('WORKER CRASH: the library is intact and usable afterwards (the game and its save are still there)', (await p.evaluate(() => window.dslinkPlay.games.length)) === 1 && !!(await p.evaluate(async (i) => !!(await window.dslinkPlay.store.get(`library/${i}/save`)), id)));
await p.ctx.close();

// ============================================================================ 6. the Cloud never answers: nothing waits for it
p = await open('?nosw', {}, async (pg) => { await pg.route('**/api/**', () => { /* never answered */ }); });
id = await addDs(p); const t1 = Date.now(); await play(p, id);
check('CLOUD TIMEOUT: with a Cloud that never answers the library works and GIOCA starts the game at once (no waiting on the network)', Date.now() - t1 < 15000 && (await p.evaluate(() => window.dslinkPlay.isPlaying())), `${Date.now() - t1} ms`);
await exitGame(p); await p.ctx.close();

// ============================================================================ 7. PlayStation: corrupt memory card
p = await open('?nosw'); await go(p, 'games'); await p.setInputFiles('#romFile', files(discs, 'Test Game.cue', 'Test Game.bin')); await until(async () => (await p.evaluate(() => window.dslinkPlay.games.length)) === 1, 20000);
const psId = await p.evaluate(() => window.dslinkPlay.games[0].id);
await p.evaluate(async (i) => { await window.dslinkPlay.store.put(`library/${i}/save`, new Uint8Array(100).fill(7).buffer); }, psId);
await go(p, 'games'); await p.click(`li.game[data-id="${psId}"] .play`); await p.waitForSelector('#hleBox:not([hidden])', { timeout: 20000 }); await p.click('#btnHleGo'); await until(() => p.evaluate(() => window.dslinkPlay.isPlaying()), 40000); await sleep(2500);
check('CORRUPT SAVE (PS1): a damaged 100-byte memory card does not stop the game: it boots and runs', (await p.evaluate(() => window.dslinkPlay.stats().emuFps)) > 45 && !p.errors.length, p.errors.join('|'));
await exitGame(p);
check('CORRUPT SAVE (PS1): afterwards the memory card on the device is a proper 128 KiB card again', await p.evaluate(async (i) => { const b = await window.dslinkPlay.store.get(`library/${i}/save`); return !!b && b.byteLength === 131072; }, psId));
await p.ctx.close();

await browser.close(); srv.close();
process.exit(done() ? 0 : 1);
