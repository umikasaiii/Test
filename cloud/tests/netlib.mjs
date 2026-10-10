// Shared helpers of the Internet / Party browser tests (real Chrome, fake microphone, a real Worker serving the PWA).
import { chromium } from 'playwright';
import fs from 'node:fs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const until = async (f, ms = 20000, step = 120) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await f(); if (v) return v; } catch { /* retry */ } await sleep(step); } return false; };
export const uname = (p) => (p + Math.random().toString(36).slice(2, 8)).slice(0, 18);
export const PASSWORD = 'correct horse battery staple';
export function reporter() {
  const results = [];
  return { results, check(name, ok, detail = '') { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); },
    done() { const ok = results.filter(Boolean).length; console.log(`${ok}/${results.length} checks passed`); return ok === results.length; } };
}
/** Chrome with a FAKE microphone (a beep generator) that is allowed without a prompt; a device can still be made to refuse (mic:'deny') */
// the fake microphone plays a continuous 440 Hz tone (a WAV made here, 48 kHz mono, loops): "somebody is speaking" is then a stable, testable condition
const TONE = '/tmp/dslink_tone.wav';
function makeTone() {
  if (fs.existsSync(TONE)) return; const rate = 48000, n = rate * 4, buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000), 44 + i * 2);
  fs.writeFileSync(TONE, buf);
}
export const launch = () => { makeTone(); return chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${TONE}`, '--disable-features=WebRtcHideLocalIpsWithMdns'] }); };

export async function device(browser, base, { name = 'dev', query = '', rom = null, mic = 'ok', sw = false } = {}) {
  const ctx = await browser.newContext({ bypassCSP: process.env.DSLINK_TEST_CSP !== '1', viewport: { width: 390, height: 844 }, hasTouch: true, permissions: mic === 'deny' ? [] : ['microphone'] });
  const p = await ctx.newPage(); p.devName = name; p.errors = []; p.on('pageerror', (e) => p.errors.push(String(e))); p.on('dialog', (d) => d.accept()); p.on('console', (m) => { if (/Refused to|Content Security Policy/i.test(m.text())) p.errors.push('CSP: ' + m.text().slice(0, 140)); });   // with DSLINK_TEST_CSP=1 the page runs under the real CSP and a violation fails the run
  await p.addInitScript((deny) => {
    window.__gum = 0; const md = navigator.mediaDevices; if (!md) return; const orig = md.getUserMedia.bind(md);
    md.getUserMedia = (c) => { window.__gum++; if (deny) return Promise.reject(new DOMException('Permission denied', 'NotAllowedError')); return orig(c); };
  }, mic === 'deny');
  await p.goto(`${base}/play/?stun=1${sw ? '' : '&nosw'}&devname=${name}${query}`);
  await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library', null, { timeout: 25000 });
  if (rom) { await p.setInputFiles('#romFile', rom); await until(() => p.locator('#gameList li.game').count()); }
  return p;
}
export const screen = (p) => p.evaluate(() => document.body.dataset.screen);
export async function account(p, name, how = 'signup') {
  await p.click('#btnAccount'); await p.waitForSelector('[data-screen=account].on'); await p.fill('#authUser', name);
  await p.locator('details.diag summary', { hasText: 'password' }).click(); await p.fill('#authPass', PASSWORD); await p.click(how === 'signup' ? '#btnPwCreate' : '#btnPwLogin');
  const ok = await until(async () => (await screen(p)) === 'profile', 15000); await p.click('#btnProfBack'); return ok;
}
export const api = (p, method, url, body) => p.evaluate(async ([m, u, b]) => { const r = await fetch(u, { method: m, credentials: 'include', headers: b ? { 'content-type': 'application/json' } : undefined, body: b ? JSON.stringify(b) : undefined }); let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j }; }, [method, url, body]);
export const me = (p) => p.evaluate(() => window.dslinkPlay.cloud.user.userId);
export async function befriend(pa, pb, nameB) {
  await api(pa, 'POST', '/api/friends/requests', { username: nameB });
  const rq = await until(async () => { const r = await api(pb, 'GET', '/api/friends/requests'); return r.body && r.body.incoming[0]; }, 8000);
  await api(pb, 'POST', `/api/friends/requests/${rq.id}/accept`);
  await p_wait_friends(pa);
}
const p_wait_friends = (p) => p.evaluate(async () => { await window.dslinkPlay.cloud.loadFriends(); });
/** a game room through the Cloud invite flow (Phase 5): host invites, guest accepts, both land in the lobby */
export async function inviteToGame(host, guest, gameId) {
  const gid = await me(guest);
  await host.evaluate(async () => { await window.dslinkPlay.cloud.loadFriends(); });
  const r = await host.evaluate(async ([uid, g]) => { const x = await window.dslinkPlay.cloud.invite(uid, g); return { ok: x.ok, err: x.error, body: x.body }; }, [gid, gameId]);
  if (!r.ok) return { ok: false, err: r.err };
  await host.evaluate((o) => window.dslinkPlay.friends.startInvite(o), { role: 'host', code: r.body.room.code, token: r.body.room.token, gameId, inviteId: r.body.id });
  await guest.waitForSelector('#inviteBox:not([hidden])', { timeout: 15000 }); await guest.click('#btnInvAccept');
  const lobby = await until(async () => (await screen(host)) === 'lobby' && (await screen(guest)) === 'lobby', 20000);
  return { ok: !!lobby };
}
/** raw audio bytes received from every party peer (to prove voice really flows) */
export const rxBytes = (p) => p.evaluate(async () => { const o = {}; const pv = window.dslinkPlay.party; if (!pv.mesh) return o; for (const [uid, peer] of pv.mesh.peers) { let b = 0; try { (await peer.pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') b += s.bytesReceived || 0; }); } catch { /* closed */ } o[uid] = b; } return o; });
export async function flowing(p, ms = 1800) { const a = await rxBytes(p); await sleep(ms); const b = await rxBytes(p); const ids = Object.keys(b); return ids.length > 0 && ids.every((k) => b[k] > (a[k] || 0)); }
export const partyState = (p) => p.evaluate(() => { const v = window.dslinkPlay.party; return { inParty: v.inParty, n: v.members.size, owner: v.party && v.party.owner, mic: v.micState, muted: v.muted, partyAudio: v.partyAudio, state: v.state, conn: Object.fromEntries([...v.members].map(([k, m]) => [k, m.conn])), muted_by: Object.fromEntries([...v.members].map(([k, m]) => [k, m.muted])), speaking: Object.fromEntries([...v.members].map(([k, m]) => [k, m.speaking])), signalReconnects: v.counters.signalReconnects }; });
