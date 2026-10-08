// Internet multiplayer end to end (phase 7): Cloud rooms over HTTPS signaling, ICE direct / TURN relay, the pre-start quality gate and mode selection, ICE restart and network change.
// Real Chrome, a REAL Worker (wrangler dev --local) that serves the PWA and mints TURN credentials, and a REAL local TURN server (coturn, loopback) - see turn_local.sh. Homebrew ROMs only.
// "Internet" here is the loopback: it proves the mechanics (credentials, relay path, restart, gate) - NOT the speed of a real far connection. Nothing below claims a real Internet link.
// usage: node play_internet_e2e.mjs <worker-url> <rom.nds (homebrew)>      (needs: ./turn_local.sh start, and the Worker started with --var DSLINK_TURN_URLS / DSLINK_TURN_SECRET, see docs/INTERNET_VOICE.md)
import fs from 'node:fs';
import dgram from 'node:dgram';
import { execFileSync } from 'node:child_process';
import { launch, device, account, api, me, befriend, inviteToGame, until, sleep, uname, screen, reporter } from './netlib.mjs';

const [BASE, rom] = process.argv.slice(2);
const R = reporter(), check = R.check;
const crc16 = (b) => { let c = 0xffff; for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = c & 1 ? (c >>> 1) ^ 0xa001 : c >>> 1; } return c; };
const ampRom = '/tmp/dslink_ampt.nds';                                    // the homebrew ROM with a "Mario Party"-like product code (AMPT): its network profile is LOW_LATENCY_REQUIRED
{ const b = Buffer.from(fs.readFileSync(rom)); b.write('AMPT', 12, 'ascii'); const c = crc16(b.subarray(0, 0x15e)); b[0x15e] = c & 255; b[0x15f] = c >> 8; fs.writeFileSync(ampRom, b); }
const turn = (cmd) => execFileSync(new URL('./turn_local.sh', import.meta.url).pathname, [cmd], { stdio: 'pipe' }).toString().trim();

const browser = await launch();
const pair = async (q = '') => {
  const A = await device(browser, BASE, { name: 'Honor', rom, query: q }), B = await device(browser, BASE, { name: 'iPhone', rom, query: q }); const na = uname('ia'), nb = uname('ib');
  await account(A, na); await account(B, nb); await A.setInputFiles('#romFile', ampRom); await B.setInputFiles('#romFile', ampRom); await sleep(800);
  await befriend(A, B, nb); await until(async () => (await api(A, 'GET', '/api/friends')).body.friends.every((f) => f.status !== 'OFFLINE'), 10000);
  return { A, B, na, nb };
};
const sess = (p) => p.evaluate(() => { const s = window.dslinkPlay.friends.session; if (!s) return null; const m = s.peer ? s.peer.metrics() : null; return { state: s.state, peer: s.peer ? s.peer.state : null, q: s.quality ? { label: s.quality.label, level: s.quality.level, path: s.quality.path, profile: s.quality.profile } : null, d: s.decision, forced: s.forced, busy: s.qualityBusy, m: m && { path: m.path, sent: m.sent, recv: m.recv, restarts: m.restartsTotal, reconnects: m.reconnects, netChanges: m.netChanges, lastOutage: m.lastOutageMs, queue: m.queueDepth, rtt: m.rtt.avg } }; });
const measured = (p, ms = 30000) => until(async () => { const s = await sess(p); return s && s.q && !s.busy ? s : null; }, ms);
const leaveLobby = async (...ps) => { for (const p of ps) await p.click('#btnLobbyLeave').catch(() => {}); await until(async () => (await screen(ps[0])) === 'library', 8000); };

