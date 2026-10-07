// Main-thread side of the in-browser DS: starts the emulator worker, wires its video to a canvas (WebGL) through a small FIFO, its audio to an AudioWorklet (worker -> worklet
// directly, SharedArrayBuffer ring only when the page is cross-origin isolated), and the touch controls / keyboard to its input. It also keeps the whole thing sane when the page
// goes to the background, the screen locks, a call interrupts the audio or the page comes back from the back/forward cache. Everything runs on this device: no network.
import { createRenderer } from "./video.js";
import { AudioRing } from "./audio-worklet.js";
import { opt } from "./options.js";
import { createSharedRadio, RadioRxProducer, epochMs } from "./radio-ring.js";

const PAD = { b: 0, y: 1, select: 2, start: 3, up: 4, down: 5, left: 6, right: 7, a: 8, x: 9, l: 10, r: 11 };   // RETRO_DEVICE_ID_JOYPAD_*
const QUEUE_MAX = 3;                                                                                              // pictures waiting for a vsync before the oldest are dropped

export function detectCaps() {
  const c = { wasm: typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function", webgl2: false, webgl: false, audioWorklet: false, audioContext: false, indexedDB: !!self.indexedDB,
    opfs: !!(navigator.storage && navigator.storage.getDirectory), moduleWorker: false, secure: !!self.isSecureContext, crossOriginIsolated: !!self.crossOriginIsolated, sab: typeof SharedArrayBuffer === "function",
    standalone: !!(navigator.standalone || (self.matchMedia && matchMedia("(display-mode: standalone)").matches)), touch: "ontouchstart" in self || navigator.maxTouchPoints > 0,
    visibility: typeof document.hidden === "boolean", serviceWorker: "serviceWorker" in navigator, wakeLock: !!(navigator.wakeLock && navigator.wakeLock.request), offscreenCanvas: typeof OffscreenCanvas === "function" };
  try { const cv = document.createElement("canvas"); c.webgl2 = !!cv.getContext("webgl2"); c.webgl = c.webgl2 || !!cv.getContext("webgl"); } catch { /* none */ }
  const AC = self.AudioContext || self.webkitAudioContext; c.audioContext = !!AC; c.audioWorklet = !!(AC && self.AudioWorkletNode && self.isSecureContext);
  try { new Worker(URL.createObjectURL(new Blob([""], { type: "text/javascript" })), { type: "module" }).terminate(); c.moduleWorker = true; } catch { c.moduleWorker = false; }
  return c;
}

export class Player {
  /** @param {{canvas: HTMLCanvasElement, onSram?: (id:string, data:ArrayBuffer)=>void, onError?: (msg:string)=>void, onShutdown?: ()=>void, onNeedGesture?: ()=>void, onResumed?: ()=>void}} o */
  constructor(o) {
    this.canvas = o.canvas; this.onSram = o.onSram || (() => {}); this.onError = o.onError || (() => {}); this.onShutdown = o.onShutdown || (() => {});
    this.onNeedGesture = o.onNeedGesture || (() => {}); this.onResumed = o.onResumed || (() => {});
    this.worker = null; this.ctx = null; this.node = null; this.ring = null; this.sp = null; this.renderer = null; this.mask = 0; this.running = false; this.paused = false; this.pauseReason = "";
    this.audioBackend = "none"; this.audioMetrics = null; this.workerStats = null; this.wake = null;
    this.queue = []; this.raf = 0; this.lastRaf = 0; this.saveTimer = 0; this._grab = null; this.lifecycle = { hidden: 0, shown: 0, pagehide: 0, pageshow: 0, audioInterrupt: 0, resumes: 0, lastResumeMs: 0 };
    this.v = { received: 0, rendered: 0, droppedRender: 0, win: { frames: 0, t: performance.now(), mainMsSum: 0, mainMsMax: 0 }, renderFps: 0, mainFrameMsAvg: 0, mainFrameMsMax: 0, stalls: 0, longTasks: 0 };
    this._vis = () => this.onVisibility(); this._hide = () => this.onPageHide(); this._show = (e) => this.onPageShow(e); this._state = () => this.onCtxState();
  }

