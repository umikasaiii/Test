// PlaySphere PS1 + the Cloud (FASE 8), against a REAL Worker serving the packaged PWA: library metadata with platform PS1, Cloud Save of the memory card (two devices), BIOS in the private Cloud,
// presence ("IN GAME" without knowing the core), Party Voice surviving a PlayStation game, no INVITA for a game without PlaySphere multiplayer. Test disc = tools/ps1 homebrew only.
// usage: node play_ps1_cloud_e2e.mjs <worker-url>      (the Worker must have been started by scripts/package_pwa.sh output)
import fs from 'node:fs';
import { launch, device, account, api, me, befriend, until, sleep, uname, screen, flowing, partyState, reporter, PASSWORD } from './netlib.mjs';
import { buildDiscs, files, grab, pix, LAYOUT, counterOf, near } from './ps1lib.mjs';
const [BASE] = process.argv.slice(2);
if (!BASE) { console.error('usage: play_ps1_cloud_e2e.mjs <worker-url>'); process.exit(2); }
const R = reporter(), { check } = R;
const dir = buildDiscs(), browser = await launch();
const GID = 'ps1-psph00001';
async function importPs1(p) { const n = await p.evaluate(() => window.dslinkPlay.games.length); await p.setInputFiles('#romFile', files(dir, 'Test Game.cue', 'Test Game.bin')); return until(async () => (await p.evaluate(() => window.dslinkPlay.games.length)) > n, 60000); }
async function play(p) { await p.click('li.game[data-platform=PS1] .play'); await p.waitForSelector('#hleBox:not([hidden])', { timeout: 20000 }); await p.click('#btnHleGo'); return until(() => p.evaluate(() => window.dslinkPlay.isPlaying()), 60000); }
async function leave(p) {
  const b = await p.locator('.ctl-c[data-id=menu] .ctl-pillbtn').boundingBox(); await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.mouse.down(); await p.mouse.up(); await p.waitForSelector('.ctl-menu .sheet');
  await p.evaluate(() => document.querySelector('.ctl-menu [data-act=leave]').click()); await p.waitForSelector('#confirmYes', { state: 'visible' }); await p.evaluate(() => document.querySelector('#confirmYes').click());
  return until(async () => (await screen(p)) === 'library', 20000);
}
const saveOf = (p) => p.evaluate(async () => { const g = window.dslinkPlay.games.find((x) => x.platform === 'PS1'); const b = g && await window.dslinkPlay.store.get(`library/${g.id}/save`); return b ? b.byteLength : 0; });

// ---------------------------------------------------------------- device A: account, import, library metadata
const nameA = uname('pa'), A = await device(browser, BASE, { name: 'A' });
check('ACCOUNT: sign up on device A', await account(A, nameA));
check('PS1 IMPORT on device A (account signed in)', await importPs1(A));
await A.evaluate(async () => { await window.dslinkPlay.cloud.loadLibrary(); });
const lib = await until(async () => { const r = await api(A, 'GET', '/api/cloud/library'); const l = r.body && (r.body.library || r.body.entries || r.body.games); return l && l.find((e) => e.gameId === GID) ? l : null; }, 10000);
const entry = lib && lib.find((e) => e.gameId === GID);
check('CLOUD LIBRARY: the PlayStation game is in the account\'s library metadata (platform ps1, core pcsx-rearmed, serial, no multiplayer) - metadata only, never the disc', entry && entry.platform === 'ps1' && entry.coreId === 'pcsx-rearmed' && entry.productCode === 'PSPH00001' && entry.multiplayerMode === 'none' && !entry.cloudFile, JSON.stringify(entry));

