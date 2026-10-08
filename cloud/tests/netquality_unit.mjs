// Unit test of the Internet link classification, the mode decision, the game network profile table and the voice Opus tuning (pure functions, no browser).
// usage: node netquality_unit.mjs
import fs from 'node:fs';
import { classify, chooseMode, outageLimit, profileFor, OUTAGE_LIMIT_MS } from '../web/play/netquality.js';
import { tuneOpus } from '../web/play/voice.js';

const results = []; const check = (n, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); };
const pre = (oneWay, jitter = 0.5, loss = 0, spike = 0) => ({ received: 60, rttAvg: oneWay * 2, rttP95: (oneWay + spike) * 2, jitter, lossPct: loss });
const table = JSON.parse(fs.readFileSync(new URL('../web/play/netprofiles.json', import.meta.url), 'utf8'));

// the lobby decision for a timing-sensitive game over the one-way latencies of the matrix (0/5/8/10/20/40 ms): good link -> start, borderline -> warn, unsuitable -> classified, never silent
const lat = [0, 5, 8, 10, 20, 40], strict = lat.map((ms) => classify(pre(ms, ms * 0.1), 'LOW_LATENCY_REQUIRED').label);
check('LOW_LATENCY_REQUIRED classification over 0/5/8/10/20/40 ms one-way', JSON.stringify(strict) === JSON.stringify(['OTTIMA', 'BUONA', 'BUONA', 'LIMITATA', 'NON ADATTA', 'NON ADATTA']), strict.join(' | '));
const dec = lat.map((ms) => { const q = classify(pre(ms, ms * 0.1), 'LOW_LATENCY_REQUIRED'); const d = chooseMode({ path: 'srflx', quality: q, profile: 'LOW_LATENCY_REQUIRED' }); return d.block ? 'ASK' : d.warn ? 'WARN' : 'GO'; });
check('decision: good link starts, borderline asks (a timing-sensitive game never starts silently), unsuitable asks', JSON.stringify(dec) === JSON.stringify(['GO', 'GO', 'GO', 'ASK', 'ASK', 'ASK']), dec.join(' '));
const normal = lat.map((ms) => classify(pre(ms, ms * 0.1), 'NORMAL').label);
check('a tolerant (NORMAL) game accepts what a LOW_LATENCY_REQUIRED one refuses', JSON.stringify(normal) === JSON.stringify(['OTTIMA', 'OTTIMA', 'OTTIMA', 'OTTIMA', 'BUONA', 'NON ADATTA']), normal.join(' | '));
const unk = lat.map((ms) => classify(pre(ms, ms * 0.1), 'UNKNOWN').label);
const rk = (l) => ['OTTIMA', 'BUONA', 'LIMITATA', 'NON ADATTA'].indexOf(l);
check('UNKNOWN sits in between (prudent): never stricter than LOW_LATENCY_REQUIRED, never more tolerant than NORMAL', unk.every((l, i) => rk(strict[i]) >= rk(l) && rk(l) >= rk(normal[i])) && unk.some((l, i) => rk(strict[i]) > rk(l)) && unk.some((l, i) => rk(l) > rk(normal[i])), unk.join(' | '));
check('jitter, loss and latency spikes degrade the class even with a low average', classify(pre(2, 9, 0), 'LOW_LATENCY_REQUIRED').level === 'RED' && classify(pre(2, 0.5, 5), 'LOW_LATENCY_REQUIRED').level === 'RED' && classify(pre(2, 0.5, 0, 14), 'LOW_LATENCY_REQUIRED').level !== 'GREEN' && classify(pre(2, 0.5, 0.5), 'NORMAL').level === 'YELLOW');
check('no reply = NON ADATTA', classify({ received: 0 }, 'NORMAL').label === 'NON ADATTA' && classify(null).level === 'RED');
const rel = chooseMode({ path: 'relay', quality: classify(pre(3), 'LOW_LATENCY_REQUIRED'), profile: 'LOW_LATENCY_REQUIRED' });
const dir = chooseMode({ path: 'direct', quality: classify(pre(3), 'LOW_LATENCY_REQUIRED'), profile: 'LOW_LATENCY_REQUIRED' });
check('mode: relay only when the path really is a relay (TURN_DISTRIBUTED), direct otherwise; a fast relay is allowed, not forbidden', rel.mode === 'TURN_DISTRIBUTED' && !rel.block && dir.mode === 'DIRECT_DISTRIBUTED' && !dir.block);
const slowRelay = chooseMode({ path: 'relay', quality: classify(pre(30), 'LOW_LATENCY_REQUIRED'), profile: 'LOW_LATENCY_REQUIRED', hostedAvailable: true });
check('slow link: the user is asked with the exact message and RIPROVA / CONTINUA COMUNQUE (+ HOSTED only when a Hosted host exists)', slowRelay.block && slowRelay.message === 'Questa connessione potrebbe non essere abbastanza veloce per il multiplayer Nintendo DS.' && JSON.stringify(slowRelay.actions) === '["RETRY","CONTINUE","HOSTED"]' && !chooseMode({ path: 'relay', quality: classify(pre(30), 'NORMAL'), profile: 'NORMAL' }).actions.includes('HOSTED'));
check('network profile comes from the data table, not from code: Mario Party DS = LOW_LATENCY_REQUIRED, the homebrew test ROM = NORMAL, unknown = UNKNOWN, Download Play capable = strict',
  profileFor(table, { code: 'AMPE' }) === 'LOW_LATENCY_REQUIRED' && profileFor(table, { code: 'AMPP' }) === 'LOW_LATENCY_REQUIRED' && profileFor(table, { code: 'DLTT' }) === 'NORMAL' && profileFor(table, { code: 'ZZZZ' }) === 'UNKNOWN' && profileFor(table, { code: 'ZZZZ', dlplay: true }) === 'LOW_LATENCY_REQUIRED' && profileFor(table, { code: 'AMPE', networkProfile: 'NORMAL' }) === 'NORMAL' && profileFor(null, null) === 'UNKNOWN');
check('radio outage limits per profile (a network change longer than this ends the session cleanly)', outageLimit('LOW_LATENCY_REQUIRED') < outageLimit('UNKNOWN') && outageLimit('UNKNOWN') < outageLimit('NORMAL') && outageLimit('x') === OUTAGE_LIMIT_MS.UNKNOWN);
const sdp = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10;useinbandfec=0;foo=bar\r\na=rtpmap:63 red/48000/2\r\n';
const t = tuneOpus(sdp), line = /a=fmtp:111 ([^\r\n]*)/.exec(t)[1];
check('Opus tuned for speech: FEC on, DTX on, mono, 24 kbit/s, 20 ms - and unknown parameters are kept', /useinbandfec=1/.test(line) && /usedtx=1/.test(line) && /stereo=0/.test(line) && /maxaveragebitrate=24000/.test(line) && /minptime=20/.test(line) && /foo=bar/.test(line) && !/useinbandfec=0/.test(line));
const bare = tuneOpus('m=audio 9 RTP/SAVPF 109\r\na=rtpmap:109 opus/48000/2\r\n');
check('Opus tuning adds the fmtp line when the SDP has none, and leaves an SDP without Opus untouched', /a=fmtp:109 .*usedtx=1/.test(bare) && tuneOpus('m=audio 9 RTP/SAVPF 0\r\na=rtpmap:0 PCMU/8000\r\n') === 'm=audio 9 RTP/SAVPF 0\r\na=rtpmap:0 PCMU/8000\r\n');
const ok = results.filter(Boolean).length; console.log(`${ok}/${results.length} checks passed`); process.exit(ok === results.length ? 0 : 1);
