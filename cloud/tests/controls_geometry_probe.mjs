// Records where every touch control of the player sits (pixel rectangles) for the DS and the PlayStation layout, portrait and landscape, so two builds can be compared:
//   node controls_geometry_probe.mjs <nds.nds> <out.json> [repo-root]      (repo-root defaults to this repository; point it at a checkout of the baseline to compare)
//   node controls_geometry_probe.mjs <nds.nds> --check                       measures the current tree and compares with baselines/controls_geometry.json (recorded from the approved UI, commit e9d1311 whose
//                                                                           controls are byte-identical to 75c6b3e); exits 1 and prints the controls that moved
// The approved DS touch UI (FASE 5, controls under cloud/worker/public/controls) must not move: scripts compare the JSON of the baseline commit with the current one.
import fs from 'node:fs';
import { staticServer, launch, openApp, buildDiscs, files, until, sleep, ROOT } from './ps1lib.mjs';
const args = process.argv.slice(2), CHECK = args[1] === '--check';
const [nds, out0, root = ROOT] = args; const out = CHECK ? '/tmp/controls_geometry_now.json' : out0;
if (!nds || !out) { console.error('usage: controls_geometry_probe.mjs <nds> <out.json> [repo-root]'); process.exit(2); }
const srv = await staticServer({ root }), browser = await launch(), discs = buildDiscs();
const result = {};
const rects = (p) => p.evaluate(() => { const stage = document.querySelector('.ctl-stage'); if (!stage) return null; const r0 = stage.getBoundingClientRect();
  const all = [...stage.querySelectorAll('.ctl-c, .ctl-clip')].map((e, i) => { const r = e.getBoundingClientRect(); return [(e.className || '').toString().replace(/\bis-\w+\b/g, '').trim() + '#' + i, Math.round(r.x - r0.x), Math.round(r.y - r0.y), Math.round(r.width), Math.round(r.height)]; });
  return { stage: [Math.round(r0.width), Math.round(r0.height)], controls: all }; });
for (const [name, vp] of [['portrait', { width: 390, height: 844 }], ['landscape', { width: 844, height: 390 }], ['tablet', { width: 820, height: 1180 }]]) {
  for (const sys of ['nds', 'ps1']) {
    const p = await openApp(browser, srv.base, '?nosw&welcome=0', vp);
    await p.setInputFiles('#romFile', sys === 'nds' ? [nds] : files(discs, 'Test Game.cue', 'Test Game.bin')); await until(async () => (await p.locator('#gameList li.game').count()) === 1, 20000);
    await p.evaluate(() => window.dslinkPlay.go && window.dslinkPlay.go('games')).catch(() => {});
    await p.click('li.game .play').catch(async () => { await p.evaluate(() => document.querySelector('li.game .play').click()); });
    if (sys === 'ps1') { await p.waitForSelector('#hleBox:not([hidden])', { timeout: 20000 }); await p.click('#btnHleGo'); }
    await p.waitForFunction(() => window.dslinkPlay.isPlaying(), null, { timeout: 40000 }); await sleep(1200);
    result[`${sys}-${name}`] = await rects(p); await p.close();
  }
}
fs.writeFileSync(out, JSON.stringify(result, null, 1)); await browser.close(); srv.close(); console.log('wrote', out, Object.keys(result).join(' '));
if (CHECK) {
  const base = JSON.parse(fs.readFileSync(new URL('./baselines/controls_geometry.json', import.meta.url), 'utf8')), moved = [];
  for (const k of Object.keys(base)) { const a = base[k], b = result[k]; if (!a || !b || JSON.stringify(a) !== JSON.stringify(b)) moved.push(k + (a && b ? ' (' + a.controls.filter((c, i) => JSON.stringify(c) !== JSON.stringify(b.controls[i])).map((c) => c[0]).join(', ') + ')' : ' missing')); }
  console.log(moved.length ? 'TOUCH GEOMETRY CHANGED: ' + moved.join('; ') : `TOUCH GEOMETRY UNCHANGED: ${Object.keys(base).length} layouts (DS and PlayStation; portrait, landscape, tablet) identical to the approved baseline`);
  process.exit(moved.length ? 1 : 0);
}