// ---------------------------------------------------------------- friend B: presence and invites
const nameB = uname('pb'), B = await device(browser, BASE, { name: 'B' }); await account(B, nameB); await befriend(A, B, nameB);
await until(async () => (await api(A, 'GET', '/api/friends')).body.friends.every((f) => f.status !== 'OFFLINE'), 8000);
// party first (it must survive the game)
const idB = await me(B), idA = await me(A);
await A.evaluate(async () => { await window.dslinkPlay.party.create(); });
await A.evaluate(async (uid) => { await window.dslinkPlay.party.invite(uid); }, idB); await B.waitForSelector('#partyInviteBox:not([hidden])', { timeout: 15000 }); await B.click('#btnPInvAccept');
check('PARTY: A and B are in a Party with voice flowing before the game', await until(async () => (await partyState(A)).n === 2 && (await partyState(B)).n === 2, 15000) && await until(() => flowing(A, 1500), 30000));
check('INVITES: the PlayStation game is not offered as a game to play together (no INVITA A GIOCARE for a game without PlaySphere multiplayer)', await (async () => { await A.click('#btnAccount'); await A.waitForSelector('[data-screen=profile].on'); await A.click('#btnProfFriends'); await A.waitForSelector('[data-screen=friends].on'); await A.locator('button', { hasText: 'INVITA A GIOCARE' }).first().click(); await sleep(600); const t = await A.innerText('#cloudToast'); await A.evaluate(() => { }); return /multiplayer PlaySphere/.test(t) && (await A.locator('#pickGame:not([hidden])').count()) === 0; })());
await A.evaluate(() => { for (const id of ['btnFriendsBack', 'btnProfBack']) { const b = document.getElementById(id); if (b && b.offsetParent) b.click(); } });
await until(async () => (await screen(A)) === 'library', 8000);

// ---------------------------------------------------------------- play on A: presence, party survives
const up = await play(A); await sleep(3500); const f1 = await grab(A);
check('PS1 on an account device: boots, memory card counter 1', up && counterOf(f1) === 1 && near(pix(f1, ...LAYOUT.mc), [0, 255, 0]));
const seenB = await until(async () => { const r = await api(B, 'GET', '/api/friends'); const f = r.body.friends.find((x) => x.userId === idA); return f && f.status === 'IN_GAME' ? f : null; }, 12000);
check('PRESENCE: the friend sees "IN GAME" with the game title, without anything about the core', seenB && /Test Game|PSPH/i.test(JSON.stringify(seenB)) && !/pcsx|melonds|core/i.test(JSON.stringify(seenB)), JSON.stringify(seenB));
check('PARTY SURVIVES PS1: the party is still connected and the voice still flows while the PlayStation game runs', (await partyState(A)).n === 2 && await flowing(A, 2000) && await flowing(B, 2000));
check('PARTY BAR: the floating party controls are available during the PlayStation game', await A.locator('#partyBar:not([hidden])').count() === 1);
await leave(A);
check('PARTY SURVIVES PS1 EXIT: after leaving the game the party and the voice are still there', (await partyState(A)).n === 2 && await flowing(A, 1800));
const seenB2 = await until(async () => { const r = await api(B, 'GET', '/api/friends'); const f = r.body.friends.find((x) => x.userId === idA); return f && f.status !== 'IN_GAME' ? f : null; }, 12000);
check('PRESENCE: back to the menus the friend no longer sees IN GAME', !!seenB2);
await A.evaluate(async () => { await window.dslinkPlay.party.leave(); }); await B.evaluate(async () => { await window.dslinkPlay.party.leave(); });

