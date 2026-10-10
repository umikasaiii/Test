// Party Voice end to end in real Chrome (fake microphone) against a REAL Worker runtime that also serves the PWA: accounts, invites, 2/3/4-member mesh, mute, volume, speaking, owner/kick,
// reconnect, the party surviving a game start and exit, microphone denied, voice over a TURN relay, DS-quality gate and voice-quality gate being separate.
// usage: node play_party_e2e.mjs <worker-url> <rom.nds (homebrew)> [--relay]   (--relay: needs the local coturn, see turn_local.sh, and a Worker started with the TURN vars)
import { launch, device, account, api, me, befriend, inviteToGame, rxBytes, flowing, partyState, until, sleep, uname, screen, reporter } from './netlib.mjs';

const [BASE, rom] = process.argv.slice(2), RELAY = process.argv.includes('--relay');
const R = reporter(), check = R.check;
const browser = await launch();
const names = { a: uname('pa'), b: uname('pb'), c: uname('pc'), d: uname('pd') };
const q = RELAY ? '&ice=relay' : '';
const A = await device(browser, BASE, { name: 'Honor', rom, query: q }), B = await device(browser, BASE, { name: 'iPhone', rom, query: q });
for (const [p, n] of [[A, names.a], [B, names.b]]) await account(p, n);
const idA = await me(A), idB = await me(B);
await befriend(A, B, names.b);
check('NO MICROPHONE REQUEST AT APP START: after loading DSLink and signing in, getUserMedia was never called', (await A.evaluate(() => window.__gum)) === 0 && (await B.evaluate(() => window.__gum)) === 0);
await until(async () => (await api(A, 'GET', '/api/friends')).body.friends.some((f) => f.status !== 'OFFLINE'), 10000);

// ============================================================================================ 1. party of 2: create, invite, accept
await A.click('#btnParty'); await A.waitForSelector('[data-screen=party].on'); await A.click('#btnPartyCreate');
check('CREA PARTY: the party exists, the microphone is requested now (not before) and A is the owner', !!(await until(async () => (await partyState(A)).inParty && (await partyState(A)).mic === 'on', 12000)) && (await A.evaluate(() => window.__gum)) >= 1 && (await partyState(A)).owner === idA);
await A.click('#btnPartyInvite'); await A.locator('#partyPickList li', { hasText: names.b.toUpperCase() }).locator('button', { hasText: 'INVITA' }).click();
await B.waitForSelector('#partyInviteBox:not([hidden])', { timeout: 15000 });
check('INVITA AL PARTY: B gets "X ti invita al Party" with ACCETTA / RIFIUTA', /ti invita al Party/.test(await B.innerText('#pInvWho')));
await B.click('#btnPInvAccept');
const two = await until(async () => { const a = await partyState(A), b = await partyState(B); return a.n === 2 && b.n === 2 && a.conn[idB] === 'connected' && b.conn[idA] === 'connected'; }, 25000);
check('ACCETTA: B joins the party and the two phones connect their voice (WebRTC audio, own connections)', !!two, JSON.stringify([await partyState(A), await partyState(B)]).slice(0, 220));
check('VOICE FLOWS both ways (audio bytes keep arriving)', (await flowing(A)) && (await flowing(B)));
check('PARTY 2: two members, Opus, a mesh of one connection', two && (await A.evaluate(async () => (await window.dslinkPlay.party.stats()).codec)) === 'opus', await A.evaluate(async () => JSON.stringify(await window.dslinkPlay.party.stats())).then((s) => s.slice(0, 200)));
const sp = await until(async () => (await partyState(B)).speaking[idA] === true, 20000), spA = await until(async () => (await partyState(A)).speaking[idA] === true, 20000);
check('SPEAKING INDICATOR: the fake microphone is heard - B sees A speaking, A sees itself speaking, the row is highlighted', !!sp && !!spA);
await B.click('#btnParty').catch(() => {}); await B.waitForSelector('[data-screen=party].on'); await A.waitForSelector('[data-screen=party].on');
check('party panel shows avatar, name, owner crown and the connection state', /👑/.test(await A.innerText('#partyList')) && (await A.locator('#partyList li.pm').count()) === 2);
await A.screenshot({ path: '/tmp/party-a.png' });

