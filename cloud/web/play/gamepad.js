// Physical controllers (Gamepad API). One internal mapping for every pad the browser reports with the "standard" layout (Xbox style, PlayStation style, most Bluetooth pads):
// buttons are named by position, exactly like the on-screen controls, so the same table drives every core. Nothing here knows about a core.
//   standard index: 0 bottom  1 right  2 left  3 top  4 L1  5 R1  6 L2  7 R2  8 select  9 start  10 L3  11 R3  12-15 d-pad  16 home
//   PlaySphere names: b      a       y       x      l     r     l2    r2    select    start    l3     r3
export const STANDARD_MAP = Object.freeze({ 0: "b", 1: "a", 2: "y", 3: "x", 4: "l", 5: "r", 6: "l2", 7: "r2", 8: "select", 9: "start", 10: "l3", 11: "r3", 12: "up", 13: "down", 14: "left", 15: "right" });
const DEAD = 0.18, DPAD_AT = 0.55;

export class GamepadInput {
  /** Up to two controllers: the first connected pad plays player 1, the second player 2 (the sink decides what a port means; a DS ignores port 1).
   *  @param {{btn:(name:string,down:boolean,port:number)=>void, analog?:(lx:number,ly:number,rx:number,ry:number,port:number)=>void}} sink  @param {()=>boolean} analogOn */
  constructor(sink, analogOn = () => false) {
    this.sink = sink; this.analogOn = analogOn; this.state = [new Map(), new Map()]; this.raf = 0; this.on = false; this.info = null; this.infos = []; this.lastAxes = [[0, 0, 0, 0], [0, 0, 0, 0]];
    this._conn = () => this.scan(); addEventListener("gamepadconnected", this._conn); addEventListener("gamepaddisconnected", this._conn);
  }
  start() { if (this.on) return; this.on = true; this.scan(); const loop = () => { if (!this.on) return; this.poll(); this.raf = requestAnimationFrame(loop); }; this.raf = requestAnimationFrame(loop); }
  stop() { this.on = false; cancelAnimationFrame(this.raf); this.release(); removeEventListener("gamepadconnected", this._conn); removeEventListener("gamepaddisconnected", this._conn); }
  pads() { try { return [...(navigator.getGamepads ? navigator.getGamepads() : [])].filter((g) => g && g.connected).slice(0, 2); } catch { return []; } }
  scan() { const ps = this.pads(); this.infos = ps.map((p) => ({ index: p.index, id: p.id, mapping: p.mapping, buttons: p.buttons.length, axes: p.axes.length, rumble: !!p.vibrationActuator })); this.info = this.infos[0] || null; }
  release() { for (let port = 0; port < 2; port++) { for (const [n, d] of this.state[port]) if (d) this.sink.btn(n, false, port); this.state[port].clear(); if (this.sink.analog && this.lastAxes[port].some((v) => v)) this.sink.analog(0, 0, 0, 0, port); this.lastAxes[port] = [0, 0, 0, 0]; } }
  set(port, name, down) { if (!!this.state[port].get(name) !== down) { this.state[port].set(name, down); this.sink.btn(name, down, port); } }
  poll() {
    const ps = this.pads();
    for (let port = 0; port < 2; port++) {
      const p = ps[port];
      if (!p) { if (this.state[port].size || this.lastAxes[port].some((v) => v)) { for (const [n, d] of this.state[port]) if (d) this.sink.btn(n, false, port); this.state[port].clear(); if (this.sink.analog) this.sink.analog(0, 0, 0, 0, port); this.lastAxes[port] = [0, 0, 0, 0]; } continue; }
      const want = new Set();
      for (const [i, name] of Object.entries(STANDARD_MAP)) { const b = p.buttons[+i]; if (b && (b.pressed || b.value > 0.5)) want.add(name); }
      const ax = (i) => (p.axes[i] || 0), lx = ax(0), ly = ax(1), rx = ax(2), ry = ax(3);
      if (this.analogOn(port) && this.sink.analog) {
        const sc = (v) => { const a = Math.abs(v); if (a < DEAD) return 0; const n = (a - DEAD) / (1 - DEAD); return Math.round(Math.sign(v) * Math.min(1, n) * 32767); };
        const cur = [sc(lx), sc(ly), sc(rx), sc(ry)], last = this.lastAxes[port];
        if (cur.some((v, k) => v !== last[k])) { this.lastAxes[port] = cur; this.sink.analog(cur[0], cur[1], cur[2], cur[3], port); }
      } else {                                                                         // digital mode: the left stick works as a d-pad
        if (lx < -DPAD_AT) want.add("left"); if (lx > DPAD_AT) want.add("right"); if (ly < -DPAD_AT) want.add("up"); if (ly > DPAD_AT) want.add("down");
      }
      for (const n of new Set([...this.state[port].keys(), ...want])) this.set(port, n, want.has(n));
    }
  }
  /** forward core rumble to the first controller when the browser exposes an actuator (feature detection; never required) */
  rumble(strong, weak) {
    const p = this.pads()[0]; const a = p && p.vibrationActuator; if (!a || !a.playEffect) return false;
    const s = Math.min(1, strong / 65535), w = Math.min(1, weak / 65535);
    if (!s && !w) { if (a.reset) a.reset().catch(() => {}); return true; }
    a.playEffect("dual-rumble", { startDelay: 0, duration: 120, strongMagnitude: s, weakMagnitude: w }).catch(() => {}); return true;
  }
}
