// Contract test of the PWA signaling API. Runs against any implementation: with no argument it starts the Node development server in-process (short TTL, to test expiry);
// with a base URL (e.g. the Worker started by wrangler dev) it tests that one. usage: node signal_contract.mjs [http://localhost:8787]
import http from 'node:http';
import { createSignalHandler, nodeAdapter } from '../signal/dev_server.mjs';

let base = process.argv[2], server = null, sig = null, shortTtl = false;
if (!base) {
  sig = createSignalHandler({ ttlMs: 2500, graceMs: 800 }); const ad = nodeAdapter(sig);
  server = http.createServer(async (rq, rs) => { if (!(await ad(rq, rs))) rs.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; shortTtl = true;
}
const results = []; const check = (n, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, b) => { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }); return { status: r.status, j: await r.json().catch(() => ({})) }; };
function sse(code, token) {   // minimal SSE client: collects events, can wait for one
  const ev = [], waiters = []; const ac = new AbortController();
  const run = (async () => {
    const r = await fetch(`${base}/signal/events?code=${code}&token=${token}`, { signal: ac.signal }); if (r.status !== 200) { ev.status = r.status; return; }
    const rd = r.body.getReader(), td = new TextDecoder(); let buf = '';
    try { for (;;) { const { value, done } = await rd.read(); if (done) break; buf += td.decode(value, { stream: true }); let i; while ((i = buf.indexOf('\n\n')) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const m = /event: (\w+)\ndata: (.*)/s.exec(blk); if (m) { const e = { event: m[1], data: JSON.parse(m[2]) }; ev.push(e); waiters.splice(0).forEach((w) => w()); } } } } catch { /* aborted */ }
    ev.ended = true; waiters.splice(0).forEach((w) => w());
  })();
  const wait = async (pred, ms = 3000) => { const end = Date.now() + ms; for (;;) { const f = ev.find(pred); if (f) return f; if (Date.now() > end) return null; await new Promise((r) => { waiters.push(r); setTimeout(r, 100); }); } };
  return { ev, wait, close: () => ac.abort(), run };
}

