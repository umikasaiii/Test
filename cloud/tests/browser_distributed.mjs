// DISTRIBUTED MODE through the gateway + two real browsers. Two gateways stand in for two DEVICES (each runs ONE DSLink Runtime + melonDS and serves its own
// browser over loopback WebRTC); the only thing between them is the LAN RadioTransport (UDP). Verifies: one console per device, radio=LAN, game stream=none
// between devices, own video/audio per device, DS radio frames really cross, and that nothing but radio datagrams connects the two devices.
// usage: node browser_distributed.mjs <gatewayA-url> <gatewayB-url> <rom1.nds> <rom2.nds> [discovery-port]
import { chromium } from 'playwright';
import fs from 'node:fs';
const [A, B, rom1, rom2] = process.argv.slice(2, 6); const DISC = process.argv[6] || '47555';
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const u of [A, B]) await fetch(u + '/api/room', { method: 'DELETE' });
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--allow-loopback-in-peer-connection'] });
const form = (extra, rom) => { const fd = new FormData(); for (const [k, v] of Object.entries(extra)) fd.append(k, v); if (rom) fd.append('rom', new Blob([fs.readFileSync(rom)]), 'g.nds'); return fd; };
const post = async (u, fd) => { const r = await fetch(u + '/api/room', { method: 'POST', body: fd }); return { status: r.status, j: await r.json() }; };

// HOST device: "CREA PARTITA"
const h = await post(A, form({ mode: 'distributed', lan_role: 'host', lan_bind: '127.0.0.1', lan_discovery_port: DISC }, rom1));
check('host: room created in DISTRIBUTED mode, the runtime reports a 6-digit room code', h.status === 200 && /^\d{6}$/.test(h.j.lan_code || ''), `${h.status} code=${h.j.lan_code}`);
// GUEST device: "UNISCITI" with the code only (discovery finds the host)
const g = await post(B, form({ mode: 'distributed', lan_role: 'guest', lan_code: h.j.lan_code, lan_discovery_addr: '127.0.0.1', lan_discovery_port: DISC, lan_bind: '127.0.0.1' }, rom2));
check('guest: joined by code only (discovery + authenticated join), no address typed', g.status === 200, `${g.status} ${g.j.error || ''}`);
const mkPage = async (base, s) => { const p = await (await browser.newContext({ viewport: { width: 540, height: 1000 } })).newPage(); await p.goto(base); await p.evaluate((s) => window.__dslinkStart(s), s); return p; };
const pA = await mkPage(A, h.j), pB = await mkPage(B, g.j);
await Promise.all([pA, pB].map((p) => p.waitForFunction(() => window.dslink?.video?.videoWidth > 0, null, { timeout: 40000 })));
check('each device shows ITS OWN console through its own local WebRTC (video)', true);
await sleep(6000);
const dom = (p) => p.evaluate(() => { const v = window.dslink.video, c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; const x = c.getContext('2d'); x.drawImage(v, 0, 0); const d = x.getImageData(250, 250, 1, 1).data; return d[2] > d[0] + 40 ? 'blue' : d[0] > d[2] + 40 ? 'red' : 'other'; });
const [cA, cB] = [await dom(pA), await dom(pB)];
check('device A shows its own cartridge (blue), device B its own (red): two separate consoles', cA === 'blue' && cB === 'red', `${cA}/${cB}`);
const st = async (u) => (await (await fetch(u + '/api/status')).json()).room;
const sA = await st(A), sB = await st(B);
check('each gateway runs exactly ONE console (no second slot, no Unix-socket bridge)', sA.slots.length === 1 && sB.slots.length === 1 && sA.session_mode === 'distributed' && sB.session_mode === 'distributed');
const a = sA.slots[0], b = sB.slots[0];
check('radio transport LAN, game stream transport none between the devices', a.radio === 'lan' && b.radio === 'lan' && a.stream === 'none' && b.stream === 'none', `${a.radio}/${a.stream} ${b.radio}/${b.stream}`);
check('host sees one peer, guest is active', a.lan?.peers === 1 && b.mp_active === true, `peers=${a.lan?.peers}`);
check('DS radio frames crossed in both directions, authenticated, nothing malformed', a.lan.rx > 10 && b.lan.rx > 10 && a.lan.bad_auth === 0 && b.lan.bad_auth === 0 && a.lan.bad_format === 0, `host rx/tx ${a.lan.rx}/${a.lan.tx}  guest rx/tx ${b.lan.rx}/${b.lan.tx}`);
const pc = (p) => p.evaluate(async () => { const r = await window.dslink.pc.getStats(); const o = {}; r.forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'video') Object.assign(o, { fps: s.framesPerSecond, bytes: s.bytesReceived }); }); return o; });
const vA = await pc(pA), vB = await pc(pB);
check('each local screen runs at full rate', vA.fps >= 50 && vB.fps >= 50, `${vA.fps}/${vB.fps} fps`);
const t0 = Date.now(), lanA0 = a.lan.tx_bytes + a.lan.rx_bytes; await sleep(10000);
const a2 = (await st(A)).slots[0]; const kbps = Math.round(((a2.lan.tx_bytes + a2.lan.rx_bytes - lanA0) * 8) / ((Date.now() - t0) / 1000) / 1000);
console.log(`LAN radio traffic between the devices (test ROMs): ${kbps} kbps total, host RTT ${a2.lan.rtt_ms?.toFixed?.(1)} ms, jitter ${a2.lan.jitter_ms?.toFixed?.(2)} ms, lost ${a2.lan.lost}`);
check('only the radio crosses: a few hundred kbps at most (no video/audio stream between devices)', kbps < 800, `${kbps} kbps`);
await browser.close();
for (const u of [A, B]) await fetch(u + '/api/room', { method: 'DELETE' });
const bad = results.filter((x) => !x).length; console.log(`${results.length - bad}/${results.length} checks passed`); process.exit(bad ? 1 : 0);