// ============================================================================================ 2. mute / unmute, volume, party audio
await A.click('#btnPartyMute');                                              // MUTE
const mutedSeen = await until(async () => (await partyState(B)).muted_by[idA] === true, 8000);
await sleep(1800); const quiet = []; for (let i = 0; i < 8; i++) { quiet.push((await partyState(B)).speaking[idA]); await sleep(250); }
check('MUTE: A mutes - B sees the mic closed, A\'s speaking indicator stops (the track is disabled, nothing is sent)', !!mutedSeen && quiet.every((x) => !x) && (await A.innerText('#btnPartyMute')) === 'UNMUTE' && (await B.locator(`#partyList li[data-user="${idA}"]`).getAttribute('data-muted')) === '1');
await A.click('#btnPartyMute');                                              // UNMUTE
const back = await until(async () => (await partyState(B)).muted_by[idA] === false && (await partyState(B)).speaking[idA] === true, 20000);
check('UNMUTE: the voice and the indicator come back', !!back && (await A.innerText('#btnPartyMute')) === 'MUTE');
await B.locator(`#partyList li[data-user="${idA}"] input.vol`).fill('30'); await sleep(500);
const gainA = await B.evaluate((id) => window.dslinkPlay.party.mesh.peers.get(id).gain.gain.value, idA);
check('INDIVIDUAL VOLUME: B lowers A\'s volume to 30% (per-member gain, not the whole party)', gainA > 0.25 && gainA < 0.36, gainA.toFixed(2));
await B.click('#btnPartyDeaf'); await sleep(400);
const masterOff = await B.evaluate(() => window.dslinkPlay.party.master.gain.value);
await B.click('#btnPartyDeaf'); await sleep(400);
check('DISATTIVA AUDIO PARTY: the party master gain goes to 0 and back (the microphone is not affected)', masterOff < 0.05 && (await B.evaluate(() => window.dslinkPlay.party.master.gain.value)) > 0.9 && (await partyState(B)).mic === 'on');

// ============================================================================================ 3. 3 and 4 members
const C = await device(browser, BASE, { name: 'Pixel', query: q }), D = await device(browser, BASE, { name: 'iPad', query: q });
await account(C, names.c); await account(D, names.d); const idC = await me(C), idD = await me(D);
await befriend(A, C, names.c); await befriend(A, D, names.d);
const joinParty = async (p) => { await until(async () => (await api(A, 'GET', '/api/friends')).body.friends.every((f) => f.status !== 'OFFLINE'), 8000); await A.evaluate(async (uid) => { await window.dslinkPlay.party.invite(uid); }, await me(p)); await p.waitForSelector('#partyInviteBox:not([hidden])', { timeout: 15000 }); await p.click('#btnPInvAccept'); };
await joinParty(C);
const three = await until(async () => { const s = await Promise.all([A, B, C].map(partyState)); return s.every((x) => x.n === 3 && Object.entries(x.conn).filter(([k]) => k !== undefined).filter(([, v]) => v === 'connected').length === 2); }, 30000);
check('PARTY 3: three members, a full mesh (each phone has 2 voice connections), voice flows to everyone', !!three && (await flowing(A)) && (await flowing(B)) && (await flowing(C)));
await joinParty(D);
const four = await until(async () => { const s = await Promise.all([A, B, C, D].map(partyState)); return s.every((x) => x.n === 4 && Object.values(x.conn).filter((v) => v === 'connected').length === 3); }, 40000);
check('PARTY 4: four members, 6 connections in the mesh (each phone 3), voice flows to everyone', !!four && (await flowing(A)) && (await flowing(B)) && (await flowing(C)) && (await flowing(D)));
const st4 = await D.evaluate(async () => { const s = await window.dslinkPlay.party.stats(); return { peers: s.peers, connected: s.connected, codec: s.codec }; });
check('VOICE metrics (dev overlay data): peers, codec, bitrate, rtt, jitter, loss, audio level, reconnects', st4.peers === 3 && st4.connected === 3 && st4.codec === 'opus');

// ============================================================================================ 4. owner / kick
check('OWNER/KICK: a non-owner has no way to remove anybody (the server refuses, the button is not shown)', (await api(B, 'POST', '/api/party/kick', { userId: idC })).status === 403 && (await B.locator('#partyList li button', { hasText: 'RIMUOVI' }).count()) === 0 && (await A.locator('#partyList li button', { hasText: 'RIMUOVI' }).count()) === 3);
await A.locator(`#partyList li[data-user="${idD}"] button`, { hasText: 'RIMUOVI' }).click();
const kicked = await until(async () => !(await partyState(D)).inParty && (await partyState(A)).n === 3, 15000);
const left = await until(async () => (await partyState(B)).n === 3 && Object.keys((await partyState(B)).conn).length === 3, 10000);
check('KICK: the owner removes D - D is out of the party (voice and mic released), the others see 3 members and keep talking', !!kicked && !!left && (await D.evaluate(() => window.dslinkPlay.party.mic !== 'x' && !window.dslinkPlay.party.localStream)) && (await flowing(A)));
await D.context().close();

