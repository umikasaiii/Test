// Geometry tests of the touch-control layouts (pure functions, no browser): everything inside the phone, no overlaps, approved ordering, big screens.
import test from "node:test";
import assert from "node:assert/strict";
import { computeLayout, DIM } from "../public/controls/layouts.js";

const PORTRAIT = [[360, 640], [375, 667], [390, 844], [412, 915], [430, 932], [768, 1024]];
const LANDSCAPE = [[640, 360], [667, 375], [844, 390], [915, 412], [932, 430], [1024, 768]];
const NOTCH = { top: 0, bottom: 21, left: 47, right: 47 };      // landscape iPhone safe areas
const NOTCH_P = { top: 47, bottom: 34, left: 0, right: 0 };
const cases = [];
for (const platform of ["nds", "ps1"]) {
  for (const [w, h] of PORTRAIT) { cases.push({ platform, width: w, height: h, insets: {} }); cases.push({ platform, width: w, height: h, insets: NOTCH_P }); }
  for (const [w, h] of LANDSCAPE) { cases.push({ platform, width: w, height: h, insets: {} }); cases.push({ platform, width: w, height: h, insets: NOTCH }); }
}
const name = (c) => `${c.platform} ${c.width}x${c.height}${c.insets.left || c.insets.top ? " notch" : ""}`;
const inside = (r, f, eps = 0.5) => r.x >= f.x - eps && r.y >= f.y - eps && r.x + r.w <= f.x + f.w + eps && r.y + r.h <= f.y + f.h + eps;
const overlap = (a, b) => a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
const get = (L, id) => L.controls.find((c) => c.id === id);

for (const c of cases) {
  const L = computeLayout(c);
  test(`${name(c)}: every control and the game picture are inside the phone (safe area)`, () => {
    for (const k of L.controls) { assert.ok(inside(k, L.frame), `${k.id} ${JSON.stringify(k)} outside ${JSON.stringify(L.frame)}`); assert.ok(inside(k.hit, L.frame, 2), `${k.id} hit area outside`); }
    assert.ok(inside(L.screen.clip, L.frame), "picture outside");
  });
  test(`${name(c)}: no control overlaps another control's hit area or the picture`, () => {
    for (let i = 0; i < L.controls.length; i++) for (let j = i + 1; j < L.controls.length; j++) {
      assert.ok(!overlap(L.controls[i].hit, L.controls[j].hit), `${L.controls[i].id} hit overlaps ${L.controls[j].id} hit`);
      assert.ok(!overlap(L.controls[i], L.controls[j]), `${L.controls[i].id} overlaps ${L.controls[j].id}`);
    }
    for (const k of L.controls) assert.ok(!overlap(k, L.screen.clip), `${k.id} covers the game picture`);
  });
  test(`${name(c)}: thumb-sized targets`, () => {
    const min = DIM.minHit * L.scale - 0.5;
    for (const k of L.controls) {
      if (k.type === "pill") assert.ok(k.hit.w >= min && k.hit.h >= min, `${k.id} hit ${k.hit.w}x${k.hit.h} < ${min}`);
      else assert.ok(k.hit.w >= min && k.hit.h >= min, `${k.id} too small`);
    }
    assert.ok(get(L, "dpad").w >= DIM.dpad.min * L.scale - 0.5 && get(L, "actions").w >= DIM.cluster.min * L.scale - 0.5, "pad clusters too small");
  });
  test(`${name(c)}: approved structure`, () => {
    const frame = L.frame, S = (id) => get(L, id), dp = S("dpad"), ac = S("actions");
    assert.ok(dp.x + dp.w / 2 < frame.x + frame.w / 2 && ac.x + ac.w / 2 > frame.x + frame.w / 2, "D-pad left, actions right");
    assert.ok(Math.abs((dp.y + dp.h) - (ac.y + ac.h)) < 1 || L.orientation === "portrait", "pads share the bottom line (landscape)");
    const lShoulder = S("l"), rShoulder = S("r");
    assert.ok(lShoulder.x < frame.x + frame.w / 2 && rShoulder.x > frame.x + frame.w / 2, "L left, R right");
    assert.ok(lShoulder.y <= frame.y + DIM.margin * L.scale + 1, "shoulders at the top");
    if (c.platform === "ps1") { assert.ok(S("l2").x > lShoulder.x && S("r2").x > rShoulder.x, "L1 L2 / R1 R2 left-to-right"); }
    if (L.orientation === "landscape") {
      const menu = S("menu"), sel = S("select"), st = S("start"), fo = S("focus");
      const bottomOf = (k) => k.y + k.h;
      // left column: L, MENU, SELECT, D-pad from top to bottom; right column: R, START, FOCUS, actions
      assert.ok(bottomOf(lShoulder) <= menu.y + 0.5 && bottomOf(menu) <= sel.y + 0.5 && bottomOf(sel) <= dp.y + 0.5, "left column order L > MENU > SELECT > D-pad");
      assert.ok(bottomOf(rShoulder) <= st.y + 0.5 && bottomOf(st) <= fo.y + 0.5 && bottomOf(fo) <= ac.y + 0.5, "right column order R > START > FOCUS > actions");
      assert.ok(menu.x + menu.w <= L.screen.clip.x && sel.x + sel.w <= L.screen.clip.x, "MENU/SELECT on the left of the picture");
      assert.ok(st.x >= L.screen.clip.x + L.screen.clip.w && fo.x >= L.screen.clip.x + L.screen.clip.w, "START/FOCUS on the right of the picture");
      assert.ok(dp.y + dp.h > frame.y + frame.h * 0.55, "pads are low");
      // the picture is as large as the minimum column widths allow (limited by height for DS, by height or width for PS1 4:3)
      const aspect = c.platform === "nds" ? 2 / 3 : 4 / 3, sh = c.platform === "ps1" ? DIM.shoulderPs.w * 2 + 6 : DIM.shoulder.w;
      const colMin = Math.max(DIM.dpad.min, DIM.cluster.min, sh) * L.scale + DIM.margin * L.scale + DIM.gap * L.scale;
      const best = Math.min(frame.h - 2 * DIM.margin * L.scale, (frame.w - 2 * colMin) / aspect);
      assert.ok(L.screen.clip.h >= best * 0.97, `picture ${L.screen.clip.h.toFixed(0)}px high, could be ${best.toFixed(0)}px`);
      if (c.platform === "nds") assert.ok(L.screen.clip.h / frame.h >= 0.88, "DS picture uses the full height");
    } else {
      const m = S("menu"), se = S("select"), st = S("start");
      assert.ok(m.x < se.x && se.x < st.x, "MENU SELECT START left to right");
      assert.ok(Math.abs(se.x + se.w / 2 - (frame.x + frame.w / 2)) < 1, "small buttons centred");
      assert.ok(L.screen.clip.y >= lShoulder.y + lShoulder.h, "picture under the shoulder row");
      assert.ok(L.screen.clip.y + L.screen.clip.h <= dp.y + 0.5, "picture above the pads");
      assert.ok(!L.controls.find((k) => k.id === "focus"), "no FOCUS in portrait");
    }
  });
}