// ============================================================================================ 1. ICE configuration: server side, short-lived, nothing permanent in the app
const P1 = await pair();
const ice = await api(P1.A, 'GET', '/api/realtime/ice'); const j = ice.body, tn = (j.iceServers || []).find((s) => s.username);
check('ICE CONFIG from the Cloud (authenticated): STUN + TURN with a short-lived credential, expiry and policy metadata', ice.status === 200 && !!tn && j.policy.relayAvailable === true && j.policy.providers.includes('turn-secret') && j.expiresAt - Date.now() > 3000_000 && j.expiresAt - Date.now() <= 3_700_000 && /^\d+:[0-9a-f]{12}$/.test(tn.username), JSON.stringify({ ttl: j.ttlSeconds, policy: j.policy }));
check('NO PERMANENT TURN CREDENTIAL IN THE PWA: the TURN secret appears in no file the app serves, and an anonymous request gets none', await (async () => { const files = ['play.js', 'friends.js', 'net.js', 'voice.js', 'session.js', 'radio-peer.js', 'cloud.js', 'cloud-config.json', 'index.html'], bad = []; for (const f of files) { const t = await (await fetch(`${BASE}/play/${f}`)).text(); if (/dslink-local-turn-test-secret/.test(t)) bad.push(f); } return !bad.length && (await fetch(`${BASE}/api/realtime/ice`)).status === 401; })());
// STUN: the same server answers a STUN Binding Request (protocol-level proof of the local STUN used by the tests)
const stunOk = await new Promise((resolve) => { const s = dgram.createSocket('udp4'), tid = Buffer.from([1,2,3,4,5,6,7,8,9,10,11,12]), req = Buffer.concat([Buffer.from([0, 1, 0, 0, 0x21, 0x12, 0xa4, 0x42]), tid]); const to = setTimeout(() => { s.close(); resolve(false); }, 2000); s.on('message', (m) => { clearTimeout(to); s.close(); resolve(m[0] === 1 && m[1] === 1 && m.subarray(8, 20).equals(tid)); }); s.send(req, 3478, '127.0.0.1'); });
check('STUN: the STUN service answers a Binding Request with the mapped address (local coturn; a public STUN is the default when none is configured)', stunOk);
const anonIce = await P1.A.evaluate(async () => { const m = await import('./net.js'); return m.loadIce({ state: 'anon' }, () => ''); });
check('without an account / Cloud the PWA falls back to public STUN only and says no relay is available', anonIce.relayAvailable === false && anonIce.iceServers.every((s) => !s.username));

// ============================================================================================ 2. Internet room (Cloud signaling) -> ICE direct -> quality gate -> game, DS radio flows
const rd = await inviteToGame(P1.A, P1.B, 'nds-ampt');
check('INTERNET SIGNALING: friends\' invite -> accept -> room through the Cloud API over HTTP (no LAN assumption) -> lobby on both', rd.ok, rd.err || '');
const hq = await measured(P1.A);
check('ICE DIRECT: with a reachable path the connection is direct (no relay used)', hq && hq.q.path === 'direct' && hq.d.mode === 'DIRECT_DISTRIBUTED' && hq.m.path.local === undefined ? true : hq && hq.q.path === 'direct' && hq.d.mode === 'DIRECT_DISTRIBUTED', JSON.stringify(hq && { q: hq.q, mode: hq.d.mode }));
check('GAME NETWORK PROFILE: the game is classed from the data table (AMP* = LOW_LATENCY_REQUIRED), not hardcoded in the lobby logic', hq && hq.q.profile === 'LOW_LATENCY_REQUIRED');
check('GAME QUALITY GATE: on a fast direct link the class is OTTIMA / BUONA, the user is not asked anything, and START is allowed', hq && ['OTTIMA', 'BUONA'].includes(hq.q.label) && !hq.d.block && (await P1.A.innerText('#lobbyQuality')).startsWith('Connessione: '));
check('UI shows words, never numbers: "Connessione: OTTIMA" and "Diretta"', !/\d\s*ms/.test(await P1.A.innerText('#lobbyQuality')) && /Diretta/.test(await P1.A.innerText('#lobbyNet')));
await P1.B.click('#btnReady'); await until(async () => !(await P1.A.locator('#btnStart').isDisabled()), 20000); await P1.A.click('#btnStart');
const playing = await until(async () => (await P1.A.evaluate(() => window.dslinkPlay.isPlaying())) && (await P1.B.evaluate(() => window.dslinkPlay.isPlaying())), 60000);
await sleep(2500); const g1 = await sess(P1.A), g2 = await sess(P1.B); await sleep(1500); const g1b = await sess(P1.A), g2b = await sess(P1.B);
check('DS RADIO DIRECT: both consoles run and DS radio frames flow in both directions over the DataChannel', !!playing && g1b.m.recv > g1.m.recv && g2b.m.recv > g2.m.recv && g1b.m.recv > 10 && g2b.m.recv > 10, `host rx ${g1b.m.recv} guest rx ${g2b.m.recv} rtt ${g1b.m.rtt.toFixed(1)} ms`);