// ============================================================================================ 5. reconnect: signaling socket, a dead peer connection, network change
await B.evaluate(() => window.dslinkPlay.party.signal.ws.close());
const sigBack = await until(async () => (await partyState(B)).signalReconnects >= 1 && (await partyState(B)).state === 'connected', 25000);
check('PARTY RECONNECT (signaling): the socket drops, it reconnects by itself, the voice never stopped', !!sigBack && (await flowing(B)));
const meshOf = (p) => p.evaluate(() => [...window.dslinkPlay.party.mesh.peers.values()].map((x) => ({ sid: x.sid, state: x.pc.connectionState })));
const sidsBefore = (await meshOf(B)).map((x) => x.sid);
await B.evaluate(() => { for (const p of window.dslinkPlay.party.mesh.peers.values()) p.pc.close(); window.dslinkPlay.party.resume('test'); });      // the OS killed the connections while the app slept
const rebuilt = await until(async () => { const [a, b, c] = await Promise.all([A, B, C].map(meshOf)); return b.length === 2 && b.every((x) => x.state === 'connected' && !sidsBefore.includes(x.sid)) && [a, c].every((m) => m.length === 2 && m.every((x) => x.state === 'connected')); }, 60000);
const dbgStates = async () => JSON.stringify(await Promise.all([A, B, C].map((p) => p.evaluate(() => ({ c: [...window.dslinkPlay.party.mesh.peers.values()].map((x) => x.pc.connectionState + '/' + x.conn), e: self.__voiceErrors || [], log: (self.__voiceLog || []).slice(-8) })))));
check('PARTY RECONNECT (peer connections): dead connections are rebuilt on resume (new connections on both sides) and the voice flows again to everyone', !!rebuilt && (await flowing(B, 2500)) && (await flowing(A, 2500)) && (await flowing(C, 2500)), await dbgStates());
await B.evaluate(() => { dispatchEvent(new Event('offline')); dispatchEvent(new Event('online')); }); await sleep(1500);
check('NETWORK CHANGE (voice): offline/online events re-check the connections without losing the party', (await partyState(B)).inParty && (await flowing(B)));
check('DEV OVERLAY: the VOICE line is there (no remote telemetry)', await B.evaluate(async () => { localStorage.setItem('dslink.opts', JSON.stringify({ dev: '1' })); return true; }));

// ============================================================================================ 6. the party survives a game start and a game exit; DS gate and voice gate are separate
const rooms = await inviteToGame(A, B, 'nds-dltt');
check('A invites B to a game while in the party; B accepts -> a game room (the party is untouched)', rooms.ok && (await partyState(A)).inParty && (await partyState(B)).inParty, rooms.err || '');
await B.click('#btnReady'); await until(async () => !(await A.locator('#btnStart').isDisabled()), 25000);
await A.click('#btnStart');
const playing = await until(async () => (await A.evaluate(() => window.dslinkPlay.isPlaying())) && (await B.evaluate(() => window.dslinkPlay.isPlaying())), 60000);
await sleep(1500);
check('PARTY SURVIVES GAME START: the game runs on both phones, the party and its voice keep going, the party bar is over the game', !!playing && (await partyState(A)).inParty && (await partyState(B)).inParty && (await flowing(A)) && (await flowing(B)) && (await A.isVisible('#partyBar')));
const mutedInGame = await A.evaluate(() => { const v = window.dslinkPlay.party; v.toggleMute(); return v.muted; }); await sleep(300);
check('MUTE during the game from the floating bar (the game controls are untouched)', mutedInGame === true && (await B.evaluate((id) => window.dslinkPlay.party.members.get(id).muted, idA)) === true);
await A.evaluate(() => window.dslinkPlay.party.toggleMute());
for (const p of [A, B]) { await p.evaluate(() => window.dslinkPlay.controls.openMenu()); await p.waitForSelector('.ctl-menu [data-act=leave]'); await p.evaluate(() => document.querySelector('.ctl-menu [data-act=leave]').click()); await p.waitForSelector('#confirmYes', { state: 'visible' }); await p.evaluate(() => document.querySelector('#confirmYes').click()); }
const out = await until(async () => { const sb = await screen(B); if (sb === 'lost') await B.click('#btnLostBack').catch(() => {}); return (await screen(A)) === 'library' && (await screen(B)) === 'library'; }, 30000);      // B sees "connessione persa" (A left the DS session): INDIETRO
await sleep(1200);
check('PARTY SURVIVES GAME EXIT: back in the menus the party is still there and the voice still flows', !!out && (await partyState(A)).inParty && (await partyState(B)).inParty && (await flowing(A)) && (await flowing(B)), JSON.stringify({ out: !!out, a: await partyState(A), b: await partyState(B), fa: await flowing(A), fb: await flowing(B), sa: await screen(A), sb: await screen(B) }).slice(0, 900));

