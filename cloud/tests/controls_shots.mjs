// Renders the four approved layouts with the real components and saves PNGs (for visual approval) + a contact sheet.
// usage: node controls_shots.mjs <base-url> <out-dir>
import { chromium } from 'playwright';
import fs from 'node:fs';
const base = process.argv[2] || 'http://localhost:8787', out = process.argv[3] || '/tmp/ctl';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox'] });
const shots = [['nds', 'portrait', 390, 844], ['nds', 'landscape', 844, 390], ['ps1', 'portrait', 390, 844], ['ps1', 'landscape', 844, 390]];
for (const [p, o, w, h] of shots) {
  const page = await (await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, hasTouch: true })).newPage();
  await page.goto(`${base}/controls-preview.html?p=${p}`); await page.waitForSelector('.ctl-c');
  await page.screenshot({ path: `${out}/${p}_${o}.png` });
}
const page = await (await browser.newContext({ viewport: { width: 1800, height: 1500 }, deviceScaleFactor: 1 })).newPage();
await page.goto(`${base}/controls-preview.html`); await page.waitForSelector('.ctl-c');
await page.screenshot({ path: `${out}/sheet.png`, fullPage: true });
await browser.close(); console.log('written to', out);