// ============================================================================================ 3. network change while playing: pause -> ICE restart -> resume (NORMAL-tolerance outage), then the clean end of a too-long gap
const before = { h: g1b.m.recv, g: g2b.m.recv };
await Promise.all([P1.A, P1.B].map((p) => p.evaluate(() => { dispatchEvent(new Event('offline')); setTimeout(() => dispatchEvent(new Event('online')), 600); })));
const re = await until(async () => { const a = await sess(P1.A), b = await sess(P1.B); return a && b && a.m.netChanges >= 1 && b.m.netChanges >= 1 && a.m.reconnects >= 1 && a.peer === 'open' && b.peer === 'open' && a.m.restarts >= 1 ? [a, b] : null; }, 40000);
check('NETWORK CHANGE: Wi-Fi<->mobile style event while playing -> pause, no radio backlog, ICE restart, the link comes back and the game session goes on', !!re && re[0].state === 'playing' && re[0].m.queue === 0, JSON.stringify(re && re.map((x) => x.m)));
const g1c = await sess(P1.A);
await sleep(2000); const g1d = await sess(P1.A);
check('ICE RESTART: the connection was re-negotiated (restart counted) and DS radio frames resume afterwards', g1c.m.restarts >= 1 && g1d.m.recv > g1c.m.recv && g1d.m.recv > before.h, `restarts ${g1c.m.restarts} reconnects ${g1c.m.reconnects} outage ${g1c.m.lastOutage.toFixed(0)} ms`);
const ended = await P1.A.evaluate(async () => { const s = window.dslinkPlay.friends.session; s.o.profileOf = () => 'LOW_LATENCY_REQUIRED'; s.hostGame = s.hostGame || { code: 'AMPT' }; await s.onRecovered(7000); return { state: s.state, why: s.why }; });
check('NETWORK CHANGE too long for a timing-sensitive game: the session ends cleanly with a clear message (no zombie game)', ended.state === 'lost' && /interrotta troppo a lungo/.test(ended.why), JSON.stringify(ended));
await sleep(1500);
for (const p of [P1.A, P1.B]) await p.context().close();

