// Party Voice: voice chat between friends, INDEPENDENT of the emulator. A party lives in the menus, the lobby, during a game and after it: nothing here depends on the Player or on a game session.
//   - the microphone and the voice are WebRTC audio (Opus) between the phones, on their own connections; the game audio stays local and is never mixed with the microphone
//   - the Cloud only knows who is in the party and relays small signaling messages: it never carries, records, stores or transcribes audio
//   - the microphone is requested ONLY when the user joins / activates the party (never at app start)
//   - VoiceTransport is the seam: P2PMesh (verified here for 2-4 members; the mesh scales as N*(N-1)/2 connections) and an SFU slot for bigger parties, configurable, not required, not claimed.
import { loadIce, selectedPath } from "./net.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const PARTY_MAX = 8, SPEAK_RMS = 0.012;   // time-domain RMS above which a voice counts as "speaking" (echo cancellation + AGC keep speech well above it)
export const MIC_STATES = ["off", "requesting", "on", "denied", "unavailable"];

/** speech-oriented Opus: in-band FEC, DTX (silence costs nothing), mono, 24 kbit/s, 20 ms frames. Anything unknown in the SDP is left alone. */
export function tuneOpus(sdp) {
  const m = /a=rtpmap:(\d+) opus\/48000\/2/i.exec(sdp); if (!m) return sdp;
  const pt = m[1], want = { minptime: "20", useinbandfec: "1", usedtx: "1", stereo: "0", "sprop-stereo": "0", maxaveragebitrate: "24000" };
  const re = new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`);
  if (re.test(sdp)) return sdp.replace(re, (_, params) => { const o = {}; for (const kv of params.split(";")) { const [k, v] = kv.split("="); if (k) o[k.trim()] = v === undefined ? "" : v.trim(); } Object.assign(o, want); return `a=fmtp:${pt} ` + Object.entries(o).map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join(";"); });
  return sdp.replace(new RegExp(`(a=rtpmap:${pt} [^\\r\\n]*)`), `$1\r\na=fmtp:${pt} ` + Object.entries(want).map(([k, v]) => `${k}=${v}`).join(";"));
}

// ================================================================================================================================== signaling socket (with reconnect)
class PartySignal {
  constructor(cloud, handlers) { this.cloud = cloud; this.h = handlers; this.ws = null; this.want = false; this.attempt = 0; this.timer = 0; this.pingT = 0; this.pongAt = 0; this.opened = 0; }
  start() { this.want = true; this.open(); }
  async open() {
    if (!this.want || this.ws) return;
    const tk = await this.cloud.api("POST", "/api/ws-ticket", {});
    if (!this.want || this.ws) return;
    if (!tk.ok) { if (tk.status === 401) { this.h.onGone("unauthenticated"); return; } this.retry(); return; }
    let ws; try { ws = new WebSocket(`${this.cloud.wsBase()}/api/party/ws?ticket=${encodeURIComponent(tk.body.ticket)}`); } catch { this.retry(); return; }
    this.ws = ws;
    ws.onopen = () => { this.attempt = 0; this.opened++; this.pongAt = Date.now(); clearInterval(this.pingT); this.pingT = setInterval(() => { this.send({ t: "ping" }); }, 15000); this.h.onOpen(this.opened > 1); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } if (m.t === "pong") { this.pongAt = Date.now(); return; } this.h.onMessage(m); };
    ws.onclose = (e) => {
      clearInterval(this.pingT); if (this.ws === ws) this.ws = null; this.h.onClose(e.code);
      if (e.code === 4003 || e.code === 4004 || e.code === 4008) { this.want = false; this.h.onGone(e.code === 4003 ? "removed" : e.code === 4004 ? "replaced" : "too_fast"); return; }     // removed from the party / another device took over: do not fight it
      if (this.want) this.retry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }
  retry() { clearTimeout(this.timer); this.timer = setTimeout(() => this.open(), Math.min(15000, 600 * 2 ** Math.min(this.attempt++, 5))); }
  send(o) { if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify(o)); return true; } catch { /* gone */ } } return false; }
  alive() { return !!this.ws && this.ws.readyState === 1; }
  stop() { this.want = false; clearTimeout(this.timer); clearInterval(this.pingT); if (this.ws) { const w = this.ws; this.ws = null; try { w.close(1000, "bye"); } catch { /* closed */ } } }
}

// ================================================================================================================================== VoiceTransport
/** The seam between the party and the way audio travels. P2PMesh below; an SFU transport can implement the same methods (connect(members), onSignal, setLocalTrack, stats, close). */
export class VoiceTransport {
  connect(_members) { throw new Error("not implemented"); }
  onSignal(_from, _data) { throw new Error("not implemented"); }
  setLocalTrack(_track) { throw new Error("not implemented"); }
  async stats() { return {}; }
  close() { /* nothing */ }
}
export class SFUTransport extends VoiceTransport {
  constructor() { super(); throw new Error("sfu_not_configured"); }          // prepared, not provided: no paid service is required
}

let lastSid = 0; const nextSid = () => (lastSid = Math.max(Date.now(), lastSid + 1));      // grows with every connection a side builds: a message from an OLDER connection is stale, a NEWER one means the peer started over
class Peer {
  constructor(uid, polite) { this.uid = uid; this.polite = polite; this.pc = null; this.making = false; this.ignore = false; this.stream = null; this.audioEl = null; this.src = null; this.gain = null; this.analyser = null; this.buf = null;
    this.sid = nextSid(); this.remoteSid = 0;       // one id per RTCPeerConnection: a peer that rebuilt its connection is recognised and answered with a fresh one (a new DTLS identity cannot be renegotiated)
    this.conn = "connecting"; this.graceT = 0; this.failures = 0; this.speaking = false; this.lastLoud = 0; this.level = 0; this.restarts = 0; this.reconnects = 0; this.bytes = 0; this.bytesAt = 0; this.bitrate = 0; this.sender = null; }
}

export class P2PMesh extends VoiceTransport {
  constructor(d) { super(); this.d = d; this.peers = new Map(); this.queue = new Map(); this.local = null; this.closed = false; this.restarts = 0; }
  has(uid) { return this.peers.has(uid); }
  /** members whose signaling is connected right now: make sure there is a peer connection for each (existing ones are kept) */
  connect(members) { for (const uid of members) if (uid !== this.d.me) this.ensure(uid); }
  /** the party's real membership (from the Cloud): connections of anybody who is no longer a member are closed */
  sync(ids) { for (const uid of [...this.peers.keys()]) if (!ids.includes(uid)) this.remove(uid); }
  /** a member (re)appeared on signaling: a connection that was waiting for an offer that never arrived starts over; a working one is left alone */
  appeared(uid) { const p = this.peers.get(uid); if (!p) { this.ensure(uid); return; } if (p.conn !== "connected") this.rebuild(p); }
  tx(p, data) { this.log(">", p.uid, data.k, p.sid, data.description && data.description.type); this.d.send(p.uid, { ...data, sid: p.sid }); }
  log(dir, uid, k, sid, extra) { const l = (self.__voiceLog = self.__voiceLog || []); if (l.length > 300) l.shift(); l.push([Math.round(performance.now()), dir, String(uid).slice(0, 3), k, String(sid).slice(-3), extra || ""].join(" ")); }       // dev diagnostics: the last signaling messages
  ensure(uid) {
    let p = this.peers.get(uid); if (p) return p;
    p = new Peer(uid, this.d.me > uid);                                       // perfect negotiation: one side polite, decided by id so both agree
    this.peers.set(uid, p); this.build(p); return p;
  }
  build(p) {
    const uid = p.uid, ice = this.d.ice();
    const pc = p.pc = new RTCPeerConnection({ iceServers: ice.iceServers, iceTransportPolicy: ice.iceTransportPolicy === "relay" ? "relay" : "all" });
    pc.onicecandidate = (e) => { if (e.candidate) this.tx(p, { k: "cand", candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }); };
    pc.oniceconnectionstatechange = () => this.onIce(p);
    pc.onconnectionstatechange = () => this.onIce(p);
    pc.ontrack = (e) => { p.stream = (e.streams && e.streams[0]) || new MediaStream([e.track]); this.d.onRemote(p); };
    pc.onnegotiationneeded = async () => {
      try { p.making = true; const o = await pc.createOffer(); o.sdp = tuneOpus(o.sdp); if (pc.signalingState !== "stable") return; await pc.setLocalDescription(o); this.tx(p, { k: "desc", description: { type: o.type, sdp: o.sdp } }); }
      catch { /* the next negotiation (or the grace restart) retries */ } finally { p.making = false; }
    };
    if (!p.polite) { const t = pc.addTransceiver("audio", { direction: "sendrecv" }); p.sender = t.sender; if (this.local) t.sender.replaceTrack(this.local).catch(() => {}); }   // the impolite side opens the m-line; the polite side gets it with the offer
  }
  /** signaling messages of one member are handled strictly one after the other (interleaved awaits would apply an answer in the wrong signaling state) */
  onSignal(from, data) { const q = (this.queue.get(from) || Promise.resolve()).then(() => this.handle(from, data)).catch(() => {}); this.queue.set(from, q); return q; }
  async handle(from, data) {
    let p = this.ensure(from); this.log("<", from, data.k, data.sid, data.description && data.description.type);
    if (data.sid) {
      if (data.sid < p.remoteSid) return;                                                         // stale: from a connection the other side already abandoned
      if (p.remoteSid && data.sid > p.remoteSid) { p = this.rebuild(p, true); p.remoteSid = data.sid; if (data.k === "reset" || data.k === "restart") return; }      // the other side started over: so do we (a fresh connection offers by itself)
      p.remoteSid = data.sid; if (data.k === "reset") return;
    }
    const pc = p.pc;
    try {
      if (data.k === "desc") {
        const d = data.description, collision = d.type === "offer" && (p.making || pc.signalingState !== "stable");
        p.ignore = !p.polite && collision; if (p.ignore) return;
        await pc.setRemoteDescription(d);
        if (d.type === "offer") {
          const t = pc.getTransceivers().find((x) => x.receiver && x.receiver.track && x.receiver.track.kind === "audio");
          if (t) { t.direction = "sendrecv"; p.sender = t.sender; if (this.local) await t.sender.replaceTrack(this.local).catch(() => {}); }
          const a = await pc.createAnswer(); a.sdp = tuneOpus(a.sdp); await pc.setLocalDescription(a); this.tx(p, { k: "desc", description: { type: a.type, sdp: a.sdp } });
        }
        this.tuneSender(p);
      } else if (data.k === "cand") {
        try { await pc.addIceCandidate(data.candidate); } catch (e) { if (!p.ignore) throw e; }
      } else if (data.k === "restart") { if (!p.polite) this.restartIce(p); }
    } catch (e) { const l = (self.__voiceErrors = self.__voiceErrors || []); if (l.length < 20) l.push(String((e && e.message) || e).slice(0, 120)); }   // a malformed or stale message from a peer never breaks the others (kept for the dev overlay / tests)
  }
  tuneSender(p) {
    try { if (!p.sender) return; const prm = p.sender.getParameters(); if (!prm.encodings || !prm.encodings.length) prm.encodings = [{}]; prm.encodings[0].maxBitrate = 32000; p.sender.setParameters(prm).catch(() => {}); } catch { /* not supported */ }
  }
  onIce(p) {
    const pc = p.pc; if (!pc || this.closed) return; const i = pc.iceConnectionState, c = pc.connectionState;
    if (i === "connected" || i === "completed" || c === "connected") { if (p.conn !== "connected") { if (p.conn === "disconnected" || p.conn === "failed") p.reconnects++; p.conn = "connected"; p.failures = 0; } if (p.graceT) { clearTimeout(p.graceT); p.graceT = 0; } this.d.onPeerState(p); }
    else if (i === "disconnected" || c === "disconnected") { p.conn = "disconnected"; this.d.onPeerState(p); if (!p.graceT) p.graceT = setTimeout(() => { p.graceT = 0; if (pc.iceConnectionState !== "connected" && pc.iceConnectionState !== "completed") this.recover(p); }, 3000); }
    else if (i === "failed" || c === "failed") { p.conn = "failed"; this.d.onPeerState(p); this.recover(p); }
  }
  /** ICE restart (the impolite side offers; the polite side asks through signaling); after repeated failures the connection is rebuilt from scratch */
  recover(p) {
    if (this.closed || !this.peers.has(p.uid)) return;
    if (++p.failures > 3) { this.rebuild(p); return; }
    p.restarts++; this.restarts++;
    if (!p.polite) this.restartIce(p); else this.tx(p, { k: "restart" });
  }
  restartIce(p) { try { p.pc.restartIce(); } catch { /* the offer below carries iceRestart */ } p.pc.createOffer({ iceRestart: true }).then((o) => { o.sdp = tuneOpus(o.sdp); if (p.pc.signalingState !== "stable") return; return p.pc.setLocalDescription(o).then(() => this.tx(p, { k: "desc", description: { type: o.type, sdp: o.sdp } })); }).catch(() => {}); }
  rebuild(p, remoteDriven = false) {
    const { uid, polite } = p; this.teardown(p); const n = new Peer(uid, polite); n.reconnects = p.reconnects + 1; n.restarts = p.restarts; this.peers.set(uid, n); this.build(n); if (!remoteDriven) this.tx(n, { k: "reset" });      // tell the other side at once: it must not keep a connection to the old identity
    this.d.onPeerState(n); return n;
  }
  teardown(p) { if (p.graceT) clearTimeout(p.graceT); try { p.pc && p.pc.close(); } catch { /* closed */ } this.d.onRemoteGone(p); }
  remove(uid) { const p = this.peers.get(uid); if (!p) return; this.peers.delete(uid); this.teardown(p); }
  setLocalTrack(track) { this.local = track; for (const p of this.peers.values()) { if (p.sender) p.sender.replaceTrack(track).then(() => this.tuneSender(p)).catch(() => {}); } }
  /** a member's connection is dead after the page was suspended: rebuild it */
  check() { for (const p of [...this.peers.values()]) { const s = p.pc && p.pc.connectionState; if (s === "failed" || s === "closed") this.rebuild(p); else if (s === "disconnected") this.recover(p); } }
  async stats() {
    const out = { peers: this.peers.size, connected: 0, codec: "", bitrateKbps: 0, rttMs: 0, jitterMs: 0, lost: 0, level: 0, reconnects: 0, restarts: this.restarts, paths: {} }; let rttN = 0;
    for (const p of this.peers.values()) {
      out.reconnects += p.reconnects; if (p.conn === "connected") out.connected++;
      try {
        const st = await p.pc.getStats(), byId = new Map(); st.forEach((s) => byId.set(s.id, s));
        st.forEach((s) => {
          if (s.type === "inbound-rtp" && s.kind === "audio") {
            out.lost += s.packetsLost || 0; out.jitterMs = Math.max(out.jitterMs, (s.jitter || 0) * 1000); out.level = Math.max(out.level, s.audioLevel || 0);
            const c = byId.get(s.codecId); if (c && c.mimeType) out.codec = c.mimeType.replace("audio/", "");
            const t = performance.now(); if (p.bytesAt) p.bitrate = Math.max(0, ((s.bytesReceived - p.bytes) * 8) / (t - p.bytesAt)); p.bytes = s.bytesReceived; p.bytesAt = t; out.bitrateKbps += p.bitrate;
          }
          if (s.type === "remote-inbound-rtp" && s.kind === "audio" && s.roundTripTime) { out.rttMs += s.roundTripTime * 1000; rttN++; }
        });
      } catch { /* closed */ }
      out.paths[p.uid] = (await selectedPath(p.pc)).path;
    }
    if (rttN) out.rttMs /= rttN; return out;
  }
  close() { this.closed = true; for (const p of this.peers.values()) this.teardown(p); this.peers.clear(); }
}

// ================================================================================================================================== the party (what the UI talks to)
export class PartyVoice {
  /** @param {{cloud:object, opt:Function, onChange?:Function, duck?:(f:number)=>void, transport?:string}} o */
  constructor(o) {
    this.o = o; this.cloud = o.cloud; this.party = null; this.me = ""; this.members = new Map(); this.micState = "off"; this.muted = false; this.partyAudio = true; this.duckOn = false;
    this.signal = null; this.mesh = null; this.ctx = null; this.master = null; this.localStream = null; this.localTrack = null; this.localAnalyser = null; this.localSpeaking = false; this.localLoud = 0;
    this.joined = false; this.timer = 0; this.duckRelease = 0; this.state = "idle"; this.counters = { signalReconnects: 0 }; this.micWanted = false; this.volumes = new Map();
    this.listeners = new Set(); if (o.onChange) this.listeners.add(o.onChange);
    document.addEventListener("visibilitychange", () => { if (!document.hidden) this.resume("visible"); });
    addEventListener("pageshow", () => this.resume("pageshow")); addEventListener("online", () => this.resume("online"));
    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener("devicechange", () => this.deviceChanged());
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit() { for (const f of this.listeners) { try { f(this); } catch { /* a listener never breaks the voice */ } } }
  get active() { return !!this.party; }
  get inParty() { return !!this.party; }
  get amOwner() { return !!this.party && this.party.owner === this.me; }

  // ---------------------------------------------------------------- membership (REST)
  async create() { const r = await this.cloud.api("POST", "/api/party"); if (r.ok) await this.enter(r.body.party, true); return r; }
  async respond(inviteId, accept) { const r = await this.cloud.api("POST", `/api/party/invites/${inviteId}/respond`, { accept }); if (r.ok && accept) await this.enter(r.body.party, true); return r; }
  invite(userId) { return this.cloud.api("POST", "/api/party/invites", { userId }); }
  cancelInvite(id) { return this.cloud.api("DELETE", `/api/party/invites/${id}`); }
  async kick(userId) { return this.cloud.api("POST", "/api/party/kick", { userId }); }
  async leave() { const r = await this.cloud.api("POST", "/api/party/leave"); await this.exit("left"); return r; }
  /** page start / login: if the account is in a party, rejoin it (listening; the microphone only if the browser already allows it) */
  async restore() {
    const r = await this.cloud.api("GET", "/api/party/me"); if (!r.ok) return null;
    if (r.body.party && !this.party) await this.enter(r.body.party, false);
    else if (!r.body.party && this.party) await this.exit("gone");
    return r.body.party;
  }
  async refresh() {
    const r = await this.cloud.api("GET", "/api/party/me"); if (!r.ok) return;
    if (!r.body.party) { await this.exit("gone"); return; }
    this.setParty(r.body.party); if (this.mesh) this.mesh.sync([...this.members.keys()]); this.emit();
  }
  setParty(party) {
    this.party = party; const keep = new Map(this.members);
    this.members = new Map(party.members.map((m) => { const old = keep.get(m.userId) || {}; return [m.userId, { ...m, muted: old.muted ?? false, speaking: false, conn: old.conn || (m.userId === this.me ? "self" : "connecting"), volume: this.volumes.get(m.userId) ?? 1 }]; }));
  }

  // ---------------------------------------------------------------- joining the voice (user gesture: create / accept / ATTIVA)
  async enter(party, withMic) {
    this.me = this.cloud.user.userId; this.setParty(party); this.state = "connecting";
    this.ensureAudio();
    this.mesh = new P2PMesh({ me: this.me, ice: () => this.iceNow || { iceServers: [] }, send: (to, data) => this.signal && this.signal.send({ t: "signal", to, data }), onRemote: (p) => this.attachRemote(p), onRemoteGone: (p) => this.detachRemote(p), onPeerState: (p) => { const m = this.members.get(p.uid); if (m) { m.conn = p.conn; this.emit(); } } });
    this.iceNow = await loadIce(this.cloud, this.o.opt);
    this.signal = new PartySignal(this.cloud, {
      onOpen: (again) => { this.state = "connected"; if (again) this.counters.signalReconnects++; this.emit(); if (this.localTrack) this.signal.send({ t: "state", muted: this.muted }); },
      onMessage: (m) => this.onSignalMessage(m),
      onClose: () => { if (this.state === "connected") this.state = "reconnecting"; this.emit(); },
      onGone: (why) => this.exit(why),
    });
    this.signal.start(); this.joined = true; this.startLoop(); this.emit();
    if (withMic) await this.enableMic(); else this.maybeSilentMic();
  }
  async exit(why = "left") {
    const had = !!this.party; this.joined = false; clearInterval(this.timer); this.timer = 0;
    if (this.signal) { this.signal.stop(); this.signal = null; } if (this.mesh) { this.mesh.close(); this.mesh = null; }
    this.releaseMic(); this.party = null; this.members = new Map(); this.state = "idle"; this.exitReason = why;
    if (this.ctx) { try { await this.ctx.close(); } catch { /* closed */ } this.ctx = null; this.master = null; }
    if (this.o.duck) this.o.duck(1);
    if (had) this.emit();
  }
  onSignalMessage(m) {
    if (m.t === "roster") { this.me = m.you; for (const r of m.members) { const x = this.members.get(r.userId); if (x) x.muted = !!r.muted; } this.mesh.connect(m.members.map((x) => x.userId)); this.emit(); }
    else if (m.t === "peer_joined") { this.mesh.appeared(m.userId); if (!this.members.has(m.userId)) this.refresh(); this.emit(); }
    // a member's SIGNALING dropped (screen lock, network blip): their voice connection may well be alive, so it is kept; a member who LEFT / was removed comes with a reason and is closed at once
    else if (m.t === "peer_left") { const x = this.members.get(m.userId); if (m.reason) { this.mesh.remove(m.userId); if (x) { x.conn = "left"; x.speaking = false; } } this.emit(); }
    else if (m.t === "signal") { this.mesh.onSignal(m.from, m.data); }
    else if (m.t === "state") { const x = this.members.get(m.userId); if (x) { x.muted = !!m.muted; this.emit(); } }
    else if (m.t === "party_update") this.refresh();
  }

  // ---------------------------------------------------------------- audio graph: remote voices -> per-peer gain -> analyser -> party master -> speakers (separate from the game's AudioContext)
  ensureAudio() {
    if (this.ctx && this.ctx.state !== "closed") return;
    const AC = self.AudioContext || self.webkitAudioContext; if (!AC) return;
    this.ctx = new AC({ latencyHint: "interactive" }); this.master = this.ctx.createGain(); this.master.gain.value = this.partyAudio ? 1 : 0; this.master.connect(this.ctx.destination);
    this.ctx.resume().catch(() => {});
  }
  attachRemote(p) {
    if (!p.stream) return; this.ensureAudio(); if (!this.ctx) return;
    // Chrome only delivers a remote WebRTC stream to Web Audio when it is also attached to a media element: a muted <audio> that plays nothing itself
    if (!p.audioEl) { const a = document.createElement("audio"); a.muted = true; a.autoplay = true; a.playsInline = true; a.srcObject = p.stream; a.style.display = "none"; document.body.append(a); p.audioEl = a; a.play().catch(() => {}); }
    try {
      p.src = this.ctx.createMediaStreamSource(p.stream); p.gain = this.ctx.createGain(); p.gain.gain.value = this.volumes.get(p.uid) ?? 1;
      p.analyser = this.ctx.createAnalyser(); p.analyser.fftSize = 512; p.buf = new Float32Array(p.analyser.fftSize);
      p.src.connect(p.gain); p.gain.connect(p.analyser); p.analyser.connect(this.master);
    } catch { /* no Web Audio: the muted element cannot play, nothing else to do */ }
  }
  detachRemote(p) { try { p.src && p.src.disconnect(); p.gain && p.gain.disconnect(); p.analyser && p.analyser.disconnect(); } catch { /* gone */ } if (p.audioEl) { p.audioEl.srcObject = null; p.audioEl.remove(); p.audioEl = null; } p.src = p.gain = p.analyser = null; }

  // ---------------------------------------------------------------- microphone: only on join / activation
  async enableMic() {
    this.micWanted = true; if (this.localTrack && this.localTrack.readyState === "live") { this.setMicTrackEnabled(); return true; }
    this.micState = "requesting"; this.emit();
    let stream = null;
    try {
      const gum = (c) => navigator.mediaDevices.getUserMedia(c);
      // echo cancellation / noise suppression / auto gain where the browser supports them; Safari may not expose every constraint: fall back to plain audio
      try { stream = await gum({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }); }
      catch (e) { if (e && (e.name === "OverconstrainedError" || e.name === "TypeError")) stream = await gum({ audio: true }); else throw e; }
    } catch (e) {
      this.micState = e && (e.name === "NotAllowedError" || e.name === "SecurityError") ? "denied" : "unavailable"; this.micErr = e && e.name || "error"; this.emit(); return false;
    }
    this.localStream = stream; this.localTrack = stream.getAudioTracks()[0]; this.localTrack.onended = () => { this.localTrack = null; this.localStream = null; this.micState = "off"; if (this.micWanted) setTimeout(() => this.enableMic(), 400); this.emit(); };   // unplugged / switched device
    this.micState = "on"; this.setMicTrackEnabled(); this.mesh && this.mesh.setLocalTrack(this.localTrack);
    try { this.ensureAudio(); if (this.ctx) { const src = this.ctx.createMediaStreamSource(stream); this.localAnalyser = this.ctx.createAnalyser(); this.localAnalyser.fftSize = 512; this.localBuf = new Float32Array(512); src.connect(this.localAnalyser); } } catch { /* no speaking indicator for me */ }
    if (this.signal) this.signal.send({ t: "state", muted: this.muted });
    this.emit(); return true;
  }
  /** after a reload: take the microphone silently only if the browser already granted it (no prompt at start) */
  async maybeSilentMic() {
    try { const s = await navigator.permissions.query({ name: "microphone" }); if (s.state === "granted") await this.enableMic(); } catch { /* Permissions API missing (Safari): the user taps ATTIVA MICROFONO */ }
  }
  releaseMic() { this.micWanted = false; if (this.localStream) for (const t of this.localStream.getTracks()) { t.onended = null; t.stop(); } this.localStream = null; this.localTrack = null; this.localAnalyser = null; this.micState = "off"; }
  setMicTrackEnabled() { if (this.localTrack) this.localTrack.enabled = !this.muted; }
  setMuted(v) { this.muted = !!v; this.setMicTrackEnabled(); if (this.signal) this.signal.send({ t: "state", muted: this.muted }); this.emit(); }
  toggleMute() { if (this.micState !== "on") { this.enableMic(); return; } this.setMuted(!this.muted); }
  /** DISATTIVA AUDIO PARTY: stop hearing the others (the microphone is not affected) */
  setPartyAudio(on) { this.partyAudio = !!on; if (this.master) this.master.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.03); this.emit(); }
  setVolume(uid, v) { v = Math.max(0, Math.min(1.5, v)); this.volumes.set(uid, v); const p = this.mesh && this.mesh.peers.get(uid); if (p && p.gain) p.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.03); const m = this.members.get(uid); if (m) m.volume = v; this.emit(); }
  setDuck(on) { this.duckOn = !!on; if (!on && this.o.duck) this.o.duck(1); }
  async deviceChanged() { if (this.micWanted && (!this.localTrack || this.localTrack.readyState !== "live")) await this.enableMic(); }

  // ---------------------------------------------------------------- loop: speaking indicator, ducking
  startLoop() {
    clearInterval(this.timer); const t0 = () => performance.now();
    this.timer = setInterval(() => {
      let changed = false, anyRemote = false; const now = t0();
      const rms = (an, buf) => { an.getFloatTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return Math.sqrt(s / buf.length); };
      if (this.localAnalyser) { const r = rms(this.localAnalyser, this.localBuf); if (r > SPEAK_RMS) this.localLoud = now; const sp = !this.muted && now - this.localLoud < 350; if (sp !== this.localSpeaking) { this.localSpeaking = sp; changed = true; } const me = this.members.get(this.me); if (me && me.speaking !== sp) me.speaking = sp; }
      if (this.mesh) for (const p of this.mesh.peers.values()) {
        if (!p.analyser) continue; const r = rms(p.analyser, p.buf); p.level = r; if (r > SPEAK_RMS) p.lastLoud = now;
        const sp = now - p.lastLoud < 350; if (sp !== p.speaking) { p.speaking = sp; const m = this.members.get(p.uid); if (m) m.speaking = sp; changed = true; } if (sp) anyRemote = true;
      }
      if (this.o.duck && this.duckOn) { if (anyRemote) { clearTimeout(this.duckRelease); this.duckRelease = 0; this.o.duck(0.35); } else if (!this.duckRelease) this.duckRelease = setTimeout(() => { this.duckRelease = 0; this.o.duck(1); }, 700); }
      if (changed) this.emit();
    }, 100);
  }

  // ---------------------------------------------------------------- mobile lifecycle: screen lock, app switch, network change
  async resume(why) {
    if (!this.joined) return;
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    if (this.micWanted && (!this.localTrack || this.localTrack.readyState !== "live")) this.enableMic();
    if (this.signal && !this.signal.alive()) { this.signal.attempt = 0; this.signal.ws = null; this.signal.open(); }
    else if (this.signal) { this.signal.send({ t: "ping" }); const before = this.signal.pongAt; await sleep(2500); if (this.signal && this.signal.pongAt === before && this.signal.ws) { try { this.signal.ws.close(); } catch { /* gone */ } } }   // a socket that stays silent after the page was suspended is dead
    if (this.mesh) this.mesh.check();
    this.emit(); void why;
  }
  async reconnectSignal() { if (this.signal) { this.signal.ws && this.signal.ws.close(); } }

  /** dev overlay: everything about the voice (no remote telemetry) */
  async stats() { const s = this.mesh ? await this.mesh.stats() : { peers: 0 }; return { ...s, signalReconnects: this.counters.signalReconnects, mic: this.micState, muted: this.muted, members: this.members.size, state: this.state, ctx: this.ctx ? this.ctx.state : "none" }; }
}
