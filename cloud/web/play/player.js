// Main-thread side of the in-browser DS: starts the emulator worker, wires its video to a canvas (WebGL), its audio to an AudioWorklet (worker -> worklet directly),
// and the touch controls / keyboard to its input. Everything runs on this device: no network is used for emulation.
import { createRenderer } from "./video.js";

const PAD = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11 };   // RETRO_DEVICE_ID_JOYPAD_*

export function detectCaps() {
  const c = { wasm: typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function", webgl2: false, webgl: false, audioWorklet: false, audioContext: false, indexedDB: !!self.indexedDB,
    opfs: !!(navigator.storage && navigator.storage.getDirectory), moduleWorker: false, secure: !!self.isSecureContext, crossOriginIsolated: !!self.crossOriginIsolated, sab: typeof SharedArrayBuffer === "function",
    standalone: !!(navigator.standalone || (self.matchMedia && matchMedia("(display-mode: standalone)").matches)), touch: "ontouchstart" in self || navigator.maxTouchPoints > 0,
    visibility: typeof document.hidden === "boolean", serviceWorker: "serviceWorker" in navigator };
  try { const cv = document.createElement("canvas"); c.webgl2 = !!cv.getContext("webgl2"); c.webgl = c.webgl2 || !!cv.getContext("webgl"); } catch { /* none */ }
  const AC = self.AudioContext || self.webkitAudioContext; c.audioContext = !!AC; c.audioWorklet = !!(AC && self.AudioWorkletNode && (self.isSecureContext));
  try { new Worker(URL.createObjectURL(new Blob([""], { type: "text/javascript" })), { type: "module" }).terminate(); c.moduleWorker = true; } catch { c.moduleWorker = false; }
  return c;
}

export class Player {
  /** @param {{canvas: HTMLCanvasElement, onSram?: (id:string, data:ArrayBuffer)=>void, onError?: (msg:string)=>void, onShutdown?: ()=>void}} o */
  constructor(o) {
    this.canvas = o.canvas; this.onSram = o.onSram || (() => {}); this.onError = o.onError || (() => {}); this.onShutdown = o.onShutdown || (() => {});
    this.worker = null; this.ctx = null; this.node = null; this.fallback = null; this.renderer = null; this.mask = 0; this.running = false; this.paused = false;
    this.stats = { emuFps: 0, renderFps: 0, underruns: 0, frameMsAvg: 0, frameMsMax: 0, wasmMB: 0, stalls: 0, audioFillMs: 0, drops: 0, frames: 0, audio: "none", video: "none" };
    this.lastFrame = null; this.pending = null; this.raf = 0; this.drawCount = 0; this.rt = performance.now(); this.lastRaf = 0; this.saveTimer = 0; this.samples = { sent: 0, consumed: 0 };
    this._vis = () => this.onVisibility(); this._hide = () => this.save(true);
  }

  /** Call this synchronously inside the tap handler (iOS only lets a gesture create/resume the AudioContext): everything slower happens afterwards. */
  prepare() {
    const AC = self.AudioContext || self.webkitAudioContext;
    if (AC && !this.ctx) { try { this.ctx = new AC({ latencyHint: "interactive" }); } catch { this.ctx = null; } }
    if (this.ctx && this.ctx.resume) this.ctx.resume().catch(() => {});
  }

  async start({ id, rom, system, sram }) {
    const keep = this.ctx; this.ctx = null; await this.stop(); this.ctx = keep;   // a previous game is closed first; the AudioContext made in the tap is kept
    this.prepare();
    this.renderer = createRenderer(this.canvas); this.stats.video = this.renderer.mode;
    const worker = this.worker = new Worker(new URL("./emulator.worker.js", import.meta.url), { type: "module" });
    const ready = new Promise((resolve, reject) => { this._ready = resolve; this._fail = reject; });
    worker.onmessage = (e) => this.onMsg(e.data);
    worker.onerror = (e) => { this.onError("Errore del core: " + (e.message || "caricamento")); if (this._fail) this._fail(new Error("worker")); };
    await this.setupAudio();
    worker.postMessage({ t: "init" });
    await ready;
    const started = new Promise((resolve) => { this._started = resolve; });
    const tr = [rom]; if (system) for (const b of Object.values(system)) if (b) tr.push(b); if (sram) tr.push(sram);
    worker.postMessage({ t: "start", id, rom, system, sram }, tr);
    const info = await started;
    if (this.node || this.fallback) this.sendAudioRate(info.sampleRate);
    this.running = true; this.paused = false;
    document.addEventListener("visibilitychange", this._vis); addEventListener("pagehide", this._hide);
    this.saveTimer = setInterval(() => this.save(false), 5000);
    this.raf = requestAnimationFrame((t) => this.frameLoop(t));
    return info;
  }