test("landscape layouts are left/right symmetric", () => {
  for (const platform of ["nds", "ps1"]) {
    const L = computeLayout({ platform, width: 844, height: 390, insets: {} });
    const mid = L.frame.x + L.frame.w / 2, get2 = (id) => L.controls.find((c) => c.id === id);
    for (const [a, b] of [["l", "r"], ["menu", "start"], ["select", "focus"], ["dpad", "actions"]]) {
      const A = get2(a), B = get2(b); if (platform === "ps1" && a === "l") continue;
      assert.ok(Math.abs((A.y + A.h / 2) - (B.y + B.h / 2)) < 12 * L.scale || a === "dpad" || a === "select", `${a}/${b} vertical alignment`);
    }
    assert.ok(Math.abs((L.screen.clip.x + L.screen.clip.w / 2) - mid) < 1, "picture centred");
  }
});

test("FOCUS changes the DS picture to a single screen that fills the region; stylus follows", () => {
  const both = computeLayout({ platform: "nds", width: 844, height: 390, insets: {} });
  const top = computeLayout({ platform: "nds", width: 844, height: 390, insets: {}, view: "top" });
  const bot = computeLayout({ platform: "nds", width: 844, height: 390, insets: {}, view: "bottom" });
  assert.ok(top.screen.clip.w > both.screen.clip.w * 1.3, "focused screen is larger");
  assert.equal(top.stylus, null, "no stylus on the top screen");
  assert.ok(bot.stylus && Math.abs(bot.stylus.w - bot.screen.clip.w) < 1 && Math.abs(bot.stylus.h - bot.screen.clip.h) < 1, "stylus covers the focused bottom screen");
  assert.ok(both.stylus.y >= both.screen.video.y + both.screen.video.h / 2 - 1, "default: stylus on the lower half");
});

test("the picture keeps its aspect ratio (no distortion) unless stretch is explicitly requested", () => {
  const nds = computeLayout({ platform: "nds", width: 844, height: 390, insets: {} });
  assert.ok(Math.abs(nds.screen.video.w / nds.screen.video.h - 2 / 3) < 0.01);
  const ps = computeLayout({ platform: "ps1", width: 844, height: 390, insets: {} });
  assert.ok(Math.abs(ps.screen.video.w / ps.screen.video.h - 4 / 3) < 0.01);
});
