// DSLink touch controls — LAYOUT ENGINE (pure geometry: no DOM, no input).
// Four approved layouts: nds/ps1 x portrait/landscape. Input: viewport size + safe-area insets; output: pixel rectangles for the game screen and every control.
// Sizes are in "dp" at scale 1 (a 390x844 / 844x390 phone) and are scaled by the viewport; nothing is ever placed outside the safe rectangle.

export const PLATFORMS = {
  nds: { name: "Nintendo DS", aspect: 2 / 3, labels: { x: "X", y: "Y", a: "A", b: "B" } },   // two 4:3 screens stacked => 256x384
  ps1: { name: "PlayStation 1", aspect: 4 / 3, labels: {} },
};

export const DIM = {
  margin: 14, gap: 10,
  shoulder: { w: 68, h: 36 },          // DS L / R
  shoulderPs: { w: 54, h: 36 },        // PS1 L1 L2 R1 R2
  pill: { hit: 40, vis: 34, label: 12 },   // MENU SELECT START FOCUS (round icon button + micro label)
  dpad: { max: 136, min: 108 },
  cluster: { max: 144, min: 112 },     // diamond of four action buttons
  minHit: 40,
};

const rect = (x, y, w, h) => ({ x, y, w, h });
const fit = (aw, ah, bw, bh) => { const s = Math.min(bw / aw, bh / ah); return { w: aw * s, h: ah * s }; };   // largest aw:ah inside bw x bh