  /** Call this synchronously inside the tap handler (iOS only lets a gesture create/resume the AudioContext): everything slower happens afterwards. */
  prepare() {
    try { if (navigator.audioSession) navigator.audioSession.type = "playback"; } catch { /* iOS 17+: let the game sound play even with the silent switch on */ }
    const AC = self.AudioContext || self.webkitAudioContext;
    if (AC && !this.ctx) {
      const lh = opt("latency", ""); const hint = lh && !isNaN(+lh) ? +lh : (lh || "interactive");
      try { this.ctx = new AC({ latencyHint: hint }); } catch { try { this.ctx = new AC(); } catch { this.ctx = null; } }
    }
    if (this.ctx && this.ctx.resume) this.ctx.resume().catch(() => {});
  }

  async start({ id, rom, system, sram, radio }) {
    const keep = this.ctx; this.ctx = null; await this.stop(); this.ctx = keep;       // a previous game is closed first; the AudioContext made in the tap is kept
    this.prepare();
    const worker = this.worker = new Worker(new URL("./emulator.worker.js", import.meta.url), { type: "module" });
    const ready = new Promise((resolve, reject) => { this._ready = resolve; this._fail = reject; });
    worker.onmessage = (e) => this.onMsg(e.data);
    worker.onerror = (e) => { this.onError("Errore del core: " + (e.message || "caricamento")); if (this._fail) this._fail(new Error("worker")); };
    await this.setupVideo();
    await this.setupAudio();
    worker.postMessage({ t: "init" });
    await ready;
    const started = new Promise((resolve) => { this._started = resolve; });
    const tr = [rom]; if (system) for (const b of Object.values(system)) if (b) tr.push(b); if (sram) tr.push(sram);
    const rcfg = this.setupRadio(radio);
    worker.postMessage({ t: "start", id, rom, system, sram, radio: rcfg }, tr);
    const info = await started;
    if (radio) this.radioOpen(radio.peer.state === "open" || radio.peer.state === "degraded" ? 1 : 0);
    this.srcRate = info.sampleRate; this.sendAudioRate(info.sampleRate);
    this.running = true; this.paused = false; this.pauseReason = "";
    document.addEventListener("visibilitychange", this._vis); addEventListener("pagehide", this._hide); addEventListener("pageshow", this._show);
    if (this.ctx && this.ctx.addEventListener) this.ctx.addEventListener("statechange", this._state);
    this.saveTimer = setInterval(() => this.save(false), 5000);
    this.observeLongTasks(); this.acquireWake();
    this.raf = requestAnimationFrame((t) => this.frameLoop(t));
    return info;
  }

  // ------------------------------------------------------------------ radio (Distributed): the RTCDataChannel lives on this thread (Safari has no RTCPeerConnection in workers); the core's frames cross to it by postMessage,
  // the other console's frames come back through a SharedArrayBuffer ring when the page is isolated (a game that waits for replies inside a frame needs this) or through the worker's message queue.
  setupRadio(radio) {
    this.radio = null; this.radioProducer = null;
    if (!radio) return null;
    const peer = radio.peer, forced = opt("radioring", "auto");
    const shared = self.crossOriginIsolated && typeof SharedArrayBuffer === "function" && forced !== "msg" ? createSharedRadio() : null;
    this.radio = { role: radio.role, peer, mode: shared ? "sab" : "msg", pushed: 0, droppedPaused: 0 };
    if (shared) this.radioProducer = new RadioRxProducer(shared);
    peer.o.onFrame = (dest, src, payload, at) => this.radioPush(dest, src, payload, at);
    peer.o.onState = ((prev) => (s, why) => { if (prev) prev(s, why); if (this.radio) this.radioOpen(s === "open" || s === "degraded" ? 1 : s === "connecting" || s === "new" ? 0 : 2); })(peer.o.onState);
    return { role: radio.role, shared };
  }
  radioOpen(state) {
    if (!this.radio) return;
    if (this.radioProducer) this.radioProducer.setState(state); else if (this.worker) this.worker.postMessage({ t: "radioState", state });
  }
  radioPush(dest, src, payload, at) {
    const r = this.radio; if (!r || !this.worker) return;
    if (this.paused) { r.droppedPaused++; return; }                                    // a console that is not running never builds a backlog
    r.pushed++;
    if (this.radioProducer) this.radioProducer.push(dest, src, payload, at ? performance.timeOrigin + at : epochMs());
    else { const b = new Uint8Array(4 + payload.length); b[0] = dest & 255; b[1] = dest >> 8; b[2] = src & 255; b[3] = src >> 8; b.set(payload, 4); const buf = b.buffer;   // same record the ring holds: [dest u16][src u16][frame]
      this.worker.postMessage({ t: "radioRx", buf, at: at ? performance.timeOrigin + at : epochMs() }, [buf]); }
  }
  radioFlush() { if (!this.radio) return; if (this.radioProducer) this.radioProducer.flush(); else if (this.worker) this.worker.postMessage({ t: "radioFlush" }); }