// ============================================================================================ 4. TURN relay (forced relay path = a NAT that blocks direct)
const P2 = await pair('&ice=relay');
await inviteToGame(P2.A, P2.B, 'nds-dltt');
const rq = await measured(P2.A);
check('TURN RELAY: with direct candidates unusable (relay-only policy) the connection comes up through the TURN server (UDP) - NAT fallback simulated', rq && rq.q.path === 'relay' && rq.d.mode === 'TURN_DISTRIBUTED' && rq.m.path.local === 'relay', JSON.stringify(rq && { q: rq.q, path: rq.m.path }));
check('MODE SELECTION: relay is chosen only because it is the path in use, and a fast relay is accepted (reachability != latency, the gate still decides)', rq && rq.d.mode === 'TURN_DISTRIBUTED' && typeof rq.d.block === 'boolean', JSON.stringify(rq && rq.d));
check('UI says "Tramite relay"', /Tramite relay/.test(await P2.A.innerText('#lobbyNet')));
await P2.B.click('#btnReady'); await until(async () => !(await P2.A.locator('#btnStart').isDisabled()), 20000); await P2.A.click('#btnStart');
const play2 = await until(async () => (await P2.A.evaluate(() => window.dslinkPlay.isPlaying())) && (await P2.B.evaluate(() => window.dslinkPlay.isPlaying())), 60000);
await sleep(2500); const r1 = await sess(P2.A), r2 = await sess(P2.B); await sleep(1500); const r1b = await sess(P2.A), r2b = await sess(P2.B);
check('DS RADIO RELAY: DS radio frames flow both ways through the relay', !!play2 && r1b.m.recv > r1.m.recv && r2b.m.recv > r2.m.recv && r1b.m.path.path === 'relay', `loopback relay RTT ${r1b.m.rtt.toFixed(1)} ms (real Internet latency NOT measured)`);
console.log(`DATA  loopback-relay rtt avg ${r1b.m.rtt.toFixed(2)} ms (one-way ~${(r1b.m.rtt / 2).toFixed(2)} ms): a real far relay is typically 10-100x this; the gate would classify it for the game's profile`);
for (const p of [P2.A, P2.B]) { await p.evaluate(() => window.dslinkPlay.controls.openMenu()); await p.click('.ctl-menu [data-act=leave]'); await p.click('#confirmYes'); }
await until(async () => (await screen(P2.A)) === 'library', 20000);

// ICE restart after the relay really dies (coturn killed, then back: allocations are gone, only a restart can recover)
await inviteToGame(P2.A, P2.B, 'nds-dltt'); await measured(P2.A);
const s0 = await sess(P2.A); turn('stop'); await sleep(9000);
const mid = await sess(P2.A); turn('start');
const healed = await until(async () => { const a = await sess(P2.A), b = await sess(P2.B); return a && b && a.peer === 'open' && b.peer === 'open' && a.m.restarts >= 1 && a.m.reconnects >= 1 ? [a, b] : null; }, 90000);
check('ICE RESTART after a real path loss: the relay dies and comes back - the connection degrades, restarts ICE (new allocation) and recovers by itself', !!healed, JSON.stringify({ before: s0.peer, during: mid.peer, after: healed && healed[0].m }));
const hb = await sess(P2.A); await sleep(2500); const hc = await sess(P2.A);
check('after the recovery the link carries probes again (alive, not just "connected")', hc.m.rtt > 0 && hc.peer === 'open');
await leaveLobby(P2.A, P2.B);
for (const p of [P2.A, P2.B]) await p.context().close();