  async setupAudio() {
    if (!this.ctx) return;
    this.stats.audio = "none";
    try {
      if (this.ctx.audioWorklet && self.AudioWorkletNode && new URLSearchParams(location.search).get("audio") !== "sp") {   // ?audio=sp forces the fallback (tests)
        await this.ctx.audioWorklet.addModule(new URL("./audio-worklet.js", import.meta.url));
        this.node = new AudioWorkletNode(this.ctx, "dslink-audio", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { srcRate: 32768 } });
        this.node.connect(this.ctx.destination);
        this.node.port.onmessage = (e) => { const d = e.data; this.stats.underruns = d.under; this.stats.audioFillMs = d.fill / 32.768; this.samples = { sent: d.sent, consumed: d.consumed }; };
        const ch = new MessageChannel();
        this.node.port.postMessage({ port: ch.port1 }, [ch.port1]);
        this.worker.postMessage({ t: "audioPort", port: ch.port2 }, [ch.port2]);
        this.stats.audio = "worklet";
        return;
      }
    } catch { this.node = null; }
    // fallback (no AudioWorklet, e.g. plain http): a ScriptProcessor fed by messages on the main thread
    try {
      const sp = this.ctx.createScriptProcessor(2048, 0, 2), cap = 1 << 16, L = new Float32Array(cap), R = new Float32Array(cap); let w = 0, rd = 0, frac = 0, rate = 32768, under = 0, primed = false;
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => { const s = new Int16Array(e.data), n = s.length >> 1; for (let i = 0; i < n; i++) { const k = (w + i) & (cap - 1); L[k] = s[2 * i] / 32768; R[k] = s[2 * i + 1] / 32768; } w += n; if (w - rd > cap - 4096) rd = w - Math.round(rate * 0.1); };
      sp.onaudioprocess = (ev) => {
        const lo = ev.outputBuffer.getChannelData(0), ro = ev.outputBuffer.getChannelData(1), target = Math.round(rate * 0.1); if (!primed) { if (w - rd >= target) primed = true; else { lo.fill(0); ro.fill(0); return; } }
        const ratio = (rate / this.ctx.sampleRate) * (1 + Math.max(-0.004, Math.min(0.004, ((w - rd) - target) / target * 0.004)));
        for (let i = 0; i < lo.length; i++) {
          if (w - rd < 2) { lo[i] = ro[i] = 0; under++; primed = false; continue; }
          const a = rd & (cap - 1), b = (rd + 1) & (cap - 1); lo[i] = L[a] + (L[b] - L[a]) * frac; ro[i] = R[a] + (R[b] - R[a]) * frac; frac += ratio; const adv = frac | 0; frac -= adv; rd += adv;
        }
        this.stats.underruns = under; this.stats.audioFillMs = (w - rd) / (rate / 1000);
      };
      sp.connect(this.ctx.destination);
      this.fallback = { sp, setRate: (r) => { rate = r; } };
      this.worker.postMessage({ t: "audioPort", port: ch.port2 }, [ch.port2]);
      this.stats.audio = "scriptprocessor";
    } catch { this.stats.audio = "none"; }
  }
  sendAudioRate(r) { if (this.node) this.node.port.postMessage({ srcRate: r }); if (this.fallback) this.fallback.setRate(r); }

  onMsg(m) {
    switch (m.t) {
      case "ready": if (this._ready) this._ready(); break;
      case "started": if (this._started) this._started(m); break;
      case "frame": {
        if (this.pending) this.worker.postMessage({ t: "recycle", buf: this.pending.buf }, [this.pending.buf]);   // the page is behind: skipped frames go straight back
        this.pending = m; this.lastFrame = m; break;
      }
      case "stats": Object.assign(this.stats, { emuFps: m.emuFps, frameMsAvg: m.frameMsAvg, frameMsMax: m.frameMsMax, wasmMB: m.wasmBytes / 1048576, drops: m.drops, frames: m.frames }); break;
      case "sram": this.onSram(m.id, m.data); break;
      case "saved": if (this._saved && this._saved.token === m.token) this._saved.resolve(); break;
      case "error": this.onError(m.msg); if (this._fail) this._fail(new Error(m.msg)); if (this._started) this._started({ sampleRate: 32768 }); break;
      case "shutdown": this.onShutdown(); break;
    }
  }

  frameLoop(t) {
    if (!this.running) return;
    this.raf = requestAnimationFrame((x) => this.frameLoop(x));
    if (this.lastRaf && t - this.lastRaf > 50) this.stats.stalls++;
    this.lastRaf = t;
    if (this.pending && !this.paused) {
      const m = this.pending; this.pending = null;
      this.renderer.draw(m.buf, m.w, m.h); this.drawCount++;
      if (this._grab) { this._grab(new Uint8Array(m.buf).slice()); this._grab = null; }   // tests: a copy of the next picture
      this.worker.postMessage({ t: "recycle", buf: m.buf }, [m.buf]);
      m.buf = null;
    }
    if (t - this.rt >= 1000) { this.stats.renderFps = this.drawCount * 1000 / (t - this.rt); this.drawCount = 0; this.rt = t; }
  }

  grab() { return new Promise((resolve) => { this._grab = resolve; }); }

  // ---- input
  btn(k, down) { if (!(k in PAD) || !this.worker) return; this.mask = down ? (this.mask | (1 << PAD[k])) : (this.mask & ~(1 << PAD[k])); this.worker.postMessage({ t: "buttons", mask: this.mask }); }
  touch(x, y, down) { if (this.worker) this.worker.postMessage({ t: "touch", d: down ? 1 : 0, x, y }); }

  // ---- lifecycle
  onVisibility() {
    if (!this.running) return;
    if (document.hidden) { this.pause(); } else this.resume();
  }
  pause() { if (!this.running || this.paused) return; this.paused = true; this.worker.postMessage({ t: "pause" }); if (this.ctx && this.ctx.suspend) this.ctx.suspend().catch(() => {}); }
  async resume() {
    if (!this.running || !this.paused) return;
    try { if (this.ctx && this.ctx.state !== "running") await this.ctx.resume(); } catch { /* needs a gesture: the page shows a tap-to-resume hint */ }
    this.paused = false; this.worker.postMessage({ t: "resume" });
  }
  audioBlocked() { return !!(this.ctx && this.ctx.state !== "running"); }
  async unlockAudio() { try { if (this.ctx) await this.ctx.resume(); } catch { /* still blocked */ } }
  save(force) {
    if (!this.worker || !this.running) return Promise.resolve();
    return new Promise((resolve) => { const token = Math.random(); this._saved = { token, resolve }; this.worker.postMessage({ t: "save", token, force: !!force }); setTimeout(resolve, 1500); });
  }
  async stop() {
    clearInterval(this.saveTimer); cancelAnimationFrame(this.raf);
    document.removeEventListener("visibilitychange", this._vis); removeEventListener("pagehide", this._hide);
    const w = this.worker; this.worker = null; const was = this.running; this.running = false;
    if (w && was) {
      await new Promise((resolve) => { const prev = w.onmessage; w.onmessage = (e) => { if (e.data.t === "sram") this.onSram(e.data.id, e.data.data); if (e.data.t === "stopped") resolve(); else if (prev && e.data.t !== "frame") prev(e); }; w.postMessage({ t: "stop" }); setTimeout(resolve, 2000); });
    }
    if (w) w.terminate();
    if (this.node) { try { this.node.disconnect(); } catch { /* gone */ } this.node = null; }
    if (this.fallback) { try { this.fallback.sp.disconnect(); } catch { /* gone */ } this.fallback = null; }
    if (this.ctx) { try { await this.ctx.close(); } catch { /* closed */ } this.ctx = null; }
    if (this.renderer) { this.renderer.destroy(); this.renderer = null; }
    this.mask = 0; this.pending = null; this.paused = false;
  }
}