  // ------------------------------------------------------------------ video: main-thread renderer (default, verified everywhere) or an OffscreenCanvas render worker (optional, automatic fallback)
  async setupVideo() {
    this.renderMode = "main"; this.rw = null; this.rwMetrics = null;
    const want = opt("render", "auto");                                               // "worker" | "main" | "auto" (= main until the worker path is proven on the target devices)
    if (want === "worker" && typeof OffscreenCanvas === "function" && this.canvas.transferControlToOffscreen) {
      try { if (await this.setupRenderWorker()) return; } catch { /* fall back */ }
    }
    this.renderer = createRenderer(this.canvas); this.videoMode = this.renderer.mode;
  }
  async setupRenderWorker() {
    const w = new Worker(new URL("./render-worker.js", import.meta.url), { type: "module" });
    const probe = await new Promise((resolve) => { const to = setTimeout(() => resolve({ ok: false, why: "timeout" }), 4000); w.onmessage = (e) => { if (e.data.t === "probe") { clearTimeout(to); resolve(e.data); } }; w.onerror = () => { clearTimeout(to); resolve({ ok: false, why: "load" }); }; w.postMessage({ t: "probe" }); });
    if (!probe.ok) { w.terminate(); this.renderFallbackWhy = probe.why; return false; }
    const rect = this.canvas.getBoundingClientRect(), dpr = Math.min(2, self.devicePixelRatio || 1), ch = new MessageChannel();
    const off = this.canvas.transferControlToOffscreen();                              // irreversible: only done after the worker proved WebGL works
    this.rw = w; this.renderMode = "worker";
    w.onmessage = (e) => { const d = e.data; if (d.t === "metrics") { this.rwMetrics = d; this.videoMode = d.mode + "/worker"; } else if (d.t === "grab" && this._grab) { this._grab(new Uint8Array(d.data)); this._grab = null; } else if (d.t === "error") this.onError("Render: " + d.msg); };
    await new Promise((resolve) => { const prev = w.onmessage; w.onmessage = (e) => { if (e.data.t === "ready") { this.videoMode = e.data.mode + "/worker"; w.onmessage = prev; resolve(); } else prev(e); }; w.postMessage({ t: "init", canvas: off, port: ch.port2, w: rect.width, h: rect.height, dpr }, [off, ch.port2]); });
    this.worker.postMessage({ t: "videoPort", port: ch.port1 }, [ch.port1]);
    this._rwRo = typeof ResizeObserver !== "undefined" ? new ResizeObserver((es) => { const r = es[0].contentRect; this.rw && this.rw.postMessage({ t: "size", w: r.width, h: r.height, dpr: Math.min(2, self.devicePixelRatio || 1) }); }) : null;
    if (this._rwRo) this._rwRo.observe(this.canvas);
    return true;
  }

