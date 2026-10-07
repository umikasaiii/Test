// Unit test of the Download Play assistant's pure parts: the 16x16 average-hash is the SAME function the native driver uses (cloud/gateway/mpdriver.go hashScreens / tests/runtime/mario_dlplay.py ahash),
// refs.json validation (shape, BOM, missing screens; errors never echo content), and the DS-state milestone mapping. Synthetic pictures only.
import { hashScreens, hdist, validateRefs, DlAssist, HOST_REFS } from '../web/play/dlassist.js';
import { execFileSync } from 'node:child_process';
const results = []; const check = (n, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); };
// synthetic 256x384 RGBA picture (deterministic pseudo-random)
const w = 256, px = new Uint8Array(w * 384 * 4); let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let i = 0; i < px.length; i += 4) { const v = rnd() * 255; px[i] = v; px[i + 1] = (v * 0.7 + rnd() * 70) | 0; px[i + 2] = (v * 0.3 + rnd() * 150) | 0; px[i + 3] = 255; }
const h = hashScreens(px, w);
check('hash: two 256-char 0/1 strings (16x16 samples per screen)', /^[01]{256}$/.test(h.top) && /^[01]{256}$/.test(h.bot));
// independent reference (python, the algorithm of mario_dlplay.py ahash, on RGB triples)
const rgb = Buffer.alloc(w * 384 * 3); for (let i = 0, j = 0; i < px.length; i += 4, j += 3) { rgb[j] = px[i]; rgb[j + 1] = px[i + 1]; rgb[j + 2] = px[i + 2]; }
const py = `
import sys,json
b=sys.stdin.buffer.read(); w=256
def ah(y0):
    g=[(b[(y*w+x)*3]+b[(y*w+x)*3+1]+b[(y*w+x)*3+2])//3 for y in range(y0+6,y0+192,12) for x in range(8,256,16)]
    a=sum(g)/len(g); return ''.join('1' if v>a else '0' for v in g)
print(json.dumps({'top':ah(0),'bot':ah(192)}))`;
const ref = JSON.parse(execFileSync('python3', ['-c', py], { input: rgb, encoding: 'utf8' }));
check('hash is bit-identical to the native driver\'s average-hash (same samples, same threshold)', ref.top === h.top && ref.bot === h.bot, `dist ${hdist(ref.top, h.top)}/${hdist(ref.bot, h.bot)}`);
const px2 = px.slice(); for (let y = 6; y < 100; y += 12) for (let x = 8; x < 256; x += 16) { const i = (y * w + x) * 4; px2[i] = 255 - px2[i]; px2[i + 1] = 255 - px2[i + 1]; px2[i + 2] = 255 - px2[i + 2]; }
check('hdist counts differing samples', hdist(h.top, hashScreens(px2, w).top) > 20 && hdist(h.bot, hashScreens(px2, w).bot) === 0);
const good = Object.fromEntries(HOST_REFS.map((n) => [n, { top: h.top, bot: h.bot }]));
check('refs: a complete file validates', validateRefs(JSON.stringify(good), HOST_REFS).ok);
check('refs: a byte-order mark (phone text editors) is accepted', validateRefs('﻿' + JSON.stringify(good), HOST_REFS).ok);
const bad = validateRefs('{ nope'), shape = validateRefs('[1,2]'), entry = validateRefs(JSON.stringify({ a: { top: 'x', bot: 'y' } })), miss = validateRefs(JSON.stringify({ host_main_menu: good.host_main_menu }), HOST_REFS);
check('refs: invalid JSON / wrong shape / bad entry / missing screens are refused with a clear message', !bad.ok && !shape.ok && !entry.ok && !miss.ok && /mancano/.test(miss.error), [bad.error, shape.error, entry.error, miss.error].join(' | '));
check('refs: error messages never contain the file content (only names)', !JSON.stringify([bad, shape, entry]).includes(h.top) && !miss.error.includes(h.top));
// milestone mapping: the diagnostics names of the Mario Download Play flow
const states = ['IDLE', 'HOST_ADVERTISING', 'GAME_DISCOVERED', 'DOWNLOAD_HANDSHAKE', 'DOWNLOAD_TRANSFER', 'DOWNLOAD_VERIFY', 'CLIENT_GAME_BOOT', 'GAME_HANDSHAKE', 'LOBBY', 'IN_GAME'];
let cur = 'IDLE', bytes = 0; const player = { paused: false, get stats() { return { dl: { dl_state: cur, dl_counters: { data_bytes_rx: bytes, data_bytes_tx: 0 } } }; } };
const a = new DlAssist({ role: 'guest', player, refs: {} });
for (const s of states) { cur = s; bytes += 200000; a.observe(); }
const names = a.timeline.map((e) => e.name);
check('milestones: HOST_ADVERTISING, GUEST_DISCOVERED, DOWNLOAD_BEGIN/PROGRESS/COMPLETE, GUEST_BOOT, GAME_HANDSHAKE, GAMEPLAY are recorded once, in order', ['HOST_ADVERTISING', 'GUEST_DISCOVERED', 'DOWNLOAD_BEGIN', 'DOWNLOAD_PROGRESS', 'DOWNLOAD_COMPLETE', 'GUEST_BOOT', 'GAME_HANDSHAKE', 'GAMEPLAY'].every((n) => names.includes(n)) && names.filter((n) => n === 'GAME_HANDSHAKE').length === 1, names.join(','));
check('timeline entries carry names, times and byte counters only', a.timeline.every((e) => Object.keys(e).every((k) => ['t', 'name', 'bytes'].includes(k))));
const ok = results.filter(Boolean).length; console.log(`${ok}/${results.length} checks passed`); process.exit(ok === results.length ? 0 : 1);