const c = await post('/signal/create');
check('create: a 6-digit code, a token and a TTL', c.status === 200 && /^\d{6}$/.test(c.j.code) && /^[0-9a-f]{32}$/.test(c.j.token) && c.j.ttlSec > 0, JSON.stringify({ code: c.j.code, ttl: c.j.ttlSec }));
const bad = await post('/signal/join', { code: '000000' });
check('join with a wrong code is refused (404, no room)', bad.status === 404 && bad.j.error === 'no_room');
const h = sse(c.j.code, c.j.token); const hello = await h.wait((e) => e.event === 'hello');
check('host event stream says hello with its role', hello && hello.data.role === 'host');
const j = await post('/signal/join', { code: c.j.code });
check('guest joins with the code', j.status === 200 && /^[0-9a-f]{32}$/.test(j.j.token));
check('a second guest is refused while the slot is taken (409 full)', (await post('/signal/join', { code: c.j.code })).status === 409);
const g = sse(c.j.code, j.j.token); await g.wait((e) => e.event === 'hello');
check('host is told the guest joined', !!(await h.wait((e) => e.event === 'peer' && e.data.state === 'joined')));
const offer = { k: 'offer', sdp: 'v=0 test-offer' }, answer = { k: 'answer', sdp: 'v=0 test-answer' }, ice = { k: 'ice', c: { candidate: 'candidate:1 1 udp 1 127.0.0.1 9 typ host' } };
await post('/signal/send', { code: c.j.code, token: c.j.token, data: offer });
const gotOffer = await g.wait((e) => e.event === 'msg' && e.data.data.k === 'offer');
check('offer is relayed host -> guest unchanged', gotOffer && gotOffer.data.data.sdp === offer.sdp);
await post('/signal/send', { code: c.j.code, token: j.j.token, data: answer }); await post('/signal/send', { code: c.j.code, token: j.j.token, data: ice });
check('answer and ICE are relayed guest -> host', !!(await h.wait((e) => e.event === 'msg' && e.data.data.k === 'answer')) && !!(await h.wait((e) => e.event === 'msg' && e.data.data.k === 'ice')));
check('unknown message kinds are refused (400)', (await post('/signal/send', { code: c.j.code, token: c.j.token, data: { k: 'rom', bytes: 'AAAA' } })).status === 400);
check('oversized messages are refused (400)', (await post('/signal/send', { code: c.j.code, token: c.j.token, data: { k: 'offer', sdp: 'x'.repeat(20000) } })).status === 400);
check('messages with a wrong token are refused (404)', (await post('/signal/send', { code: c.j.code, token: 'f'.repeat(32), data: offer })).status === 404);
check('the event stream refuses a wrong token', (await fetch(`${base}/signal/events?code=${c.j.code}&token=${'f'.repeat(32)}`)).status === 404);
await post('/signal/leave', { code: c.j.code, token: j.j.token }); g.close();
check('host is told the guest left', !!(await h.wait((e) => e.event === 'peer' && e.data.state === 'left')));
const j2 = await post('/signal/join', { code: c.j.code });
check('SHORT RECONNECT: the freed slot can be taken again with the same code', j2.status === 200 && j2.j.token !== j.j.token);
const g2 = sse(c.j.code, j2.j.token); await g2.wait((e) => e.event === 'hello');
await post('/signal/leave', { code: c.j.code, token: c.j.token });
check('host leaving closes the room: the guest is told', !!(await g2.wait((e) => e.event === 'closed')));
check('ROOM CLEANUP: a closed room cannot be joined again (404)', (await post('/signal/join', { code: c.j.code })).status === 404);
h.close(); g2.close();

// a guest that just disappears (page closed, no leave): the slot is freed after the grace period
const c2 = await post('/signal/create'); const h2 = sse(c2.j.code, c2.j.token); await h2.wait((e) => e.event === 'hello');
const j3 = await post('/signal/join', { code: c2.j.code }); const g3 = sse(c2.j.code, j3.j.token); await g3.wait((e) => e.event === 'hello');
await h2.wait((e) => e.event === 'peer' && e.data.state === 'joined');
const hb = setInterval(() => post('/signal/send', { code: c2.j.code, token: c2.j.token, data: { k: 'hello' } }), 8000);   // real clients heartbeat while their page lives
g3.close();
check('a guest whose page vanished is detected (peer left) after the grace period', !!(await h2.wait((e) => e.event === 'peer' && e.data.state === 'left', shortTtl ? 5000 : 40000)));
clearInterval(hb); h2.close();

// no content: the only things a room knows are the code, two tokens and relayed JSON of the whitelisted kinds
if (sig) check('rooms hold no payload: stats only count rooms', Object.keys(sig.stats).every((k) => typeof sig.stats[k] === 'number'));
// expiry
if (shortTtl) {
  const c3 = await post('/signal/create'); await sleep(3800);
  check('ROOM EXPIRY: an idle room disappears after its TTL', (await post('/signal/join', { code: c3.j.code })).status === 404 && sig.rooms.size <= 1, `rooms left ${sig.rooms.size}`);
  const c4 = await post('/signal/create'); const h4 = sse(c4.j.code, c4.j.token); await h4.wait((e) => e.event === 'hello');
  for (let i = 0; i < 40; i++) await post('/signal/join', { code: String(100000 + i) });
  check('brute-forcing codes is rate limited (429)', (await post('/signal/join', { code: '123456' })).status === 429);
  h4.close();
}
if (sig) sig.close(); if (server) server.close();
const ok = results.filter(Boolean).length; console.log(`${ok}/${results.length} checks passed`); process.exit(ok === results.length ? 0 : 1);
