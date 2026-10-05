// Browser tests of the touch controls (real DOM, real PointerEvents, mobile viewports): rendering inside the phone, multitouch input mapping, FOCUS/MENU, release safety, rotation.
// usage: node controls_e2e.mjs <base-url>
import { chromium } from 'playwright';
const base = process.argv[2] || 'http://localhost:8787';
const results = [];
const check = (n, ok, d = '') => { results.push({ n, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ['--no-sandbox'] });

async function open(p, w, h, extra = '') {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/controls-preview.html?p=${p}${extra}`); await page.waitForSelector('.ctl-c');
  page.errors = errors;
  return page;
}
// helpers: synthetic multi-touch pointers
const fire = (page, type, id, x, y) => page.evaluate(([type, id, x, y]) => { const s = document.getElementById('stage'); s.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: id === 1 })); }, [type, id, x, y]);
const events = (page) => page.evaluate(() => window.__events.splice(0));
const rectOf = (page, sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; }, sel);
const btns = (evs) => evs.filter((e) => e[0] === 'btn').map((e) => `${e[1]}:${e[2] ? 1 : 0}`);
const down = (evs) => new Set(evs.filter((e) => e[0] === 'btn' && e[2]).map((e) => e[1]));
const up = (evs) => new Set(evs.filter((e) => e[0] === 'btn' && !e[2]).map((e) => e[1]));

for (const [p, o, w, h] of [['nds', 'portrait', 390, 844], ['nds', 'landscape', 844, 390], ['ps1', 'portrait', 390, 844], ['ps1', 'landscape', 844, 390]]) {
  const tag = `${p} ${o}`;
  const page = await open(p, w, h);
  // ---- rendering: every visible piece inside the phone, nothing overlapping
  const boxes = await page.evaluate(() => [...document.querySelectorAll('.ctl-c, .ctl-face, .ctl-clip')].map((e) => { const r = e.getBoundingClientRect(); return { cls: e.className.toString().split(' ').slice(0, 2).join('.'), id: e.dataset.id || e.dataset.face || '', x: r.x, y: r.y, w: r.width, h: r.height }; }));
  check(`${tag}: every control and the picture are rendered inside the ${w}x${h} phone`, boxes.every((b) => b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= w + 0.5 && b.y + b.h <= h + 0.5), boxes.filter((b) => b.x < -0.5 || b.y < -0.5 || b.x + b.w > w + 0.5 || b.y + b.h > h + 0.5).map((b) => b.id).join());
  const ctl = boxes.filter((b) => b.cls.split('.')[0] === 'ctl-c');
  const ov = []; for (let i = 0; i < ctl.length; i++) for (let j = i + 1; j < ctl.length; j++) { const a = ctl[i], b = ctl[j]; if (a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5) ov.push(a.id + '/' + b.id); }
  check(`${tag}: rendered controls do not overlap each other`, ov.length === 0, ov.join());
  const clip = boxes.find((b) => b.cls.split('.')[0] === 'ctl-clip');
  check(`${tag}: no control covers the picture`, ctl.every((b) => !(b.x < clip.x + clip.w - 0.5 && clip.x < b.x + b.w - 0.5 && b.y < clip.y + clip.h - 0.5 && clip.y < b.y + b.h - 0.5)));

  // ---- D-pad: 4 directions, diagonal, dead zone, slide, release
  const dp = await rectOf(page, '[data-id=dpad]');
  await fire(page, 'pointerdown', 1, dp.cx + dp.w * 0.38, dp.cy);
  let ev = await events(page); check(`${tag}: D-pad right`, btns(ev).join() === 'right:1', btns(ev).join());
  check(`${tag}: pressed state is shown on the pad arm`, await page.evaluate(() => !!document.querySelector('[data-id=dpad] .arm[data-dir=right].is-down')));
  await fire(page, 'pointermove', 1, dp.cx + dp.w * 0.34, dp.cy - dp.h * 0.34);
  ev = await events(page); check(`${tag}: sliding to the up-right corner adds UP (diagonal) and keeps RIGHT`, down(ev).has('up') && !up(ev).has('right'), btns(ev).join());
  await fire(page, 'pointermove', 1, dp.cx - dp.w * 0.38, dp.cy);
  ev = await events(page); check(`${tag}: sliding across to LEFT releases right/up and presses left`, up(ev).has('right') && up(ev).has('up') && down(ev).has('left'), btns(ev).join());
  await fire(page, 'pointerup', 1, dp.cx - dp.w * 0.38, dp.cy);
  ev = await events(page); check(`${tag}: lifting the thumb releases the direction`, up(ev).has('left'), btns(ev).join());
  await fire(page, 'pointerdown', 1, dp.cx + 2, dp.cy + 2);
  ev = await events(page); check(`${tag}: a touch on the hub (dead zone) presses nothing`, btns(ev).length === 0);
  await fire(page, 'pointerup', 1, dp.cx, dp.cy); await events(page);

  // ---- action cluster: exact button, slide, chord between two, multitouch with the pad
  const face = async (id) => rectOf(page, `[data-id=actions] [data-face=${id}]`);
  const A = await face('a'), B = await face('b');
  await fire(page, 'pointerdown', 2, A.cx, A.cy);
  ev = await events(page); check(`${tag}: ${p === 'nds' ? 'A' : 'circle'} button`, btns(ev).join() === 'a:1', btns(ev).join());
  await fire(page, 'pointermove', 2, B.cx, B.cy);
  ev = await events(page); check(`${tag}: sliding from A to B moves the press (A up, B down)`, up(ev).has('a') && down(ev).has('b'), btns(ev).join());
  await fire(page, 'pointermove', 2, (A.cx + B.cx) / 2, (A.cy + B.cy) / 2);
  ev = await events(page); check(`${tag}: a thumb between two buttons presses both (chord)`, down(ev).has('a'), btns(ev).join());
  await fire(page, 'pointerup', 2, B.cx, B.cy); await events(page);
  await fire(page, 'pointerdown', 1, dp.cx + dp.w * 0.38, dp.cy); await fire(page, 'pointerdown', 2, A.cx, A.cy);
  ev = await events(page); check(`${tag}: two thumbs at once: D-pad right + A`, btns(ev).includes('right:1') && btns(ev).includes('a:1'), btns(ev).join());
  await fire(page, 'pointercancel', 1, 0, 0); ev = await events(page);
  check(`${tag}: pointercancel releases that thumb's buttons only`, up(ev).has('right') && !up(ev).has('a'), btns(ev).join());
  await page.evaluate(() => window.dispatchEvent(new Event('blur'))); ev = await events(page);
  check(`${tag}: losing focus (blur) releases everything still held`, up(ev).has('a'), btns(ev).join());
  await fire(page, 'pointerup', 2, 0, 0); await events(page);

  // ---- shoulders and small buttons
  const sh = p === 'ps1' ? ['l', 'l2', 'r', 'r2'] : ['l', 'r'];
  for (const id of sh) { const r = await rectOf(page, `[data-id=${id}]`); await fire(page, 'pointerdown', 3, r.cx, r.cy); ev = await events(page); await fire(page, 'pointerup', 3, r.cx, r.cy); const ev2 = await events(page); check(`${tag}: shoulder ${id.toUpperCase()}`, btns(ev).join() === `${id}:1` && btns(ev2).join() === `${id}:0`, btns(ev).join() + ' ' + btns(ev2).join()); }
  for (const id of ['select', 'start']) { const r = await rectOf(page, `[data-id=${id}] .ctl-pillbtn`); await fire(page, 'pointerdown', 3, r.cx, r.cy); ev = await events(page); await fire(page, 'pointerup', 3, r.cx, r.cy); const ev2 = await events(page); check(`${tag}: ${id.toUpperCase()}`, btns(ev).join() === `${id}:1` && btns(ev2).join() === `${id}:0`); }
  // a miss between controls does nothing (no accidental press)
  await fire(page, 'pointerdown', 4, w / 2, o === 'portrait' ? h - 140 : h / 2); ev = await events(page);
  await fire(page, 'pointerup', 4, w / 2, o === 'portrait' ? h - 140 : h / 2); await events(page);

  // ---- MENU opens the sheet (and swallows game input) ; sliders change the skin live
  const m = await rectOf(page, '[data-id=menu] .ctl-pillbtn');
  await fire(page, 'pointerdown', 5, m.cx, m.cy); await fire(page, 'pointerup', 5, m.cx, m.cy);
  check(`${tag}: MENU opens the in-game menu`, await page.evaluate(() => !!document.querySelector('.ctl-menu')) && (await events(page)).some((e) => e[0] === 'ui' && e[1] === 'menu'));
  await page.evaluate(() => { const i = document.querySelector('.ctl-menu input[data-key=alpha]'); i.value = '0.5'; i.dispatchEvent(new Event('input')); });
  check(`${tag}: opacity slider applies live`, (await page.evaluate(() => getComputedStyle(document.getElementById('stage')).getPropertyValue('--ctl-alpha'))).trim() === '0.5');
  await page.evaluate(() => { const i = document.querySelector('.ctl-menu input[data-key=scale]'); i.value = '1.15'; i.dispatchEvent(new Event('input')); });
  const big = await rectOf(page, '[data-id=dpad]');
  check(`${tag}: size slider enlarges the controls and they still fit`, big.w > dp.w * 1.05 && big.x >= 0 && big.y + big.h <= h + 0.5, `${dp.w.toFixed(0)} -> ${big.w.toFixed(0)}`);
  await page.evaluate(() => document.querySelector('.ctl-menu button[data-act=leave]').click());
  check(`${tag}: "Esci dalla partita" calls leave`, (await events(page)).some((e) => e[0] === 'leave'));
  check(`${tag}: no script errors`, page.errors.length === 0, page.errors.join('|'));
  await page.context().close();
}

// ---- Nintendo DS specifics: stylus on the lower screen only, FOCUS, rotation
{
  const page = await open('nds', 844, 390);
  const clip = await rectOf(page, '.ctl-clip');
  await fire(page, 'pointerdown', 1, clip.cx, clip.y + clip.h * 0.25); await fire(page, 'pointerup', 1, clip.cx, clip.y + clip.h * 0.25);
  check('nds landscape: a tap on the TOP screen sends no stylus touch', (await events(page)).filter((e) => e[0] === 'stylus').length === 0);
  await fire(page, 'pointerdown', 1, clip.cx, clip.y + clip.h * 0.75); await fire(page, 'pointermove', 1, clip.cx + 20, clip.y + clip.h * 0.8); await fire(page, 'pointerup', 1, clip.cx + 20, clip.y + clip.h * 0.8);
  const st = (await events(page)).filter((e) => e[0] === 'stylus');
  check('nds landscape: stylus on the lower screen maps to the lower half of the frame, moves and lifts', st.length >= 3 && st[0][2] <= 0.52 + 0.3 && st.every((e) => e[2] >= 0.5 && e[2] <= 1) && st[st.length - 1][3] === false && Math.abs(st[0][1] - 0.5) < 0.05, JSON.stringify(st[0]));
  const before = await rectOf(page, '.ctl-clip');
  const f = await rectOf(page, '[data-id=focus] .ctl-pillbtn');
  await fire(page, 'pointerdown', 6, f.cx, f.cy); await fire(page, 'pointerup', 6, f.cx, f.cy);
  const afterBottom = await rectOf(page, '.ctl-clip');
  check('nds landscape: FOCUS shows ONE 4:3 DS screen at ~2x the area it had (bottom first)', (afterBottom.w * afterBottom.h) > (before.w * before.h / 2) * 1.8 && Math.abs(afterBottom.w / afterBottom.h - 4 / 3) < 0.02, `${before.w.toFixed(0)}x${before.h.toFixed(0)} -> ${afterBottom.w.toFixed(0)}x${afterBottom.h.toFixed(0)}`);
  await events(page);
  await fire(page, 'pointerdown', 1, afterBottom.cx, afterBottom.cy); await fire(page, 'pointerup', 1, afterBottom.cx, afterBottom.cy);
  const s2 = (await events(page)).filter((e) => e[0] === 'stylus');
  check('nds landscape: in bottom-FOCUS the whole visible screen is the stylus pad (centre -> centre of the lower screen)', s2.length >= 2 && Math.abs(s2[0][1] - 0.5) < 0.03 && Math.abs(s2[0][2] - 0.75) < 0.03, JSON.stringify(s2[0]));
  await fire(page, 'pointerdown', 6, f.cx, f.cy); await fire(page, 'pointerup', 6, f.cx, f.cy);
  await events(page);
  await fire(page, 'pointerdown', 1, afterBottom.cx, afterBottom.cy); await fire(page, 'pointerup', 1, afterBottom.cx, afterBottom.cy);
  check('nds landscape: FOCUS on the TOP screen disables the stylus', (await events(page)).filter((e) => e[0] === 'stylus').length === 0);
  await fire(page, 'pointerdown', 6, f.cx, f.cy); await fire(page, 'pointerup', 6, f.cx, f.cy);
  const back = await rectOf(page, '.ctl-clip');
  check('nds landscape: a third FOCUS returns to both screens', Math.abs(back.w - before.w) < 1);
  // rotation: held button released, layout switches orientation, everything still inside
  const dp = await rectOf(page, '[data-id=dpad]');
  await fire(page, 'pointerdown', 1, dp.cx + dp.w * 0.38, dp.cy); await events(page);
  await page.setViewportSize({ width: 390, height: 844 }); await sleep(400);
  const ev = await events(page);
  check('rotation: a held direction is released when the layout changes', up(ev).has('right'), btns(ev).join());
  check('rotation: the stage switches to the portrait layout', (await page.evaluate(() => document.getElementById('stage').dataset.orientation)) === 'portrait');
  const inside = await page.evaluate(() => [...document.querySelectorAll('.ctl-c')].every((e) => { const r = e.getBoundingClientRect(); return r.x >= -0.5 && r.y >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5; }));
  check('rotation: all controls inside the phone after rotating', inside);
  await page.context().close();
}
{
  const page = await open('nds', 844, 390, '&notch=1');
  const inside = await page.evaluate(() => { const L = 47, R = innerWidth - 47; return [...document.querySelectorAll('.ctl-c')].every((e) => { const r = e.getBoundingClientRect(); return r.left >= L - 0.5 && r.right <= R + 0.5 && r.bottom <= innerHeight - 21 + 0.5; }); });
  check('notch: controls stay inside the iPhone safe area (47px sides, 21px home indicator)', inside);
  await page.context().close();
}
{
  const page = await open('ps1', 844, 390);
  const f = await rectOf(page, '[data-id=focus] .ctl-pillbtn');
  const a0 = await page.evaluate(() => getComputedStyle(document.getElementById('stage')).getPropertyValue('--ctl-alpha'));
  await fire(page, 'pointerdown', 6, f.cx, f.cy); await fire(page, 'pointerup', 6, f.cx, f.cy);
  const a1 = await page.evaluate(() => getComputedStyle(document.getElementById('stage')).getPropertyValue('--ctl-alpha'));
  check('ps1 landscape: the auxiliary key toggles immersive mode (controls almost hidden, picture unchanged)', Number(a1) < Number(a0) && Number(a1) <= 0.15, `${a0.trim()} -> ${a1.trim()}`);
  const d = await rectOf(page, '[data-id=dpad]');
  await fire(page, 'pointerdown', 7, d.cx, d.cy); await fire(page, 'pointerup', 7, d.cx, d.cy);
  const a2 = await page.evaluate(() => getComputedStyle(document.getElementById('stage')).getPropertyValue('--ctl-alpha'));
  check('ps1 immersive: a touch brings the controls back', Number(a2) >= 0.99, a2.trim());
  await page.waitForTimeout(2900);
  const a3 = await page.evaluate(() => getComputedStyle(document.getElementById('stage')).getPropertyValue('--ctl-alpha'));
  check('ps1 immersive: controls fade again after the touch', Number(a3) <= 0.15, a3.trim());
  await page.context().close();
}
{
  // D-pad artwork: one plus-shaped silhouette (approved reference), four pressed-state overlays, no separate arms
  const page = await open('nds', 390, 844);
  const info = await page.evaluate(() => { const d = document.querySelector('[data-id=dpad]'); return { shapes: d.querySelectorAll('path.shape').length, arms: d.querySelectorAll('.arm').length, dimple: !!d.querySelector('.dimple'), chev: d.querySelectorAll('.chev').length, w: d.getBoundingClientRect().width }; });
  check('dpad: single plus silhouette + dimple, 4 direction overlays, no chevrons', info.shapes === 1 && info.arms === 4 && info.dimple && info.chev === 0, JSON.stringify(info));
  const d = await rectOf(page, '[data-id=dpad]');
  await fire(page, 'pointerdown', 3, d.cx, d.y + 8);
  const lit = await page.evaluate(() => [...document.querySelectorAll('[data-id=dpad] .arm.is-down')].map((e) => e.dataset.dir).join());
  await fire(page, 'pointerup', 3, d.cx, d.y + 8);
  const off = await page.evaluate(() => document.querySelectorAll('[data-id=dpad] .arm.is-down').length);
  check('dpad: pressed direction lights its arm and releases', lit === 'up' && off === 0, `${lit} / ${off}`);
  const sizes = await page.evaluate(() => { const r = (q) => { const b = document.querySelector(q).getBoundingClientRect(); return [b.width, b.height]; }; return { dpad: r('[data-id=dpad]'), face: r('[data-face=a]'), pill: r('[data-id=menu] .ctl-pillbtn') }; });
  check('visible sizes: D-pad >= 48, action buttons >= 48', sizes.dpad[0] >= 48 && sizes.face[0] >= 47.5 && sizes.face[1] >= 47.5, JSON.stringify(sizes));
  const def = await page.evaluate(() => { const v = document.querySelector('#stage .ctl-clip'); const b = v.getBoundingClientRect(); return b.height / b.width; });
  check('default DS picture keeps the real 2:3 aspect (two 4:3 screens)', Math.abs(def - 1.5) < 0.01, def.toFixed(3));
  await page.context().close();
}
{
  const page = await open('nds', 844, 390);
  const r = await page.evaluate(() => { const b = document.querySelector('#stage .ctl-clip').getBoundingClientRect(); return b.height / b.width; });
  check('default DS landscape keeps the real aspect (not stretched)', Math.abs(r - 1.5) < 0.01, r.toFixed(3));
  await page.context().close();
}
await browser.close();
const bad = results.filter((r) => !r.ok).length;
console.log(`${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
