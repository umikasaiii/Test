// RadioPeer: the PWA's WebRTC DataChannel RadioTransport (the page-side half; the other half is wasm/webrtc_link.cpp inside the emulator worker).
//
//   melonDS -> DSLink Radio Bridge -> DSRadioTransport -> [WebRtcLink in the worker] -> page: RadioPeer -> RTCDataChannel "radio" -> the other page -> ring/queue -> the other worker
//
// Two channels on one connection:
//   "radio"  BINARY, the DS radio frames and the link probes. Default ordered:false, maxRetransmits:0: UDP-like, no head-of-line blocking, no late retransmissions - a stale radio frame
//            is usually worse than a lost one. (The mode is configurable so the fault matrix can compare ordered/reliable on the same traffic.)
//   "ctl"    reliable JSON for the lobby (ready, start, background, bye). Never carries radio frames, ROMs, saves, BIOS or anything private.
// Radio message = 1 byte [version<<4 | type] + payload:  DATA: seq u16, dest u16, src u16, frame...   PING/PONG: seq u16.   (7 bytes of header per frame; DTLS already authenticates/encrypts.)
// The logical frame (dest, src, payload) is the one the native bridge uses over the Unix socket and DRP/UDP: no second incompatible protocol.
export const VER = 1, T_DATA = 0, T_PING = 1, T_PONG = 2;
const HDR_DATA = 7, MAX_FRAME = 16384;
const now = () => performance.now();
const rnd = Math.random;

export function rateQuality(p) {
  // thresholds from the native LAN evidence (docs/DISTRIBUTED_MODE.md): ~0-8 ms one-way good, ~10 borderline, >=15 probably a problem; WebRTC numbers are recorded and compared, not assumed
  if (!p || !p.received) return { level: "RED", label: "NON ADATTA", why: "nessuna risposta" };
  const oneWay = p.rttAvg / 2;
  let level = oneWay <= 8 ? 0 : oneWay <= 12 ? 1 : 2;
  if (p.lossPct > 1) level = Math.max(level, 1);
  if (p.lossPct > 3) level = 2;
  if (p.jitter > 8) level = Math.max(level, 1);
  if (p.jitter > 15) level = 2;
  return { level: ["GREEN", "YELLOW", "RED"][level], label: ["OTTIMA", "BUONA", "NON ADATTA"][level], oneWayMs: oneWay };
}

