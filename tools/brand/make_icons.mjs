// Renders tools/brand/*.svg to the PWA icon set with the headless Chromium that Playwright provides.
// usage: node tools/brand/make_icons.mjs   (run from the repo root; needs cloud/tests/node_modules and CHROME=<chromium> when Playwright's own build is missing)
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(new URL('../../cloud/tests/package.json', import.meta.url));
const { chromium } = require('playwright');
const root = new URL('../..', import.meta.url).pathname, out = path.join(root, 'cloud/web/play/icons');
const mark = fs.readFileSync(path.join(root, 'tools/brand/mark.svg'), 'utf8'), mask = fs.readFileSync(path.join(root, 'tools/brand/mark-maskable.svg'), 'utf8');
const jobs = [['icon-192.png', mark, 192], ['icon-512.png', mark, 512], ['icon-maskable-512.png', mask, 512], ['apple-touch-icon.png', mask, 180], ['favicon-32.png', mark, 32]];
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, args: ['--no-sandbox'] });
for (const [name, svg, size] of jobs) {
  const p = await browser.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await p.screenshot({ path: path.join(out, name), omitBackground: true }); await p.close();
}
await browser.close();
fs.copyFileSync(path.join(root, 'tools/brand/mark.svg'), path.join(out, 'logo.svg'));
console.log('icons written to', out);
