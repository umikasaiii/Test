// AudioWorklet: ring buffer of 16-bit stereo frames coming straight from the emulator worker, resampled (linear) from the DS rate (32768 Hz) to the device rate, with a
// small adaptive speed correction so the buffer neither runs dry (crackle) nor grows (latency). Counts underruns for the development overlay.
class DslinkAudio extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions || {};
    this.srcRate = o.srcRate || 32768; this.cap = 1 << 16; this.l = new Float32Array(this.cap); this.r = new Float32Array(this.cap);
    this.w = 0; this.rd = 0; this.frac = 0; this.under = 0; this.primed = false; this.sent = 0; this.consumed = 0;
    this.target = Math.round(this.srcRate * 0.07);               // ~70 ms of audio buffered
    this.port.onmessage = (e) => { const d = e.data; if (d && d.port) d.port.onmessage = (ev) => this.onData(ev.data); else this.onData(d); };   // the emulator worker's own port arrives here
    this.last = currentTime;
  }
  onData(d) {
    if (d && d.srcRate) { this.srcRate = d.srcRate; this.target = Math.round(this.srcRate * 0.07); return; }
    const s = new Int16Array(d), n = s.length >> 1;
    for (let i = 0; i < n; i++) { const k = (this.w + i) & (this.cap - 1); this.l[k] = s[2 * i] / 32768; this.r[k] = s[2 * i + 1] / 32768; }
    this.w += n; this.sent += n;
    if (this.w - this.rd > this.cap - 4096) this.rd = this.w - this.target;      // overflow: drop the oldest
  }
  process(_in, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
    const fill = this.w - this.rd;
    if (!this.primed) { if (fill >= this.target) this.primed = true; else { L.fill(0); if (R !== L) R.fill(0); return true; } }
    // adaptive ratio: nudge consumption by up to +-0.4 % toward the target fill
    let ratio = this.srcRate / sampleRate;
    const err = (fill - this.target) / this.target; ratio *= 1 + Math.max(-0.004, Math.min(0.004, err * 0.004));
    for (let i = 0; i < n; i++) {
      if (this.w - this.rd < 2) { L[i] = R[i] = 0; this.under++; this.primed = false; continue; }
      const a = this.rd & (this.cap - 1), b = (this.rd + 1) & (this.cap - 1), f = this.frac;
      L[i] = this.l[a] + (this.l[b] - this.l[a]) * f; R[i] = this.r[a] + (this.r[b] - this.r[a]) * f;
      this.frac += ratio; const adv = this.frac | 0; this.frac -= adv; this.rd += adv; this.consumed += adv;
    }
    if (currentTime - this.last > 0.5) { this.last = currentTime; this.port.postMessage({ under: this.under, fill: this.w - this.rd, sent: this.sent, consumed: this.consumed }); }
    return true;
  }
}
registerProcessor("dslink-audio", DslinkAudio);