/** @returns {{orientation:string, scale:number, frame:object, screen:object, controls:object[], variant:string}} */
export function computeLayout({ platform = "nds", width, height, insets = {}, view = "both", fill = false, userScale = 1 }) {
  const ins = { top: insets.top || 0, right: insets.right || 0, bottom: insets.bottom || 0, left: insets.left || 0 };
  const frame = rect(ins.left, ins.top, width - ins.left - ins.right, height - ins.top - ins.bottom);
  const landscape = width > height;
  const ps = platform === "ps1";
  const P = PLATFORMS[platform];
  const m = DIM.margin, g = DIM.gap;
  const sh = ps ? DIM.shoulderPs : DIM.shoulder;
  const controls = [];
  const add = (c) => { controls.push(c); return c; };

  // ---------- scale: tablets a bit larger, short phones smaller, so the column budget (landscape) always fits
  let s = Math.max(0.8, Math.min(1.25, Math.min(frame.w, frame.h) / 390)) * Math.max(0.8, Math.min(1.2, userScale));
  const columnNeed = m + sh.h + g + (DIM.pill.hit + DIM.pill.label) * 2 + g + DIM.dpad.max + m;      // L, MENU/SELECT, D-pad
  if (landscape) s = Math.min(s, frame.h / columnNeed);

  const D = (v) => v * s;
  const dpadSize = (avail) => Math.max(D(DIM.dpad.min), Math.min(D(DIM.dpad.max), avail));
  const mk = (id, type, x, y, w, h, extra = {}) => add({ id, type, x: frame.x + x, y: frame.y + y, w, h, ...extra });
  const pill = (id, label, icon, cx, cy) => mk(id, "pill", cx - D(DIM.pill.hit) / 2, cy - D(DIM.pill.hit) / 2, D(DIM.pill.hit), D(DIM.pill.hit) + D(DIM.pill.label), { label, icon, vis: D(DIM.pill.vis) });

  const faces = ps
    ? [["x", "triangle", "top"], ["a", "circle", "right"], ["b", "cross", "bottom"], ["y", "square", "left"]]
    : [["x", "X", "top"], ["a", "A", "right"], ["b", "B", "bottom"], ["y", "Y", "left"]];
  const addCluster = (x, y, size) => {
    const c = mk("actions", "cluster", x, y, size, size, { faces: faces.map(([id, glyph, pos]) => ({ id, glyph, pos })), platform });
    return c;
  };
  const addShoulders = (side, x, y) => {
    if (!ps) return mk(side === "L" ? "l" : "r", "shoulder", x, y, D(sh.w), D(sh.h), { label: side });
    // PS1: two shoulder buttons side by side, L1 L2 on the left, R1 R2 on the right (R1 inner... as approved: R1 R2 left-to-right)
    const w = D(sh.w), gap = D(6);
    const a = side === "L" ? ["l", "L1"] : ["r", "R1"], b = side === "L" ? ["l2", "L2"] : ["r2", "R2"];
    mk(a[0], "shoulder", x, y, w, D(sh.h), { label: a[1] });
    mk(b[0], "shoulder", x + w + gap, y, w, D(sh.h), { label: b[1] });
  };
  const shouldersW = ps ? D(sh.w) * 2 + D(6) : D(sh.w);

  let screen, variant;
  if (!landscape) {
    // =============================== PORTRAIT ===============================
    addShoulders("L", D(m), D(m));
    addShoulders("R", frame.w - D(m) - shouldersW, D(m));
    const top = D(m) + D(sh.h) + D(g);

    // bottom area: D-pad bottom-left, actions bottom-right, MENU/SELECT/START small, centred.
    const pillsW = 3 * D(DIM.pill.hit) + 2 * D(4);
    const pillH = D(DIM.pill.hit) + D(DIM.pill.label);
    let dp = D(DIM.dpad.max), cl = D(DIM.cluster.max);
    let centre = frame.w - 2 * D(m) - dp - cl;
    let pillsInline = centre >= pillsW + D(8);
    if (!pillsInline) {                                   // shrink the pads a little before giving up the reference arrangement
      const shrink = Math.min(1, (frame.w - 2 * D(m) - pillsW - D(8)) / (dp + cl));
      const dp2 = Math.max(D(DIM.dpad.min), dp * shrink), cl2 = Math.max(D(DIM.cluster.min), cl * shrink);
      if (frame.w - 2 * D(m) - dp2 - cl2 >= pillsW + D(8)) { dp = dp2; cl = cl2; pillsInline = true; }
    }
    variant = pillsInline ? "inline-pills" : "tiered-pills";
    const bottomPad = frame.h - D(m);
    const pillRowY = bottomPad - pillH;                                                           // the small buttons always sit at the very bottom
    const padsBottom = pillsInline ? bottomPad : bottomPad - pillH - D(6);
    mk("dpad", "dpad", D(m), padsBottom - dp, dp, dp);
    addCluster(frame.w - D(m) - cl, padsBottom - cl, cl);
    const cx = frame.w / 2, step = D(DIM.pill.hit) + D(4);
    pill("menu", "MENU", "menu", cx - step, pillRowY + D(DIM.pill.hit) / 2);
    pill("select", "SELECT", "minus", cx, pillRowY + D(DIM.pill.hit) / 2);
    pill("start", "START", "play", cx + step, pillRowY + D(DIM.pill.hit) / 2);
    const controlsTop = padsBottom - Math.max(dp, cl);
    const region = rect(frame.x + D(m), frame.y + top, frame.w - 2 * D(m), Math.max(0, controlsTop - D(g) - top));
    screen = { region };
  } else {
    // =============================== LANDSCAPE ===============================
    // left column: L (top) / MENU+SELECT / D-pad (low);  right column: R / START+FOCUS / actions (low)
    variant = "columns";
    // the pads shrink (never below their minimum) when the picture would otherwise be limited by width instead of height (PS1 4:3 on a short, narrow phone)
    const wWanted = (frame.h - 2 * D(m)) * P.aspect;
    const colBudget = (frame.w - wWanted) / 2 - D(g) - D(m);
    const dp = Math.max(D(DIM.dpad.min), Math.min(D(DIM.dpad.max), colBudget)), cl = Math.max(D(DIM.cluster.min), Math.min(D(DIM.cluster.max), colBudget));
    const colW = Math.max(dp, cl, shouldersW) + D(m);
    addShoulders("L", D(m), D(m));
    addShoulders("R", frame.w - D(m) - shouldersW, D(m));
    mk("dpad", "dpad", D(m), frame.h - D(m) - dp, dp, dp);
    addCluster(frame.w - D(m) - cl, frame.h - D(m) - cl, cl);
    // the two small buttons are stacked in the band between the shoulder row and the pad, centred on the shoulder / pad axis
    const bandTop = D(m) + D(sh.h) + D(g), bandBottom = frame.h - D(m) - Math.max(dp, cl) - D(g);
    const pillH = D(DIM.pill.hit) + D(DIM.pill.label);
    const gapPills = Math.max(0, Math.min(D(8), (bandBottom - bandTop - 2 * pillH) / 3));
    const y0 = bandTop + Math.max(0, (bandBottom - bandTop - 2 * pillH - gapPills) / 2);
    const lcx = D(m) + Math.max(shouldersW, dp) / 2, rcx = frame.w - D(m) - Math.max(shouldersW, cl) / 2;
    const cyA = y0 + D(DIM.pill.hit) / 2, cyB = y0 + pillH + gapPills + D(DIM.pill.hit) / 2;
    pill("menu", "MENU", "menu", lcx, cyA);
    pill("select", "SELECT", "minus", lcx, cyB);
    pill("start", "START", "play", rcx, cyA);
    pill("focus", ps ? "" : "FOCUS", ps ? "expand" : "swap", rcx, cyB);
    screen = { region: rect(frame.x + colW + D(g), frame.y + D(m), Math.max(0, frame.w - 2 * (colW + D(g))), frame.h - 2 * D(m)) };
  }

  // ---------- the game picture inside its region
  const r = screen.region;
  const full = fit(P.aspect, 1, r.w, r.h);                       // whole content, aspect preserved
  const place = (w, h) => rect(r.x + (r.w - w) / 2, landscape ? r.y + (r.h - h) / 2 : r.y, w, h);
  let video;
  if (platform === "nds" && view !== "both") {                   // FOCUS: one DS screen (4:3) fills the region; the video box is twice as tall, clipped
    const one = fit(4, 3, r.w, r.h);
    const box = place(one.w, one.h);
    video = rect(box.x, view === "top" ? box.y : box.y - one.h, one.w, one.h * 2);
    screen = { region: r, clip: box, video, view };
  } else if (fill && landscape) {                                // optional "stretch" (not the default: it distorts the picture)
    video = rect(r.x, r.y, r.w, r.h);
    screen = { region: r, clip: video, video, view: "both" };
  } else {
    video = place(full.w, full.h);
    screen = { region: r, clip: video, video, view: "both" };
  }
  // stylus (DS): the lower half of the whole frame; with FOCUS on the bottom screen the whole visible area
  const stylus = platform === "nds" ? (screen.view === "top" ? null : rect(screen.video.x, screen.video.y + screen.video.h / 2, screen.video.w, screen.video.h / 2)) : null;
  if (stylus && screen.view === "bottom") { stylus.x = screen.clip.x; stylus.y = screen.clip.y; stylus.w = screen.clip.w; stylus.h = screen.clip.h; }

  // hit areas: visible rect grown towards free space but never beyond the minimum comfortable size; clamped to the frame
  for (const c of controls) {
    const mw = Math.max(c.w, D(DIM.minHit)), mh = Math.max(c.type === "pill" ? D(DIM.pill.hit) : c.h, D(DIM.minHit));
    c.hit = rect(c.x - (mw - c.w) / 2, c.y - (mh - (c.type === "pill" ? D(DIM.pill.hit) : c.h)) / 2, mw, c.type === "pill" ? D(DIM.pill.hit) : mh);
  }
  return { platform, orientation: landscape ? "landscape" : "portrait", scale: s, frame, screen, stylus, controls, variant };
}

export const CONTROL_IDS = {
  nds: ["l", "r", "dpad", "actions", "menu", "select", "start", "focus"],
  ps1: ["l", "l2", "r", "r2", "dpad", "actions", "menu", "select", "start", "focus"],
};
