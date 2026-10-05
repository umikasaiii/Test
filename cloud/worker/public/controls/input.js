// DSLink touch controls — INPUT LOGIC (pointer events -> button states). No geometry decisions: it only reads the layout rectangles.
// Multi-touch: every pointer is tracked independently. Release is guaranteed on pointerup / pointercancel / blur / page hide / relayout.

const inRect = (r, x, y) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
const DIRS = ["up", "down", "left", "right"];

export class InputRouter {
  /** @param sink {btn(name,down), stylus(nx,ny,down,move), ui(name)}   @param onVisual (id, name, down) -> void */
  constructor({ sink, onVisual = () => {}, haptics = () => false }) {
    this.sink = sink; this.onVisual = onVisual; this.haptics = haptics;
    this.layout = null; this.ptr = new Map(); this.held = new Map();    // held: button name -> number of pointers holding it
    this.origin = { x: 0, y: 0 };
  }
  setLayout(layout, origin) { this.releaseAll(); this.layout = layout; this.origin = origin; }

  _press(name, owner, visual) {
    const n = (this.held.get(name) || 0) + 1; this.held.set(name, n);
    if (n === 1) { this.sink.btn(name, true); if (this.haptics()) navigator.vibrate?.(7); }
    this.onVisual(visual.id, visual.sub, true);
  }
  _release(name, visual) {
    const n = (this.held.get(name) || 0) - 1;
    if (n <= 0) { this.held.delete(name); this.sink.btn(name, false); } else this.held.set(name, n);
    this.onVisual(visual.id, visual.sub, false);
  }
  _setSet(p, next) {                           // p.pressed: Map name -> visual ; make it equal to `next` (Map)
    for (const [name, vis] of [...p.pressed]) if (!next.has(name)) { this._release(name, vis); p.pressed.delete(name); }
    for (const [name, vis] of next) if (!p.pressed.has(name)) { this._press(name, p, vis); p.pressed.set(name, vis); }
  }

  _hit(x, y) {
    let best = null, area = Infinity;
    for (const c of this.layout.controls) if (inRect(c.hit, x, y)) { const a = c.hit.w * c.hit.h; if (a < area) { best = c; area = a; } }
    return best;
  }
  _dpadDirs(c, x, y) {
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2, r = c.w / 2;
    const dx = (x - cx) / r, dy = (y - cy) / r, dead = 0.2, d = new Map();
    if (Math.hypot(dx, dy) < dead * 0.6) return d;
    if (dx > dead) d.set("right", { id: c.id, sub: "right" }); else if (dx < -dead) d.set("left", { id: c.id, sub: "left" });
    if (dy > dead) d.set("down", { id: c.id, sub: "down" }); else if (dy < -dead) d.set("up", { id: c.id, sub: "up" });
    // a thumb resting near an axis should not produce accidental diagonals: need clear offset on both axes
    if (d.size === 2 && Math.min(Math.abs(dx), Math.abs(dy)) < dead * 1.4) { const keep = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up"); for (const k of DIRS) if (k !== keep) d.delete(k); }
    return d;
  }
  _faces(c, x, y) {
    const cx = c.x + c.w / 2, cy = c.y + c.h / 2, off = c.w * 0.34, out = new Map();
    const centres = { x: [cx, cy - off], a: [cx + off, cy], b: [cx, cy + off], y: [cx - off, cy] };
    const dist = Object.entries(centres).map(([id, [px, py]]) => [id, Math.hypot(x - px, y - py)]).sort((a, b) => a[1] - b[1]);
    const reach = c.w * 0.34;                                        // finger must be reasonably near a button
    if (dist[0][1] > reach) return out;
    out.set(dist[0][0], { id: c.id, sub: dist[0][0] });
    if (dist[1][1] <= Math.max(reach * 0.62, dist[0][1] * 1.35) && dist[1][1] < off * 0.95) out.set(dist[1][0], { id: c.id, sub: dist[1][0] });   // between two buttons: both (A+B style chords)
    return out;
  }

  down(e) {
    if (!this.layout) return;
    const x = e.clientX - this.origin.x, y = e.clientY - this.origin.y;
    const c = this._hit(x, y);
    const p = { kind: null, ctl: c, pressed: new Map(), stylus: false };
    if (c) {
      p.kind = c.type;
      if (c.type === "dpad") this._setSet(p, this._dpadDirs(c, x, y));
      else if (c.type === "cluster") this._setSet(p, this._faces(c, x, y));
      else if (c.type === "pill" && (c.id === "menu" || c.id === "focus")) { p.ui = c.id; this.onVisual(c.id, null, true); }
      else this._setSet(p, new Map([[c.id, { id: c.id, sub: null }]]));
    } else if (this.layout.stylus && inRect(this.layout.stylus, x, y)) {
      p.kind = "stylus"; p.stylus = true; this._stylus(x, y, false, true); this._stylus(x, y, true, false);
    } else return false;
    this.ptr.set(e.pointerId, p);
    return true;
  }
  move(e) {
    const p = this.ptr.get(e.pointerId); if (!p) return;
    const x = e.clientX - this.origin.x, y = e.clientY - this.origin.y;
    if (p.kind === "dpad") this._setSet(p, this._dpadDirs(p.ctl, x, y));
    else if (p.kind === "cluster") this._setSet(p, this._faces(p.ctl, x, y));
    else if (p.kind === "stylus") this._stylus(x, y, true, true);
  }
  up(e) {
    const p = this.ptr.get(e.pointerId); if (!p) return;
    this.ptr.delete(e.pointerId);
    if (p.ui) { this.onVisual(p.ui, null, false); const c = p.ctl, x = e.clientX - this.origin.x, y = e.clientY - this.origin.y; if (e.type !== "pointercancel" && inRect(c.hit, x, y)) this.sink.ui(p.ui); return; }
    if (p.stylus) { const x = e.clientX - this.origin.x, y = e.clientY - this.origin.y; this._stylus(x, y, false, false); return; }
    this._setSet(p, new Map());
  }
  _stylus(x, y, down, move) {
    const r = this.layout.stylus;
    const nx = Math.min(1, Math.max(0, (x - r.x) / r.w)), ny = Math.min(1, Math.max(0, (y - r.y) / r.h));
    // map the stylus rectangle onto the lower half of the whole frame (x: 0..1, y: 0.5..1)
    const fy = 0.5 + ny * 0.5;
    this.sink.stylus(nx, fy, down, move);
  }
  releaseAll() {
    for (const [id, p] of [...this.ptr]) { this.ptr.delete(id); if (p.ui) this.onVisual(p.ui, null, false); else if (p.stylus) this.sink.stylus(0.5, 0.75, false, false); else this._setSet(p, new Map()); }
    for (const name of [...this.held.keys()]) { this.sink.btn(name, false); }
    this.held.clear();
  }
}
