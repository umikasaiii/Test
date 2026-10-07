// DSLink audio: one allocation-free ring buffer + resampler (AudioRing) used by the AudioWorklet and, unchanged, by the ScriptProcessor fallback and the unit test.
//
//   WASM core -> emulator worker -> (SharedArrayBuffer ring, when the page is cross-origin isolated)  or  (MessagePort, buffers recycled, default)  -> AudioRing -> output
//
// * The DS produces 32768 Hz stereo, the device wants 44.1/48 kHz: linear resampling with a PI controller on the buffer level (clamped to +-0.6 %), so the small difference between the
//   emulator's wall clock and the audio clock is absorbed by tiny speed changes instead of underruns/overruns.
// * Starvation is an EVENT (one count per dropout, plus the silent samples it caused): a short fade-out, silence until the buffer has refilled, a short fade-in. No click, no
//   repeated re-priming of a long buffer.
// * The buffer target is adaptive: it starts at 100 ms, grows after a dropout (x1.35, up to 250 ms) and shrinks slowly (5 ms every 8 s of stability, down to 70 ms).
// * Nothing is allocated per quantum or per message (the metrics object is reused).

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export class AudioRing {
  constructor({ srcRate = 32768, outRate = 48000, startMs = 100, minMs = 70, maxMs = 250, now = () => 0 } = {}) {
    this.now = now; this.srcRate = srcRate; this.outRate = outRate; this.startMs = startMs; this.minMs = minMs; this.maxMs = maxMs;
    this.cap = 1 << 16; this.mask = this.cap - 1; this.l = new Float32Array(this.cap); this.r = new Float32Array(this.cap);
    this.events = new Float64Array(32); this.evN = 0;
    this.m = { backend: "msg", state: "prime", fillMs: 0, targetMs: startMs, underEvents: 0, underSamples: 0, under10s: 0, overruns: 0, overDropped: 0, queueFrames: 0, lateQuanta: 0, maxGapMs: 0,
      pushed: 0, consumed: 0, rateAdjPpm: 0, secondsSinceUnderrun: -1, srcRate, outRate, msgGapMaxMs: 0 };
    this.reset();
  }
  reset() {                                   // flush (start, resume after a pause): the buffer refills before playing again
    this.w = 0; this.rd = 0; this.frac = 0; this.state = "prime"; this.filtered = 0; this.integral = 0; this.fade = 0; this.lastL = 0; this.lastR = 0;
    this.targetMs = this.targetMs && this.targetMs > this.startMs ? this.targetMs : this.startMs; this.lastCall = 0; this.lastEvent = -1e9; this.lastShrink = this.now(); this.lastPush = 0; this.gapMax = 0; this.evN = 0;
  }
  setRates(srcRate, outRate) { if (srcRate) this.srcRate = srcRate; if (outRate) this.outRate = outRate; this.m.srcRate = this.srcRate; this.m.outRate = this.outRate; }
  get fillFrames() { return this.w - this.rd; }

  /** interleaved 16-bit stereo, n frames, read from `s` starting at sample index `off` */
  push(s, n, off = 0) {
    const t = this.now(); if (this.lastPush) { const g = (t - this.lastPush) * 1000; if (g > this.gapMax) this.gapMax = g; } this.lastPush = t;
    const l = this.l, r = this.r, mask = this.mask; let w = this.w;
    for (let i = 0; i < n; i++, w++) { const k = w & mask, j = off + 2 * i; l[k] = s[j] * (1 / 32768); r[k] = s[j + 1] * (1 / 32768); }
    this.w = w; this.m.pushed += n;
    if (w - this.rd > this.cap - 4096) { const drop = w - this.rd - this.targetFrames(); this.rd += drop; this.m.overruns++; this.m.overDropped += drop; }
  }
  /** same, from a ring of 16-bit interleaved frames (SharedArrayBuffer path): frames [from, from+n) modulo `cap` */
  pushRing(s, cap, from, n) {
    const t = this.now(); if (this.lastPush) { const g = (t - this.lastPush) * 1000; if (g > this.gapMax) this.gapMax = g; } this.lastPush = t;
    const l = this.l, r = this.r, mask = this.mask, cm = cap - 1; let w = this.w;
    for (let i = 0; i < n; i++, w++) { const k = w & mask, j = ((from + i) & cm) * 2; l[k] = s[j] * (1 / 32768); r[k] = s[j + 1] * (1 / 32768); }
    this.w = w; this.m.pushed += n;
    if (w - this.rd > this.cap - 4096) { const drop = w - this.rd - this.targetFrames(); this.rd += drop; this.m.overruns++; this.m.overDropped += drop; }
  }
  targetFrames() { return (this.targetMs * this.srcRate / 1000) | 0; }

  /** fills L/R (n samples each) */
  render(L, R, n) {
    const now = this.now(), m = this.m, out = this.outRate, src = this.srcRate, quantum = n / out;
    if (this.lastCall && this.state === "run" && now - this.lastCall > quantum * 2.2) { m.lateQuanta++; }
    this.lastCall = now;
    // slow, gradual shrink of the target while everything is stable
    if (this.targetMs > this.minMs && now - this.lastEvent > 8 && now - this.lastShrink > 8) { this.targetMs = Math.max(this.minMs, this.targetMs - 5); this.lastShrink = now; }
    const targetF = this.targetFrames();
    let fill = this.w - this.rd - this.frac;
    if (this.state !== "run") {
      const need = this.state === "prime" ? targetF : Math.max(targetF * 0.6, this.minMs * src / 1000 * 0.6);
      if (fill >= need) { this.state = "run"; this.filtered = fill; this.fade = 96; }
      else { for (let i = 0; i < n; i++) { L[i] = 0; R[i] = 0; } if (this.state === "rebuffer") m.underSamples += n; this.snapshot(fill, now); return; }
    }
    this.filtered += 0.05 * (fill - this.filtered);
    const err = (this.filtered - targetF) / src;                                   // seconds of buffer above (+) / below (-) the target
    this.integral = clamp(this.integral + err * quantum, -0.4, 0.4);
    const adj = clamp(0.2 * err + 0.02 * this.integral, -0.006, 0.006);
    const ratio = (src / out) * (1 + adj);
    const maxFill = Math.max(targetF * 2.5, targetF + 0.08 * src);
    if (fill > maxFill) { const drop = Math.floor(fill - targetF * 1.3); this.rd += drop; m.overruns++; m.overDropped += drop; fill -= drop; }
    const l = this.l, r = this.r, mask = this.mask;
    let rd = this.rd, frac = this.frac, lastL = this.lastL, lastR = this.lastR, fade = this.fade, i = 0;
    for (; i < n; i++) {
      if (this.w - rd < 2) break;                                                   // ran dry inside this quantum
      const a = rd & mask, b = (rd + 1) & mask;
      let sl = l[a] + (l[b] - l[a]) * frac, sr = r[a] + (r[b] - r[a]) * frac;
      if (fade > 0) { const g = 1 - fade / 96; sl *= g; sr *= g; fade--; }
      L[i] = sl; R[i] = sr; lastL = sl; lastR = sr;
      frac += ratio; const adv = frac | 0; frac -= adv; rd += adv;
    }
    this.rd = rd; this.frac = frac; this.fade = fade;
    if (i < n) {                                                                    // starvation: fade the last value out, then silence, then wait for a refill
      const rest = n - i, ramp = Math.min(rest, 48);
      for (let k = 0; k < rest; k++) { const g = k < ramp ? 1 - (k + 1) / ramp : 0; L[i + k] = lastL * g; R[i + k] = lastR * g; }
      m.underEvents++; m.underSamples += rest; this.state = "rebuffer"; this.lastEvent = now; this.lastShrink = now; lastL = 0; lastR = 0;
      this.targetMs = Math.min(this.maxMs, this.targetMs * 1.35 + 5);
      this.events[this.evN++ & 31] = now;
    }
    this.lastL = lastL; this.lastR = lastR; m.consumed = this.rd;   // source frames read so far (drops included)
    this.snapshot(this.w - this.rd - this.frac, now, adj);
  }
  snapshot(fill, now, adj = 0) {
    const m = this.m; m.state = this.state; m.fillMs = fill * 1000 / this.srcRate; m.targetMs = this.targetMs; m.queueFrames = this.w - this.rd; m.rateAdjPpm = adj * 1e6;
    let c = 0; const k = Math.min(this.evN, 32); for (let q = 0; q < k; q++) if (now - this.events[q] < 10) c++; m.under10s = c;
    m.secondsSinceUnderrun = this.lastEvent > -1e8 ? now - this.lastEvent : -1; if (this.gapMax > m.msgGapMaxMs) m.msgGapMaxMs = this.gapMax;
  }
  metrics() { return this.m; }
}

