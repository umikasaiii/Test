// Library against the REAL deployed Worker + REAL R2 (run by .github/workflows/deploy.yml, or by hand against any public URL).
// Synthetic content only (a generated NDS header; no commercial ROM/BIOS). usage: node r2_real.mjs <base-url> [rom.nds]
import fs from 'node:fs';
const base = (process.argv[2] || '').replace(/\/$/, '');
if (!base) { console.error('usage: node r2_real.mjs <base-url>'); process.exit(2); }
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const b64url = (u8) => Buffer.from(u8).toString('base64url');
const crc16 = (b) => { let c = 0xffff; for (const x of b) { c ^= x; for (let i = 0; i < 8; i++) c = c & 1 ? (c >> 1) ^ 0xa001 : c >> 1; } return c; };
const makeNds = (title, size) => { const b = new Uint8Array(size).fill(0x5a); b.fill(0, 0, 0x200); for (let i = 0; i < title.length; i++) b[i] = title.charCodeAt(i); b[0x15c] = 0x56; b[0x15d] = 0xcf; const c = crc16(b.subarray(0, 0x15e)); b[0x15e] = c & 255; b[0x15f] = c >> 8; return b; };
const api = async (method, path, { token, body, raw, headers = {} } = {}) => {
  const h = { origin: base, ...headers }; if (token) h.authorization = `Bearer ${token}`;
  let b = raw; if (body !== undefined) { b = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const t0 = Date.now(); const r = await fetch(path.startsWith('http') ? path : base + path, { method, headers: h, body: b });
  const text = await r.text(); let j = text; try { j = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: j, ms: Date.now() - t0, bytes: text.length };
};
const uniq = () => 'r' + Math.random().toString(36).slice(2, 10);
const acct = async () => { const u = uniq(); const r = await api('POST', '/api/auth/register', { body: { username: u, displayName: u, password: 'correct horse battery staple' } }); if (r.status !== 201) throw new Error('register ' + r.status + ' ' + JSON.stringify(r.body)); return { token: r.body.token, id: r.body.user.userId }; };

const A = await acct(), B = await acct();
check('two accounts registered on the public URL', !!A.token && !!B.token && A.id !== B.id);

// ---- upload a game for A (presigned direct-to-R2 when configured, otherwise proxied through the Worker)
const rom = makeNds('R2REALTEST', 200_000);
const c = await api('POST', '/api/library/games', { token: A.token, body: { files: [{ name: 'real.nds', size: rom.length, header: b64url(rom.slice(0, 1024)) }] } });
check('create game -> upload slot', c.status === 201 && c.body.uploads?.length === 1, `HTTP ${c.status}`);
const up = c.body.uploads[0];
const direct = /^https:\/\/[^/]*r2\.cloudflarestorage\.com\//.test(up.url);
check(`upload route: ${direct ? 'PRESIGNED PUT straight to real R2' : 'proxied through the Worker (R2 S3 secrets not configured)'}`, true);
const put = direct ? await api('PUT', up.url, { raw: rom, headers: { origin: undefined, 'content-length': String(rom.length) } }) : await api('PUT', up.url, { token: A.token, raw: rom, headers: { 'content-length': String(rom.length) } });
check('bytes accepted by R2', put.status === 200, `HTTP ${put.status} in ${put.ms} ms`);
const done = await api('POST', `/api/library/games/${c.body.gameId}/complete`, { token: A.token });
check('completion validates the NDS header read back from R2', done.status === 200 && done.body.platform === 'nds' && done.body.title === 'R2REALTEST', JSON.stringify(done.body));
const list = (await api('GET', '/api/library', { token: A.token })).body.games;
check('A sees the game', list.length === 1 && list[0].size === rom.length);

// ---- a forged / lying upload is refused and leaves nothing behind
const junk = new Uint8Array(4096).fill(9);
const c2 = await api('POST', '/api/library/games', { token: A.token, body: { files: [{ name: 'bad.nds', size: junk.length, header: b64url(rom.slice(0, 1024)) }] } });
const up2 = c2.body.uploads?.[0];
if (up2) {
  const direct2 = /^https:\/\//.test(up2.url);
  await (direct2 ? api('PUT', up2.url, { raw: junk, headers: { 'content-length': String(junk.length) } }) : api('PUT', up2.url, { token: A.token, raw: junk, headers: { 'content-length': String(junk.length) } }));
  const d2 = await api('POST', `/api/library/games/${c2.body.gameId}/complete`, { token: A.token });
  check('header/body mismatch is rejected (422) and discarded', d2.status === 422, `HTTP ${d2.status} ${d2.body?.error}`);
}

// ---- cross-account isolation
const gid = c.body.gameId;
check('B cannot see A\'s game', (await api('GET', '/api/library', { token: B.token })).body.games.length === 0);
check('B cannot rename A\'s game', (await api('PATCH', `/api/library/games/${gid}`, { token: B.token, body: { title: 'x' } })).status === 404);
check('B cannot read/write A\'s save', (await api('GET', `/api/library/games/${gid}/save/sram`, { token: B.token })).status === 404 && (await api('PUT', `/api/library/games/${gid}/save/sram`, { token: B.token, raw: new Uint8Array(8), headers: { 'content-length': '8' } })).status === 404);
check('B cannot delete A\'s game', (await api('DELETE', `/api/library/games/${gid}`, { token: B.token })).status === 404);
check('B cannot upload into A\'s slot', (await api('PUT', up.url.startsWith('http') ? `/api/library/games/${gid}/files/x` : up.url, { token: B.token, raw: rom, headers: { 'content-length': String(rom.length) } })).status >= 400);
check('unauthenticated requests are refused', (await api('GET', '/api/library')).status === 401);

// ---- saves (A)
const sram = new Uint8Array(8192).map((_, i) => i & 255);
const sp = await api('PUT', `/api/library/games/${gid}/save/sram`, { token: A.token, raw: sram, headers: { 'content-length': String(sram.length) } });
const sg = await fetch(`${base}/api/library/games/${gid}/save/sram`, { headers: { authorization: `Bearer ${A.token}` } });
const back = new Uint8Array(await sg.arrayBuffer());
check('save round-trip through real R2', sp.status === 200 && back.length === sram.length && back.every((v, i) => v === sram[i]), `HTTP ${sp.status}/${sg.status}`);

// ---- system files (synthetic bytes, right sizes)
const bios = new Uint8Array(4096).fill(1);
const sf = await api('PUT', '/api/library/system/nds/bios9.bin', { token: A.token, raw: bios, headers: { 'content-length': String(bios.length) } });
check('system file stored per user', sf.status === 200, `HTTP ${sf.status}`);
const sB = await api('GET', '/api/library/system', { token: B.token });
check('B has no system files of A', JSON.stringify(sB.body).indexOf('bios9') < 0 || (sB.body.files ?? sB.body.nds ?? []).length === 0, JSON.stringify(sB.body).slice(0, 80));

// ---- delete removes the bytes
check('A deletes the game', (await api('DELETE', `/api/library/games/${gid}`, { token: A.token })).status === 200);
check('game and save are gone', (await api('GET', '/api/library', { token: A.token })).body.games.length === 0 && (await api('GET', `/api/library/games/${gid}/save/sram`, { token: A.token })).status === 404);

const bad = results.filter((x) => !x).length;
console.log(`${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