export class RadioPeer {
  /** @param {{role:'host'|'guest', iceServers?:object[], signal:{send:(m:object)=>void}, radioMode?:{ordered:boolean,maxRetransmits?:number}, impair?:{delayMs:number,jitterMs:number,lossPct:number},
   *  backpressure?:{soft:number,hard:number,queue:number}, reorderMs?:number, peerTimeoutMs?:number, onState?:(s:string,why?:string)=>void, onCtl?:(m:object)=>void,
   *  onFrame?:(dest:number,src:number,payload:Uint8Array,atMs:number)=>void}} o */
  constructor(o) {
    this.o = { radioMode: { ordered: false, maxRetransmits: 0 }, impair: { delayMs: 0, jitterMs: 0, lossPct: 0 }, backpressure: { soft: 8192, hard: 32768, queue: 4 }, reorderMs: 8, peerTimeoutMs: 4000, iceServers: [], ...Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) };
    this.role = o.role; this.state = "new"; this.pc = null; this.radio = null; this.ctl = null; this.pendingIce = []; this.haveRemote = false;
    this.txSeq = 0; this.rxExpected = null; this.held = new Map(); this.deadline = 0; this.softQ = [];
    this.scratch = new Uint8Array(HDR_DATA + MAX_FRAME); this.pingSeq = 0; this.pings = new Map(); this.lastPong = now(); this.peerHidden = false; this.hiddenSince = 0;
    this.m = { sent: 0, recv: 0, bytesOut: 0, bytesIn: 0, droppedSoft: 0, droppedHard: 0, droppedClosed: 0, droppedImpair: 0, tooBig: 0, stringOnRadio: 0, bufferedAmount: 0, bufferedMax: 0, queueDepth: 0, queueMax: 0,
      reordered: 0, lost: 0, lateDropped: 0, rxHoldMsMax: 0, rtt: { last: 0, avg: 0, min: 1e9, max: 0, n: 0 }, jitter: 0, pingSent: 0, pingRecv: 0, ringLagAvg: 0, ringLagMax: 0, ringLagN: 0, ctlSent: 0, ctlRecv: 0, restarts: 0 };
    this.blackoutUntil = 0; this.timers = [];
    this.watch = setInterval(() => this.tick(), 500); this.timers.push(this.watch);
  }

  // ------------------------------------------------------------------ connection
  setState(s, why) { if (this.state === s) return; this.state = s; if (this.o.onState) this.o.onState(s, why); }
  makePc() {
    const pc = this.pc = new RTCPeerConnection({ iceServers: this.o.iceServers });
    pc.onicecandidate = (e) => { if (e.candidate) this.o.signal.send({ k: "ice", c: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
    pc.onconnectionstatechange = () => this.onConn();
    pc.oniceconnectionstatechange = () => this.onConn();
    pc.ondatachannel = (e) => this.attach(e.channel);
    return pc;
  }
  /** host: create the connection and the channels, send the offer */
  async begin() {
    this.setState("connecting"); const pc = this.makePc();
    const rm = this.o.radioMode; const radio = pc.createDataChannel("radio", rm.ordered ? { ordered: true, ...(rm.maxRetransmits != null && rm.maxRetransmits !== undefined ? { maxRetransmits: rm.maxRetransmits } : {}) } : { ordered: false, maxRetransmits: rm.maxRetransmits ?? 0 });
    const ctl = pc.createDataChannel("ctl", { ordered: true });
    this.attach(radio); this.attach(ctl);
    await this.offer(false);
  }
  async offer(restart) {
    const offer = await this.pc.createOffer(restart ? { iceRestart: true } : undefined); await this.pc.setLocalDescription(offer);
    this.o.signal.send({ k: "offer", sdp: this.pc.localDescription.sdp });
  }
  /** signaling input from the other side */
  async onSignal(msg) {
    try {
      if (msg.k === "offer") {
        if (!this.pc) { this.setState("connecting"); this.makePc(); }
        await this.pc.setRemoteDescription({ type: "offer", sdp: msg.sdp }); this.haveRemote = true;
        const ans = await this.pc.createAnswer(); await this.pc.setLocalDescription(ans);
        this.o.signal.send({ k: "answer", sdp: this.pc.localDescription.sdp });
        for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
      } else if (msg.k === "answer") {
        await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp }); this.haveRemote = true;
        for (const c of this.pendingIce.splice(0)) await this.pc.addIceCandidate(c).catch(() => {});
      } else if (msg.k === "ice") {
        if (this.haveRemote) await this.pc.addIceCandidate(msg.c).catch(() => {}); else this.pendingIce.push(msg.c);
      }
    } catch (e) { this.setState("lost", "signaling: " + (e && e.message || e)); }
  }
  attach(ch) {
    ch.binaryType = "arraybuffer";
    if (ch.label === "radio") {
      this.radio = ch; ch.bufferedAmountLowThreshold = Math.max(1024, this.o.backpressure.soft >> 1);
      ch.onbufferedamountlow = () => this.drainSoft();
      ch.onmessage = (e) => this.onRadio(e.data);
      ch.onopen = () => this.maybeOpen(); ch.onclose = () => this.onChClose("radio"); ch.onerror = () => {};
    } else if (ch.label === "ctl") {
      this.ctl = ch;
      ch.onmessage = (e) => { this.m.ctlRecv++; try { this.onCtlMsg(JSON.parse(e.data)); } catch { /* not ours */ } };
      ch.onopen = () => this.maybeOpen(); ch.onclose = () => this.onChClose("ctl"); ch.onerror = () => {};
    }
    this.maybeOpen();
  }
  maybeOpen() {
    if (this.state !== "open" && this.radio && this.ctl && this.radio.readyState === "open" && this.ctl.readyState === "open") { this.lastPong = now(); this.setState("open"); }
  }
  onChClose(which) { if (this.state !== "closed") this.setState("lost", which + " channel closed"); }
  onConn() {
    const c = this.pc.connectionState, i = this.pc.iceConnectionState;
    if (c === "failed" || i === "failed") { if (this.role === "host" && this.m.restarts < 3) { this.m.restarts++; this.pc.restartIce(); this.offer(true).catch(() => {}); } else this.setState("lost", "ICE failed (nessun percorso diretto)"); }
    else if (c === "disconnected" || i === "disconnected") { if (this.state === "open") this.setState("degraded"); }
    else if ((c === "connected" || i === "connected") && this.state === "degraded") { this.lastPong = now(); this.setState("open"); }
  }

  // ------------------------------------------------------------------ control channel
  sendCtl(obj) { if (this.ctl && this.ctl.readyState === "open") { this.ctl.send(JSON.stringify(obj)); this.m.ctlSent++; return true; } return false; }
  onCtlMsg(m) {
    if (m.t === "vis") { this.peerHidden = !!m.hidden; this.hiddenSince = now(); this.lastPong = now(); }
    if (this.o.onCtl) this.o.onCtl(m);
  }

  // ------------------------------------------------------------------ radio: transmit
  /** one DS radio frame from the local core (via the worker). Never blocks, never waits for the network. */
  sendFrame(dest, src, payload) {
    const m = this.m, ch = this.radio;
    if (!ch || ch.readyState !== "open" || now() < this.blackoutUntil) { m.droppedClosed++; return false; }
    if (payload.length > MAX_FRAME) { m.tooBig++; return false; }
    const im = this.o.impair;
    if (im.lossPct > 0 && rnd() * 100 < im.lossPct) { m.droppedImpair++; return false; }
    if (im.delayMs > 0 || im.jitterMs > 0) {
      const copy = payload.slice(), d = im.delayMs + rnd() * im.jitterMs;
      setTimeout(() => this.emit(dest, src, copy), d); return true;
    }
    return this.emit(dest, src, payload);
  }
  emit(dest, src, payload) {
    const ch = this.radio, m = this.m, bp = this.o.backpressure;
    if (!ch || ch.readyState !== "open") { m.droppedClosed++; return false; }
    const b = ch.bufferedAmount; m.bufferedAmount = b; if (b > m.bufferedMax) m.bufferedMax = b;
    if (b >= bp.hard) { m.droppedHard++; this.softQ.length = 0; m.queueDepth = 0; return false; }       // far behind: drop, and everything waiting is obsolete anyway
    if (b >= bp.soft || this.softQ.length) {                                                             // behind: wait for the buffer to drain, newest frames win
      this.softQ.push({ dest, src, payload: payload.slice() });
      while (this.softQ.length > bp.queue) { this.softQ.shift(); m.droppedSoft++; }
      m.queueDepth = this.softQ.length; if (m.queueDepth > m.queueMax) m.queueMax = m.queueDepth;
      return true;
    }
    return this.write(dest, src, payload);
  }
  drainSoft() {
    const ch = this.radio; if (!ch || ch.readyState !== "open") return;
    while (this.softQ.length && ch.bufferedAmount < this.o.backpressure.soft) { const f = this.softQ.shift(); this.write(f.dest, f.src, f.payload); }
    this.m.queueDepth = this.softQ.length;
  }
  write(dest, src, payload) {
    const s = this.scratch, n = payload.length, seq = this.txSeq; this.txSeq = (this.txSeq + 1) & 0xFFFF;
    s[0] = VER << 4 | T_DATA; s[1] = seq & 255; s[2] = seq >> 8; s[3] = dest & 255; s[4] = dest >> 8; s[5] = src & 255; s[6] = src >> 8; s.set(payload, HDR_DATA);
    try { this.radio.send(s.subarray(0, HDR_DATA + n)); } catch { this.m.droppedClosed++; return false; }
    this.m.sent++; this.m.bytesOut += n; return true;
  }

  // ------------------------------------------------------------------ radio: receive
  onRadio(data) {
    if (typeof data === "string") { this.m.stringOnRadio++; return; }                                    // the radio channel is binary only
    if (now() < this.blackoutUntil) return;
    const u = new Uint8Array(data); if (u.length < 3 || (u[0] >> 4) !== VER) return;
    const type = u[0] & 15, seq = u[1] | u[2] << 8;
    if (type === T_DATA && u.length >= HDR_DATA) this.onData(seq, u[3] | u[4] << 8, u[5] | u[6] << 8, u.subarray(HDR_DATA), now());
    else if (type === T_PING) { this.m.pingRecv++; const r = new Uint8Array(3); r[0] = VER << 4 | T_PONG; r[1] = u[1]; r[2] = u[2]; this.probeSend(r); }
    else if (type === T_PONG) this.onPong(seq);
  }
  rawSend(buf) { try { if (this.radio && this.radio.readyState === "open" && now() >= this.blackoutUntil) this.radio.send(buf); } catch { /* closed */ } }
  onData(seq, dest, src, payload, t) {
    const m = this.m; m.recv++; m.bytesIn += payload.length;
    if (this.rxExpected === null) this.rxExpected = seq;
    const d = (seq - this.rxExpected) & 0xFFFF;
    if (d === 0) { this.deliver(dest, src, payload, t); this.rxExpected = (this.rxExpected + 1) & 0xFFFF; this.flushHeld(); }
    else if (d < 0x8000) {                                                                               // a gap: wait a few ms for the missing one, then give up on it
      this.held.set(seq, { dest, src, payload: payload.slice(), t });
      if (this.held.size > 64) this.expire(); else if (!this.deadline) this.deadline = setTimeout(() => { this.deadline = 0; this.expire(); }, this.o.reorderMs);
    } else m.lateDropped++;                                                                              // behind what was already delivered (late after being declared lost, or a duplicate)
  }
  flushHeld() {
    while (this.held.has(this.rxExpected)) {
      const f = this.held.get(this.rxExpected); this.held.delete(this.rxExpected);
      this.m.reordered++; const hold = now() - f.t; if (hold > this.m.rxHoldMsMax) this.m.rxHoldMsMax = hold;
      this.deliver(f.dest, f.src, f.payload, f.t); this.rxExpected = (this.rxExpected + 1) & 0xFFFF;
    }
  }
  expire() {
    if (this.deadline) { clearTimeout(this.deadline); this.deadline = 0; }
    while (this.held.size) {
      let best = -1, bd = 1e9; for (const s of this.held.keys()) { const d = (s - this.rxExpected) & 0xFFFF; if (d < bd) { bd = d; best = s; } }
      if (bd > 0) { this.m.lost += bd; this.rxExpected = best; }
      this.flushHeld();
    }
  }
  deliver(dest, src, payload, t) { if (this.o.onFrame) this.o.onFrame(dest, src, payload, t); }
  noteRingLag(ms) { const m = this.m; m.ringLagN++; m.ringLagAvg += (ms - m.ringLagAvg) / Math.min(m.ringLagN, 200); if (ms > m.ringLagMax) m.ringLagMax = ms; }

  // ------------------------------------------------------------------ probes, liveness
  ping() {
    const seq = this.pingSeq = (this.pingSeq + 1) & 0xFFFF, b = new Uint8Array(3); b[0] = VER << 4 | T_PING; b[1] = seq & 255; b[2] = seq >> 8;
    this.pings.set(seq, now()); if (this.pings.size > 256) this.pings.delete(this.pings.keys().next().value);
    this.m.pingSent++;
    this.probeSend(b);
  }
  /** probes see the same (test-only) impairment as the radio frames, in both directions */
  probeSend(b) {
    const im = this.o.impair; if (im.lossPct > 0 && rnd() * 100 < im.lossPct) return;
    if (im.delayMs > 0 || im.jitterMs > 0) setTimeout(() => this.rawSend(b), im.delayMs + rnd() * im.jitterMs); else this.rawSend(b);
  }
  onPong(seq) {
    const t0 = this.pings.get(seq); if (t0 === undefined) return; this.pings.delete(seq);
    const rtt = now() - t0, r = this.m.rtt; this.lastPong = now();
    const prev = r.last; r.last = rtt; r.n++; r.avg += (rtt - r.avg) / Math.min(r.n, 20); if (rtt < r.min) r.min = rtt; if (rtt > r.max) r.max = rtt;
    if (r.n > 1) this.m.jitter += (Math.abs(rtt - prev) - this.m.jitter) / 16;                           // RFC 3550 style smoothed inter-sample variation
    if (this.probeCb) this.probeCb(rtt);
  }
  /** measure the link for a few seconds on the SAME channel and settings the game will use */
  probe(ms = 3000, every = 50) {
    return new Promise((resolve) => {
      const rt = []; const sent0 = this.m.pingSent; this.probeCb = (r) => rt.push(r);
      const iv = setInterval(() => this.ping(), every);
      setTimeout(() => {
        clearInterval(iv); setTimeout(() => {
          this.probeCb = null; const sent = this.m.pingSent - sent0, got = rt.length;
          const avg = got ? rt.reduce((a, b) => a + b, 0) / got : 0; let jit = 0; for (let i = 1; i < got; i++) jit += Math.abs(rt[i] - rt[i - 1]); jit = got > 1 ? jit / (got - 1) : 0;
          const sorted = rt.slice().sort((a, b) => a - b);
          resolve({ sent, received: got, lossPct: sent ? 100 * (sent - got) / sent : 100, rttAvg: avg, rttMin: sorted[0] || 0, rttMax: sorted[got - 1] || 0, rttP95: sorted[Math.floor(got * 0.95)] || 0, jitter: jit, oneWayEstMs: avg / 2 });
        }, Math.max(150, this.o.impair.delayMs * 2 + this.o.impair.jitterMs * 2 + 100));
      }, ms);
    });
  }
  tick() {
    if (this.state === "closed") return;
    const t = now();
    if (this.radio && this.radio.readyState === "open") { this.m.bufferedAmount = this.radio.bufferedAmount; if (this.state === "open" || this.state === "degraded") { if (!this.probeCb) this.ping(); } }
    const silent = t - this.lastPong;
    if ((this.state === "open" || this.state === "degraded") && !this.pausedWatch) {
      const limit = this.peerHidden ? 30000 : this.o.peerTimeoutMs;                                      // a peer that told us it went to the background is allowed a long silence
      if (silent > limit) this.setState("lost", this.peerHidden ? "il giocatore è rimasto in background" : "nessuna risposta dal giocatore");
    }
  }
  /** test hook: an outage of the link (everything sent or received is dropped) for `ms` */
  debugBlackout(ms) { this.blackoutUntil = now() + ms; }
  setImpair(i) { this.o.impair = { delayMs: 0, jitterMs: 0, lossPct: 0, ...i }; }
  metrics() { return { ...this.m, state: this.state, role: this.role, radio: this.radio ? { ordered: this.radio.ordered, maxRetransmits: this.radio.maxRetransmits, maxPacketLifeTime: this.radio.maxPacketLifeTime, readyState: this.radio.readyState, binaryType: this.radio.binaryType, bufferedAmount: this.radio.bufferedAmount } : null }; }
  close() {
    if (this.state === "closed") return; this.setState("closed");
    for (const t of this.timers) { clearTimeout(t); clearInterval(t); } this.timers = []; if (this.deadline) clearTimeout(this.deadline);
    try { this.radio && this.radio.close(); this.ctl && this.ctl.close(); this.pc && this.pc.close(); } catch { /* gone */ }
  }
}