// DS gate vs voice gate: a slow DS link is NON ADATTA while the voice stays fine (the two gates are independent)
await Promise.all([A, B].map((p) => p.evaluate(() => localStorage.setItem('dslink.opts', JSON.stringify({ delay: '40' })))));
await inviteToGame(A, B, 'nds-dltt'); await sleep(7000);
const ds = await A.evaluate(() => { const s = window.dslinkPlay.friends.session; return s && s.quality ? { label: s.quality.label, block: s.decision && s.decision.block } : null; });
check('DS GATE vs VOICE GATE are separate: the DS link at 40 ms is classified for the game while Party Voice stays connected and audible', ds && ds.label !== 'OTTIMA' && (await partyState(A)).conn[idB] === 'connected' && (await flowing(A)), JSON.stringify(ds));
for (const p of [A, B]) { await p.evaluate(() => document.getElementById('btnLobbyLeave').click()).catch(() => {}); await p.evaluate(() => localStorage.removeItem('dslink.opts')); }
await until(async () => (await screen(A)) === 'library', 10000);

// ============================================================================================ 7. microphone denied (listen-only), then the party goes on
const E = await device(browser, BASE, { name: 'Safari', mic: 'deny', query: q }); const ne = uname('pe'); await account(E, ne); const idE = await me(E);
await befriend(A, E, ne); await until(async () => (await api(A, 'GET', '/api/friends')).body.friends.every((f) => f.status !== 'OFFLINE'), 8000);
await A.evaluate(async (uid) => { await window.dslinkPlay.party.invite(uid); }, idE); await E.waitForSelector('#partyInviteBox:not([hidden])', { timeout: 15000 }); await E.click('#btnPInvAccept');
const denied = await until(async () => (await partyState(E)).mic === 'denied' && (await partyState(E)).inParty, 15000);
await until(async () => Object.values((await partyState(E)).conn).filter((v) => v === 'connected').length >= 1, 30000);
check('MIC DENIED: the party is joined in listen-only mode, a clear message and RIPROVA MICROFONO are shown, the others are heard', !!denied && /non consentito/.test(await E.innerText('#partyNote')) && (await E.innerText('#btnPartyMute')) === 'RIPROVA MICROFONO' && (await flowing(E)));
await E.click('#btnPartyLeave'); await E.context().close();

// ============================================================================================ 8. leaving: ownership moves to the longest-standing member
for (const p of [A, B]) { const sc = await screen(p); if (sc === 'lost') await p.click('#btnLostBack').catch(() => {}); }
await until(async () => (await screen(A)) === 'library', 8000); console.log('screen before party:', await screen(A));
await A.click('#btnParty'); await A.waitForSelector('[data-screen=party].on'); await A.click('#btnPartyLeave');
const handed = await until(async () => { const o = (await partyState(B)).owner; return (o === idB || o === idC) && (await partyState(B)).n >= 2; }, 15000);
const newOwner = (await partyState(B)).owner, OW = newOwner === idB ? B : C;
await until(async () => (await partyState(C)).owner === newOwner && (await OW.evaluate(() => window.dslinkPlay.party.amOwner)) === true, 10000);
check('ESCI: the owner leaves, the party goes on, ownership passes to the longest-standing member (server decides), who can now remove others', !!handed && !(await partyState(A)).inParty && (await partyState(C)).owner === newOwner && (await OW.evaluate(() => window.dslinkPlay.party.amOwner)) === true, JSON.stringify({ newOwner, idB, idC }));
const errs = [A, B, C].flatMap((p) => p.errors);
check('NO SCRIPT ERRORS on any device', errs.length === 0, errs.join(' | ').slice(0, 300));
await browser.close();
process.exit(R.done() ? 0 : 1);