if (typeof registerProcessor === "function") {
  // ---------------------------------------------------------------- AudioWorklet
  class DslinkAudio extends AudioWorkletProcessor {
    constructor(opts) {
      super();
      const o = opts.processorOptions || {};
      this.ring = new AudioRing({ srcRate: o.srcRate || 32768, outRate: sampleRate, now: () => currentTime });
      this.sab = null; this.ctrl = null; this.sabCap = 0; this.free = []; this.lastMetrics = 0; this.dataPort = null;
      this.port.onmessage = (e) => this.onControl(e.data);
    }
    onControl(d) {
      if (!d) return;
      if (d.port) { this.dataPort = d.port; d.port.onmessage = (ev) => this.onData(ev.data); this.ring.m.backend = "msg"; }
      if (d.sab) { this.sab = new Int16Array(d.sab.data); this.ctrl = new Int32Array(d.sab.ctrl); this.sabCap = d.sab.cap; this.sabRead = Atomics.load(this.ctrl, 0); this.ring.m.backend = "sab"; }
      if (d.srcRate) this.ring.setRates(d.srcRate, 0);
      if (d.flush) { this.ring.reset(); if (this.ctrl) this.sabRead = Atomics.load(this.ctrl, 0); }
    }
    onData(d) {                                             // { b: ArrayBuffer (recycled by the worker), n: frames }
      this.ring.push(new Int16Array(d.b, 0, d.n * 2), d.n);
      this.free.push(d.b);
      if (this.free.length >= 6 && this.dataPort) { const f = this.free; this.free = []; this.dataPort.postMessage(f, f); }   // give the buffers back (no allocation in steady state)
    }
    process(_in, outputs) {
      const out = outputs[0], L = out[0], R = out[1] || out[0];
      if (this.ctrl) {                                      // SharedArrayBuffer ring: pull whatever the worker wrote since the last quantum
        const w = Atomics.load(this.ctrl, 0); const n = (w - this.sabRead) | 0;
        if (n > 0) { this.ring.pushRing(this.sab, this.sabCap, this.sabRead, n); this.sabRead = w; Atomics.store(this.ctrl, 1, w); }
      }
      this.ring.render(L, R, L.length);
      if (R !== L && out.length > 2) for (let c = 2; c < out.length; c++) out[c].set(L);
      if (currentTime - this.lastMetrics > 0.25) { this.lastMetrics = currentTime; this.port.postMessage(this.ring.metrics()); this.ring.m.msgGapMaxMs = 0; this.ring.gapMax = 0; }
      return true;
    }
  }
  registerProcessor("dslink-audio", DslinkAudio);
}