  // ------------------------------------------------------------------ audio
  async setupAudio() {
    if (!this.ctx) return;
    const forced = opt("audio", "auto");                                                 // "sp" / "msg": tests and A/B on a device
    try {
      if (this.ctx.audioWorklet && self.AudioWorkletNode && forced !== "sp") {
        await this.ctx.audioWorklet.addModule(new URL("./audio-worklet.js", import.meta.url));
        this.node = new AudioWorkletNode(this.ctx, "dslink-audio", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { srcRate: 32768 } });
        this.node.connect(this.ctx.destination);
        this.node.port.onmessage = (e) => { this.audioMetrics = e.data; };
        if (self.crossOriginIsolated && typeof SharedArrayBuffer === "function" && forced !== "msg") {   // lock-free ring shared with the worker (only on isolated pages)
          const cap = 1 << 15, data = new SharedArrayBuffer(cap * 4), ctrl = new SharedArrayBuffer(16);
          this.node.port.postMessage({ sab: { data, ctrl, cap } });
          this.worker.postMessage({ t: "audioSab", data, ctrl, cap });
          this.audioBackend = "worklet-sab";
        } else {                                                                       // default: worker -> worklet MessagePort, buffers recycled, no SharedArrayBuffer needed
          const ch = new MessageChannel();
          this.node.port.postMessage({ port: ch.port1 }, [ch.port1]);
          this.worker.postMessage({ t: "audioPort", port: ch.port2 }, [ch.port2]);
          this.audioBackend = "worklet-msg";
        }
        return;
      }
    } catch { this.node = null; }
    try {                                                                              // fallback (no AudioWorklet, e.g. plain http): the same ring, pulled by a ScriptProcessor
      const sp = this.ctx.createScriptProcessor(2048, 0, 2);
      this.ring = new AudioRing({ srcRate: 32768, outRate: this.ctx.sampleRate, startMs: 140, minMs: 100, now: () => this.ctx.currentTime });
      this.ring.m.backend = "scriptprocessor";
      const ch = new MessageChannel(); let freeBack = [];
      ch.port1.onmessage = (e) => {
        const d = e.data; this.ring.push(new Int16Array(d.b, 0, d.n * 2), d.n); freeBack.push(d.b);
        if (freeBack.length >= 6) { const f = freeBack; freeBack = []; ch.port1.postMessage(f, f); }
      };
      sp.onaudioprocess = (ev) => { const o = ev.outputBuffer; this.ring.render(o.getChannelData(0), o.getChannelData(1), o.length); };
      sp.connect(this.ctx.destination); this.sp = sp;
      this.worker.postMessage({ t: "audioPort", port: ch.port2 }, [ch.port2]);
      this.audioBackend = "scriptprocessor";
    } catch { this.audioBackend = "none"; }
  }
  sendAudioRate(r) { if (this.node) this.node.port.postMessage({ srcRate: r }); if (this.ring) this.ring.setRates(r, 0); }
  flushAudio() { if (this.node) this.node.port.postMessage({ flush: true }); if (this.ring) this.ring.reset(); }
  audioStats() {
    const m = this.ring ? this.ring.metrics() : this.audioMetrics, c = this.ctx;
    return { ...(m || {}), backend: this.audioBackend, ctxState: c ? c.state : "none", ctxRate: c ? c.sampleRate : 0, baseLatencyMs: c && c.baseLatency ? c.baseLatency * 1000 : 0, outputLatencyMs: c && c.outputLatency ? c.outputLatency * 1000 : 0 };
  }

  // ------------------------------------------------------------------ messages from the worker
  onMsg(m) {
    switch (m.t) {
      case "ready": if (this._ready) this._ready(); break;
      case "started": if (this._started) this._started(m); break;
      case "frame": {
        this.v.received++;
        if (this.paused) { this.recycle(m.buf); break; }
        this.queue.push(m);
        while (this.queue.length > QUEUE_MAX) { const d = this.queue.shift(); this.v.droppedRender++; this.recycle(d.buf); }   // bounded latency: the page is behind, the oldest picture goes
        break;
      }
      case "radioTx": if (this.radio) this.radio.peer.sendFrame(m.dest, m.src, new Uint8Array(m.buf)); break;
      case "stats": this.workerStats = m; break;
      case "sram": this.onSram(m.id, m.data); break;
      case "saved": if (this._saved && this._saved.token === m.token) this._saved.resolve(); break;
      case "pong": if (this._pong && this._pong.token === m.token) this._pong.resolve(true); break;
      case "error": this.onError(m.msg); if (this._fail) this._fail(new Error(m.msg)); if (this._started) this._started({ sampleRate: 32768 }); break;
      case "shutdown": this.onShutdown(); break;
    }
  }
  recycle(buf) { if (buf && this.worker) this.worker.postMessage({ t: "recycle", buf }, [buf]); }

  // ------------------------------------------------------------------ render loop (never drives the emulation)
  frameLoop(t) {
    if (!this.running) return;
    this.raf = requestAnimationFrame((x) => this.frameLoop(x));
    const v = this.v, w = v.win;
    if (this.lastRaf && t - this.lastRaf > 50) v.stalls++;
    this.lastRaf = t;
    if (this.renderer && this.queue.length && !this.paused) {
      const t0 = performance.now(), f = this.queue.shift();
      const px = new Uint8Array(f.buf);
      this.renderer.draw(px, f.w, f.h); v.rendered++; w.frames++;
      if (this._grab) { const g = new Uint8Array(px.length); for (let i = 0; i < px.length; i += 4) { g[i] = px[i + 2]; g[i + 1] = px[i + 1]; g[i + 2] = px[i]; g[i + 3] = 255; } this._grab(g); this._grab = null; }   // tests: the next picture as RGBA
      this.recycle(f.buf);
      const ms = performance.now() - t0; w.mainMsSum += ms; if (ms > w.mainMsMax) w.mainMsMax = ms;
    }
    if (this.renderer && t - w.t >= 1000) {
      const rm = this.renderer.metrics;
      v.renderFps = w.frames * 1000 / (t - w.t); v.mainFrameMsAvg = w.frames ? w.mainMsSum / w.frames : 0; v.mainFrameMsMax = w.mainMsMax;
      v.uploadMsAvg = rm.frames ? rm.uploadMsSum / rm.frames : 0; v.uploadMsMax = rm.uploadMsMax; v.drawMsAvg = rm.frames ? rm.drawMsSum / rm.frames : 0; v.drawMsMax = rm.drawMsMax;
      this.renderer.resetWindow(); w.frames = 0; w.t = t; w.mainMsSum = 0; w.mainMsMax = 0;
    }
  }
  observeLongTasks() {
    try { if (self.PerformanceObserver && PerformanceObserver.supportedEntryTypes && PerformanceObserver.supportedEntryTypes.includes("longtask")) { this._lt = new PerformanceObserver((l) => { this.v.longTasks += l.getEntries().length; }); this._lt.observe({ entryTypes: ["longtask"] }); } } catch { /* not supported */ }
  }

  /** everything the overlay and the tests read, in one object (numbers only, no allocation of frames) */
  get stats() {
    const ws = this.workerStats || {}, a = this.audioStats(), rwm = this.rwMetrics;
    const v = rwm ? { received: rwm.received, rendered: rwm.rendered, droppedRender: rwm.droppedRender, renderFps: rwm.renderFps, mainFrameMsAvg: rwm.mainFrameMsAvg, mainFrameMsMax: rwm.mainFrameMsMax, uploadMsAvg: rwm.uploadMsAvg, uploadMsMax: rwm.uploadMsMax, drawMsAvg: rwm.drawMsAvg, drawMsMax: rwm.drawMsMax, stalls: this.v.stalls, longTasks: this.v.longTasks } : this.v;
    return { video: this.videoMode, renderMode: this.renderMode, renderFallback: this.renderFallbackWhy || "", emuFps: ws.emuFps || 0, frameMsAvg: ws.frameMsAvg || 0, frameMsMax: ws.frameMsMax || 0, tickLateAvgMs: ws.tickLateAvgMs || 0, tickLateMaxMs: ws.tickLateMaxMs || 0,
      submitted: ws.submitted || 0, droppedAtSource: ws.droppedAtSource || 0, frames: ws.frames || 0, received: v.received, rendered: v.rendered, droppedRender: v.droppedRender,
      renderFps: v.renderFps, mainFrameMsAvg: v.mainFrameMsAvg, mainFrameMsMax: v.mainFrameMsMax, uploadMsAvg: v.uploadMsAvg || 0, uploadMsMax: v.uploadMsMax || 0, drawMsAvg: v.drawMsAvg || 0, drawMsMax: v.drawMsMax || 0,
      stalls: v.stalls, longTasks: v.longTasks, wasmMB: (ws.wasmBytes || 0) / 1048576, queued: rwm ? rwm.queued : this.queue.length, audio: a, audioSourceDropped: ws.audioDropped || 0, audioFramesProduced: ws.audioFrames || 0,
      radio: this.radio ? { mode: this.radio.mode, role: this.radio.role, pushed: this.radio.pushed, droppedPaused: this.radio.droppedPaused, ringDropped: this.radioProducer ? this.radioProducer.dropped : 0, ringFill: this.radioProducer ? this.radioProducer.fillBytes : 0, core: ws.radio || null, peer: this.radio.peer.metrics() } : null,
      lifecycle: { ...this.lifecycle, paused: this.paused, reason: this.pauseReason }, underruns: a.underEvents || 0 };
  }

  grab() { return new Promise((resolve) => { this._grab = resolve; if (this.rw) this.rw.postMessage({ t: "grab" }); }); }

  // ------------------------------------------------------------------ input
  btn(k, down) { if (!(k in PAD) || !this.worker) return; this.mask = down ? (this.mask | (1 << PAD[k])) : (this.mask & ~(1 << PAD[k])); this.worker.postMessage({ t: "buttons", mask: this.mask }); }
  touch(x, y, down) { if (this.worker) this.worker.postMessage({ t: "touch", d: down ? 1 : 0, x, y }); }

  // ------------------------------------------------------------------ lifecycle: background, lock screen, interruptions, back/forward cache
  onVisibility() {
    if (!this.running) return;
    if (document.hidden) { this.lifecycle.hidden++; this.pauseAll("hidden"); } else { this.lifecycle.shown++; this.resumeAll("visible"); }
  }
  onPageHide() { if (!this.running) return; this.lifecycle.pagehide++; this.save(true); this.pauseAll("pagehide"); }
  async onPageShow(e) {
    if (!this.running) return; this.lifecycle.pageshow++;
    if (e && e.persisted) {                                                            // back from the back/forward cache: is the worker still alive?
      const alive = await new Promise((resolve) => { const token = Math.random(); this._pong = { token, resolve }; try { this.worker.postMessage({ t: "ping", token }); } catch { resolve(false); } setTimeout(() => resolve(false), 1500); });
      if (!alive) { this.onError("La sessione è stata interrotta dal browser. Il salvataggio è al sicuro."); return; }
    }
    this.resumeAll("pageshow");
  }
  onCtxState() {
    if (!this.running || !this.ctx) return;
    const s = this.ctx.state;                                                          // "interrupted" (iOS call/Siri/alarm), "suspended", "running"
    if ((s === "interrupted" || s === "suspended") && !this.paused && !document.hidden) { this.lifecycle.audioInterrupt++; this.pauseAll("audio"); this.onNeedGesture(); }
    else if (s === "running" && this.paused && this.pauseReason === "audio") this.resumeAll("audio-back");
  }
  pauseAll(reason) {
    if (!this.running) return;
    this.pauseReason = reason; if (this.paused) return; this.paused = true;
    this.worker.postMessage({ t: "pause" });
    if (this.radio) this.radio.peer.sendCtl({ t: "vis", hidden: true });                // tell the other player, so a silent peer is not mistaken for a lost one
    for (const f of this.queue) this.recycle(f.buf); this.queue.length = 0; if (this.rw) this.rw.postMessage({ t: "pause" });
    if (this.ctx && this.ctx.suspend && reason !== "audio") this.ctx.suspend().catch(() => {});
    this.releaseWake();
  }
  async resumeAll(reason) {
    if (!this.running || !this.paused || this._resuming) return;
    this._resuming = true; try { await this.doResume(reason); } finally { this._resuming = false; }
  }
  async doResume(reason) {
    const t0 = performance.now(); this.lifecycle.resumes++;
    try { if (this.ctx && this.ctx.state !== "running") await Promise.race([this.ctx.resume(), new Promise((r) => setTimeout(r, 900))]); } catch { /* needs a gesture */ }
    if (this.ctx && this.ctx.state !== "running") { this.pauseReason = "audio"; this.onNeedGesture(); return; }   // iOS: a tap is needed; the game stays paused (clean), the page shows RIPRENDI
    this.flushAudio();                                                                 // stale audio from before the pause is not played
    this.radioFlush(); if (this.radio) this.radio.peer.sendCtl({ t: "vis", hidden: false });   // brief resync: no radio backlog from before the pause
    this.paused = false; this.pauseReason = ""; if (this.rw) this.rw.postMessage({ t: "resume" }); this.worker.postMessage({ t: "resume" });
    this.lifecycle.lastResumeMs = performance.now() - t0; this.acquireWake(); this.onResumed();
  }
  audioBlocked() { return !!(this.ctx && this.ctx.state !== "running") || this.pauseReason === "audio"; }
  async unlockAudio() { try { if (this.ctx) await this.ctx.resume(); } catch { /* still blocked */ } if (this.paused && this.pauseReason === "audio") this.resumeAll("tap"); }
  async resume() { if (this.paused) await this.resumeAll("manual"); }
  async acquireWake() { try { if (navigator.wakeLock && !this.wake && !document.hidden) { this.wake = await navigator.wakeLock.request("screen"); this.wake.addEventListener("release", () => { this.wake = null; }); } } catch { this.wake = null; } }
  releaseWake() { try { if (this.wake) this.wake.release(); } catch { /* gone */ } this.wake = null; }

  save(force) {
    if (!this.worker || !this.running) return Promise.resolve();
    return new Promise((resolve) => { const token = Math.random(); this._saved = { token, resolve }; this.worker.postMessage({ t: "save", token, force: !!force }); setTimeout(resolve, 1500); });
  }
  async stop() {
    clearInterval(this.saveTimer); cancelAnimationFrame(this.raf); this.releaseWake(); if (this._lt) { try { this._lt.disconnect(); } catch { /* gone */ } this._lt = null; }
    document.removeEventListener("visibilitychange", this._vis); removeEventListener("pagehide", this._hide); removeEventListener("pageshow", this._show);
    if (this.ctx && this.ctx.removeEventListener) this.ctx.removeEventListener("statechange", this._state);
    const w = this.worker; this.worker = null; const was = this.running; this.running = false;
    if (w && was) {
      await new Promise((resolve) => { const prev = w.onmessage; w.onmessage = (e) => { if (e.data.t === "sram") this.onSram(e.data.id, e.data.data); if (e.data.t === "stopped") resolve(); else if (prev && e.data.t !== "frame") prev(e); }; w.postMessage({ t: "stop" }); setTimeout(resolve, 2000); });
    }
    if (w) w.terminate();
    if (this.node) { try { this.node.disconnect(); } catch { /* gone */ } this.node = null; }
    if (this.sp) { try { this.sp.disconnect(); } catch { /* gone */ } this.sp = null; }
    if (this.ctx) { try { await this.ctx.close(); } catch { /* closed */ } this.ctx = null; }
    if (this.renderer) { this.renderer.destroy(); this.renderer = null; }
    if (this._rwRo) { this._rwRo.disconnect(); this._rwRo = null; } if (this.rw) { this.rw.terminate(); this.rw = null; } this.rwMetrics = null;
    if (this.radio) { this.radioOpen(2); this.radio = null; this.radioProducer = null; }
    this.mask = 0; this.queue.length = 0; this.paused = false; this.pauseReason = ""; this.ring = null; this.audioMetrics = null; this.workerStats = null; this.audioBackend = "none";
  }
}