// ---------------------------------------------------------------- Cloud Save of the memory card
check('LOCAL SAVE: the memory card exists locally after the game', (await saveOf(A)) === 131072);
await A.evaluate(() => window.dslinkPlay.cfiles.refresh());
const pushed = await A.evaluate(async () => { const b = [...document.querySelectorAll('li.game[data-platform=PS1] .acts button')].find((x) => /SALVA NEL MIO CLOUD/.test(x.textContent)); if (!b) return 'no-button'; b.click(); return 'clicked'; });
const head1 = await until(async () => { const r = await api(A, 'GET', `/api/saves/${GID}`); return r.body && r.body.head ? r.body.head : null; }, 15000);
check('CLOUD SAVE: SALVA NEL MIO CLOUD sends the memory card to the account (revision 1, 128 KiB), the disc is not uploaded', pushed === 'clicked' && head1 && head1.revision === 1 && head1.size === 131072 && !(await api(A, 'GET', '/api/files')).body.games.some((g) => g.gameId === GID));
// device A2 (same account): game + save arrive, the counter continues
const A2 = await device(browser, BASE, { name: 'A2' });
check('ACCOUNT: log in on device A2', await account(A2, nameA, 'login'));
await importPs1(A2);
const pulled = await A2.evaluate(async () => { const g = window.dslinkPlay.games.find((x) => x.platform === 'PS1'); await window.dslinkPlay.cfiles.refresh(); const r = await window.dslinkPlay.cfiles.syncSave(g.id, 'ps1-psph00001'); return r.action; });
check('CLOUD SAVE: on a second device the memory card is pulled from the Cloud before playing', pulled === 'pulled' && (await saveOf(A2)) === 131072, pulled);
const up2 = await play(A2); await sleep(3500); const f2 = await grab(A2);
check('CLOUD SAVE RESTORE: the second device boots with the memory card of the first one (counter continued 1 -> 2)', up2 && counterOf(f2) === 2, 'counter ' + counterOf(f2));
await leave(A2);
await A2.evaluate(async () => { const g = window.dslinkPlay.games.find((x) => x.platform === 'PS1'); await window.dslinkPlay.whenSaved(); for (let i = 0; i < 6; i++) { const r = await window.dslinkPlay.cfiles.syncSave(g.id, 'ps1-psph00001'); if (r.action !== 'busy') return r.action; await new Promise((x) => setTimeout(x, 500)); } return 'busy'; });
const hist = await until(async () => { const r = await api(A2, 'GET', `/api/saves/${GID}`); return r.body.head && r.body.head.revision === 2 ? r : null; }, 10000);
check('CLOUD SAVE REVISIONS: the new card is revision 2 and the history keeps both (restore point)', hist && hist.body.history.length === 2 && hist.body.head.revision === 2, hist && `revs ${hist.body.history.map((h) => h.revision)}`);
const restored = await A2.evaluate(async () => { const g = window.dslinkPlay.games.find((x) => x.platform === 'PS1'); const r = await window.dslinkPlay.cfiles.restore(g.id, 'ps1-psph00001', 1); return r.action; });
check('CLOUD SAVE RESTORE POINT: revision 1 can be restored (a new revision 3, nothing lost)', restored === 'pulled' && (await api(A2, 'GET', `/api/saves/${GID}`)).body.head.revision === 3);
// conflict: A (still at revision 1 base) writes another save -> the Cloud refuses to overwrite silently
await sleep(300);
const confl = await A.evaluate(async () => { const g = window.dslinkPlay.games.find((x) => x.platform === 'PS1'); const b = new Uint8Array(await window.dslinkPlay.store.get(`library/${g.id}/save`)); b[200] ^= 0x55; await window.dslinkPlay.store.put(`library/${g.id}/save`, b.buffer); const r = await window.dslinkPlay.cfiles.syncSave(g.id, 'ps1-psph00001'); return r.action; });
check('CLOUD SAVE CONFLICT: a different save from another device is detected, never overwritten silently', confl === 'conflict', confl);

// ---------------------------------------------------------------- BIOS in the private Cloud
const bios = Buffer.alloc(524288); bios.write('System ROM Version 2.0 05/07/95 A', 4000); fs.writeFileSync(`${dir}/fake-bios-na.bin`, bios);
await A2.setInputFiles('#ps1BiosFile', `${dir}/fake-bios-na.bin`);
check('BIOS: a valid BIOS file (recognised by content) is stored under its region on the device', await until(async () => (await A2.evaluate(() => window.dslinkPlay.store.get('system/ps1-bios-na.bin'))) !== null, 8000));
const upBios = await A2.evaluate(async () => { await window.dslinkPlay.cfiles.refresh(); const b = [...document.querySelectorAll('#ps1SysList button')].find((x) => /SALVA NEL MIO CLOUD/.test(x.textContent)); if (b) b.click(); return !!b; });
const inCloud = await until(async () => (await api(A2, 'GET', '/api/files')).body.system.some((s) => s.name === 'ps1-bios-na.bin' && s.size === 524288), 15000);
const anon = await browser.newContext(); const ap = await anon.newPage(); const anonStatus = (await ap.request.get(BASE + '/api/files/system/ps1-bios-na.bin')).status(); await anon.close();
check('BIOS IN THE PRIVATE CLOUD: saved in the account\'s own space (never public: anonymous access refused)', upBios && inCloud && anonStatus === 401, JSON.stringify({ upBios, inCloud, anonStatus }));
const A3 = await device(browser, BASE, { name: 'A3' }); await account(A3, nameA, 'login');
check('BIOS RECOVERY: a third device of the account gets the BIOS back from the Cloud automatically', await until(async () => (await A3.evaluate(() => window.dslinkPlay.store.get('system/ps1-bios-na.bin'))) !== null, 20000));
const errs = [A, A2, A3, B].flatMap((p) => p.errors);
check('NO SCRIPT ERRORS on any device', errs.length === 0, errs.join(' | ').slice(0, 300));
await browser.close();
process.exit(R.done() ? 0 : 1);
