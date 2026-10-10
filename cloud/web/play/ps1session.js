// PS1GameSession: the PlayStation CoreAdapter. It reuses the page side of the DS player (video renderer, AudioWorklet, lifecycle: background / lock screen / interruptions) and
// swaps what is core specific: the worker, the start message (disc files, BIOS, options), the pad (two pads, analog sticks), disc swap, save states and rumble.
import { Player } from "./player.js";
import { CORES } from "./coreregistry.js";
import { PAD_BITS } from "./inputprofile.js";

const STATE_FORMAT = 1;

export class PS1GameSession extends Player {
  constructor(o) {
    super({ ...o, core: CORES["pcsx-rearmed"] });
    this.masks = [0, 0]; this.axes = [[0, 0, 0, 0], [0, 0, 0, 0]]; this.analogOn = false; this.coreInfo = null; this.disc = { index: 0, count: 1 }; this.pending = new Map();
    this.onRumble = o.onRumble || (() => {}); this.onDisc = o.onDisc || (() => {});
  }
  startMessage({ id, system, sram, extra }) {
    const tr = []; if (system) for (const b of Object.values(system)) if (b) tr.push(b); if (sram) tr.push(sram);
    this.analogOn = !!extra.options.analog;
    return { msg: { t: "start", id, system, sram, files: extra.files, discs: extra.discs, options: extra.options }, transfer: tr };
  }
  /** arrives with the "started" message: core id / version, disc list, aspect */
  async start(o) {
    const info = await super.start(o);
    this.coreInfo = info.core || null; this.disc = { index: info.disc || 0, count: info.discs || 1 }; this.aspect = info.aspect || 4 / 3; this.stateSize = info.stateSize || 0; this.startLog = info.log || "";
    if (this.analogOn) this.setAnalog(true);
    return info;
  }
  btn(k, down, port = 0) {
    if (!(k in PAD_BITS) || !this.worker) return; const m = port ? 1 : 0;
    this.masks[m] = down ? (this.masks[m] | (1 << PAD_BITS[k])) : (this.masks[m] & ~(1 << PAD_BITS[k]));
    this.sendPad(m);
  }
  analog(lx, ly, rx, ry, port = 0) { this.axes[port ? 1 : 0] = [lx | 0, ly | 0, rx | 0, ry | 0]; this.sendPad(port ? 1 : 0); }
  sendPad(m) { if (this.worker) this.worker.postMessage({ t: "pad", port: m, mask: this.masks[m], lx: this.axes[m][0], ly: this.axes[m][1], rx: this.axes[m][2], ry: this.axes[m][3] }); }
  touch() { /* no stylus on a PlayStation */ }
  /** DualShock <-> digital pad: the core's own toggle (what the Analog button does on the real pad) is pressed for a few frames */
  setAnalog(on) {
    if (!this.worker) return; this.worker.postMessage({ t: "device", port: 0, analog: !!on }); if (on) this.worker.postMessage({ t: "analogToggle" });
    this.analogOn = !!on; if (!on) { this.axes[0] = [0, 0, 0, 0]; this.sendPad(0); }
  }

  // ---- disc swap through the core's disc control interface (eject, new disc, close): not a restart
  changeDisc(index) {
    return new Promise((resolve) => { if (!this.worker || index === this.disc.index || this.disc.count < 2) { resolve(false); return; } this._discWait = resolve; this.worker.postMessage({ t: "disc", index }); setTimeout(() => { if (this._discWait === resolve) { this._discWait = null; resolve(false); } }, 8000); });
  }

  // ---- save states (NOT the game's memory card): stamped with the core id, version and state format; an incompatible one is refused, never loaded silently
  saveState() {
    return new Promise((resolve) => {
      const token = Math.random(); this.pending.set(token, resolve); this.worker.postMessage({ t: "stateSave", slot: 0, token });
      setTimeout(() => { if (this.pending.delete(token)) resolve({ error: "timeout" }); }, 8000);
    });
  }
  /** @returns {Promise<{ok:boolean, error?:string}>} */
  loadState(data, meta) {
    const c = this.coreInfo;
    if (!meta || meta.core !== (c && c.id) || meta.coreVersion !== (c && c.version) || meta.stateFormat !== (c && c.stateFormat) || data.byteLength !== this.stateSize) return Promise.resolve({ ok: false, error: "incompatible" });
    return new Promise((resolve) => {
      const token = Math.random(); this.pending.set(token, resolve); this.worker.postMessage({ t: "stateLoad", data, token }, [data]);
      setTimeout(() => { if (this.pending.delete(token)) resolve({ ok: false, error: "timeout" }); }, 8000);
    });
  }

  onExtraMsg(m) {
    if (m.t === "rumble") this.onRumble(m.strong, m.weak);
    else if (m.t === "disc") { this.disc = { index: m.index, count: m.count }; this.onDisc(this.disc); if (this._discWait) { const r = this._discWait; this._discWait = null; r(true); } }
    else if (m.t === "state" || m.t === "stateLoaded") { const r = this.pending.get(m.token); if (r) { this.pending.delete(m.token); r(m.t === "stateLoaded" ? { ok: m.ok } : m); } }
  }
  get stats() { const s = super.stats, ws = this.workerStats || {}; return { ...s, core: this.coreInfo, ps1: ws.ps1 || null, aspect: this.aspect }; }
}
export { STATE_FORMAT };

/** Import: ask the PlayStation core what the given disc files are (a short-lived worker; nothing starts). Resolves {file: {ok, serial, boot, volume, format, error?}}. */
export function probeDiscs(files, probeNames) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./ps1.worker.js", import.meta.url), { type: "module" }), token = Math.random();
    const done = (fn, v) => { clearTimeout(to); w.terminate(); fn(v); };
    const to = setTimeout(() => done(reject, new Error("Il core PlayStation non risponde.")), 60000);
    w.onerror = (e) => done(reject, new Error("Errore del core: " + (e.message || "caricamento")));
    w.onmessage = (e) => {
      const m = e.data;
      if (m.t === "ready") w.postMessage({ t: "probe", files: files.map((f) => ({ name: f.name, blob: f.blob })), probe: probeNames, token });
      else if (m.t === "probed" && m.token === token) done(resolve, m.result);
      else if (m.t === "error") done(reject, new Error(m.msg));
    };
    w.postMessage({ t: "init" });
  });
}
