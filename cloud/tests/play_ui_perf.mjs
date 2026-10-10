// UI performance probe: First Contentful Paint, Largest Contentful Paint, layout shift (CLS), main-thread long tasks at start-up, interaction latency (Event Timing) of tab navigation, and - the one that
// matters most - what the interface costs the emulation: frame time, fps, main-thread stalls and long tasks while a DS game and a PlayStation game run for 8 s. Run it on two trees to compare:
//   node play_ui_perf.mjs <nds.nds> <out.json> [repo-root]     (repo-root defaults to this repository; a checkout of an older commit gives the "before" numbers)
// Numbers are for the machine that ran them (desktop Chromium, software rendering): they are a relative comparison, NOT a statement about a phone.
import fs from 'node:fs';
import { staticServer, launch, buildDiscs, files, until, sleep, ROOT } from './ps1lib.mjs';
const [nds, out, root = ROOT] = process.argv.slice(2);
if (!nds || !out) { console.error('usage: play_ui_perf.mjs <nds> <out.json> [repo-root]'); process.exit(2); }
const srv = await staticServer({ root }), browser = await launch(), discs = buildDiscs();
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const result = { root: root === ROOT ? 'current' : root, startup: [], emulation: {} };
for (let i = 0; i < 5; i++) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 });
  await ctx.addInitScript(() => { window.__perf = { lcp: 0, cls: 0, long: 0, longMax: 0, ev: [] };
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) { window.__perf.long += e.duration; window.__perf.longMax = Math.max(window.__perf.longMax, e.duration); } }).observe({ type: 'longtask', buffered: true });
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.interactionId) window.__perf.ev.push(e.duration); }).observe({ type: 'event', durationThreshold: 16, buffered: true }); });
  const p = await ctx.newPage(); await p.goto(`${srv.base}/play/?nosw&welcome=0`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library'); await sleep(1500);
  const r = await p.evaluate(() => { const fcp = performance.getEntriesByName('first-contentful-paint')[0]; return { fcp: fcp ? fcp.startTime : 0, ...window.__perf }; });
  // interactions: nav taps (new shell) or nothing comparable on the old UI (the old page has no nav): measured only where the element exists
  const nav = await p.$('#psNav [data-nav=games]'); if (nav) { for (const t of ['games', 'multiplayer', 'home', 'games']) { await p.click(`#psNav [data-nav=${t}]`); await sleep(260); } }
  r.ev = await p.evaluate(() => window.__perf.ev); result.startup.push(r); await ctx.close();
}
const agg = (k) => Number(med(result.startup.map((r) => r[k])).toFixed(1));
result.summary = { fcpMs: agg('fcp'), lcpMs: agg('lcp'), cls: Number(med(result.startup.map((r) => r.cls)).toFixed(3)), longTaskMsAtStart: agg('long'), longestTaskMs: agg('longMax'), interactionP98Ms: Number((([...result.startup.flatMap((r) => r.ev)].sort((a, b) => a - b))[Math.floor(result.startup.flatMap((r) => r.ev).length * 0.98)] || 0).toFixed(1)) };
for (const sys of ['nds', 'ps1']) {
  const runs = [];
  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, deviceScaleFactor: 2 }); const p = await ctx.newPage();
    await p.goto(`${srv.base}/play/?nosw&welcome=0`); await p.waitForFunction(() => window.dslinkPlay && document.body.dataset.screen === 'library');
    await p.evaluate(() => window.dslinkPlay.go && window.dslinkPlay.go('games')).catch(() => {});
    await p.setInputFiles('#romFile', sys === 'nds' ? [nds] : files(discs, 'Test Game.cue', 'Test Game.bin')); await until(async () => (await p.locator('#gameList li.game').count()) === 1, 20000);
    await p.click('li.game .play'); if (sys === 'ps1') { await p.waitForSelector('#hleBox:not([hidden])', { timeout: 20000 }); await p.click('#btnHleGo'); }
    await p.waitForFunction(() => window.dslinkPlay.isPlaying(), null, { timeout: 40000 }); await sleep(3000);
    const a = await p.evaluate(() => { const s = window.dslinkPlay.stats(); return { stalls: s.stalls || 0, longTasks: s.longTasks || 0 }; }); await sleep(8000);
    const s = await p.evaluate(() => { const x = window.dslinkPlay.stats(); return { emuFps: x.emuFps, renderFps: x.renderFps, frameMsAvg: x.frameMsAvg, frameMsMax: x.frameMsMax, mainMsAvg: x.mainFrameMsAvg || 0, stalls: x.stalls || 0, longTasks: x.longTasks || 0, underruns: x.audio ? x.audio.underEvents || 0 : 0 }; });
    s.stalls -= a.stalls; s.longTasks -= a.longTasks; runs.push(s); await ctx.close();
  }
  const f = (k) => Number(med(runs.map((r) => r[k])).toFixed(2));
  result.emulation[sys] = { emuFps: f('emuFps'), renderFps: f('renderFps'), frameMsAvg: f('frameMsAvg'), frameMsMax: f('frameMsMax'), mainFrameMsAvg: f('mainMsAvg'), stallsIn8s: f('stalls'), longTasksIn8s: f('longTasks'), audioUnderruns: f('underruns') };
}
fs.writeFileSync(out, JSON.stringify(result, null, 1)); await browser.close(); srv.close(); console.log(JSON.stringify({ summary: result.summary, emulation: result.emulation }));
