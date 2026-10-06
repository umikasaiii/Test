// Builds docs/img/multiplayer-flow.png (+ the individual docs/img/mp-*.png) from the screenshots written by mp_ux_e2e.mjs. Homebrew test content only.
// usage: node mp_flow_sheet.mjs <shots-dir> <out-dir>
import { chromium } from 'playwright';
import fs from 'node:fs';
const [dir = '/tmp/mpshots', out = '../../docs/img'] = process.argv.slice(2);
const steps = [['01-home', '1 · Multiplayer'], ['02-create', '2 · Crea partita'], ['03-lobby-host', '3 · Lobby host (codice + QR)'], ['04b-join-code', '4 · Unisciti'], ['04-join-nearby', '5 · Partite vicine'],
  ['05-network-check', '6 · Controllo rete'], ['08-starting', '7 · Avvio / Download Play'], ['12-connection-lost', '8 · Connessione persa']];
const names = { '01-home': 'mp-1-home', '02-create': 'mp-2-create', '03-lobby-host': 'mp-3-lobby-host', '04b-join-code': 'mp-4-join', '04-join-nearby': 'mp-5-nearby', '05-network-check': 'mp-6-network-check', '08-starting': 'mp-7-starting', '12-connection-lost': 'mp-8-connection-lost', '07-lobby-ready': 'mp-lobby-ready', '14-lobby-hosted-note': 'mp-lobby-hosted-note', '10-ingame-landscape': 'mp-ingame-landscape' };
fs.mkdirSync(out, { recursive: true });
for (const [k, v] of Object.entries(names)) if (fs.existsSync(`${dir}/${k}.png`)) fs.copyFileSync(`${dir}/${k}.png`, `${out}/${v}.png`);
const img = (k) => `data:image/png;base64,${fs.readFileSync(`${dir}/${k}.png`).toString('base64')}`;
const html = `<body style="margin:0;background:#050912;font:600 22px system-ui;color:#cfe3ff"><div style="display:grid;grid-template-columns:repeat(4,1fr);gap:26px 18px;padding:26px 26px 30px;width:1500px">${steps.map(([k, l], i) => `<figure style="margin:0;text-align:center"><div style="border-radius:34px;padding:9px;background:#02050b;box-shadow:0 0 0 2px #1d2c4d,0 0 26px rgba(60,130,255,.25);display:inline-block"><img src="${img(k)}" style="width:300px;display:block;border-radius:26px"></div><figcaption style="margin-top:10px;letter-spacing:.04em">${l}</figcaption></figure>`).join('')}</div></body>`;
const b = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox'] });
const p = await b.newPage({ viewport: { width: 1550, height: 1000 } }); await p.setContent(html); await p.waitForTimeout(400);
await p.screenshot({ path: `${out}/multiplayer-flow.png`, fullPage: true }); await b.close(); console.log('written', out);