// ============================================================================================ 5. quality classification matrix + mode selection UI (a timing-sensitive game, added one-way delay on both sides)
const P3 = await pair();
const setDelay = (ms) => Promise.all([P3.A, P3.B].map((p) => p.evaluate((d) => localStorage.setItem('dslink.opts', JSON.stringify({ delay: String(d) })), ms)));
const rows = [];
for (const ms of [0, 5, 8, 10, 20, 40]) {
  await setDelay(ms); await inviteToGame(P3.A, P3.B, 'nds-ampt'); const s = await measured(P3.A, 40000);
  await P3.B.click('#btnReady').catch(() => {}); await sleep(600);
  rows.push({ ms, label: s && s.q.label, block: s && s.d.block, warn: await P3.A.isVisible('#netWarn'), startDisabled: await P3.A.locator('#btnStart').isDisabled(), msg: (await P3.A.innerText('#netWarnText')).slice(0, 80) });
  await leaveLobby(P3.A, P3.B); await sleep(500);
}
console.log('MATRIX ' + rows.map((r) => `${r.ms}ms:${r.label}${r.warn ? '(ask)' : ''}`).join('  '));
const order = ['OTTIMA', 'BUONA', 'LIMITATA', 'NON ADATTA'], rk = rows.map((r) => order.indexOf(r.label));
check('NETWORK MATRIX 0/5/8/10/20/40 ms one-way: good -> starts, borderline -> asks, unsuitable -> classified NON ADATTA (the class never improves as the delay grows)', rk.every((v, i) => i === 0 || v >= rk[i - 1]) && rows[0].label === 'OTTIMA' && rows[5].label === 'NON ADATTA' && !rows[0].warn && !rows[1].warn && rows[3].warn !== undefined && rows[4].warn && rows[5].warn, JSON.stringify(rows.map((r) => [r.ms, r.label, r.warn])));
check('GAME QUALITY GATE: a slow link (20/40 ms) shows "Questa connessione potrebbe non essere abbastanza veloce per il multiplayer Nintendo DS." and START waits for the user\'s choice', rows[4].warn && rows[5].warn && /Questa connessione potrebbe non essere abbastanza veloce per il multiplayer Nintendo DS\./.test(rows[5].msg) && rows[5].startDisabled);
// the choices: RIPROVA after the link improved, CONTINUA COMUNQUE, USA MODALITA HOSTED (only when a host exists)
await setDelay(40); await inviteToGame(P3.A, P3.B, 'nds-ampt'); await measured(P3.A, 40000); await P3.B.click('#btnReady'); await P3.A.waitForSelector('#netWarn:not([hidden])');
check('USA MODALITÀ HOSTED is not offered on a pure PWA (no native host): the limit is shown, nothing is invented', !(await P3.A.isVisible('#btnNetHosted')) && (await P3.A.isVisible('#btnNetRetry')) && (await P3.A.isVisible('#btnNetGo')));
await setDelay(0); await P3.A.click('#btnNetRetry');
const better = await until(async () => { const s = await sess(P3.A); return s && !s.busy && s.q && s.q.label === 'OTTIMA' && !(await P3.A.isVisible('#netWarn')); }, 30000);
check('RIPROVA: after the link improved the measurement is repeated, the warning goes away and START is available', !!better && (await until(async () => !(await P3.A.locator('#btnStart').isDisabled()), 10000)));
await leaveLobby(P3.A, P3.B); await setDelay(40); await inviteToGame(P3.A, P3.B, 'nds-ampt'); await measured(P3.A, 40000); await P3.B.click('#btnReady'); await P3.A.waitForSelector('#netWarn:not([hidden])');
await P3.A.click('#btnNetGo');
check('CONTINUA COMUNQUE: the user accepts the risk - the warning closes and START is enabled', (await until(async () => !(await P3.A.locator('#btnStart').isDisabled()), 10000)) && !(await P3.A.isVisible('#netWarn')));
await leaveLobby(P3.A, P3.B);
await P3.A.addInitScript(() => { window.DSLINK_HOSTED = { available: true, start: (o) => { window.__hostedStarted = o; return true; } }; });
await P3.A.reload(); await P3.A.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library'); await until(async () => (await P3.A.evaluate(() => window.dslinkPlay.cloud.state)) === 'user', 10000);
await setDelay(40); await inviteToGame(P3.A, P3.B, 'nds-ampt'); await measured(P3.A, 40000); await P3.B.click('#btnReady'); await P3.A.waitForSelector('#netWarn:not([hidden])');
check('HOSTED FALLBACK: when a compatible Hosted host exists on the device, USA MODALITÀ HOSTED is offered and hands the room over to it (never mandatory)', (await P3.A.isVisible('#btnNetHosted')) && (await (async () => { await P3.A.click('#btnNetHosted'); return !!(await until(() => P3.A.evaluate(() => !!window.__hostedStarted), 5000)); })()));
const errs = [P1.A, P1.B, P2.A, P2.B, P3.A, P3.B].flatMap((p) => p.errors);
check('NO SCRIPT ERRORS on any device', errs.length === 0, errs.join(' | ').slice(0, 300));
await browser.close();
process.exit(R.done() ? 0 : 1);
