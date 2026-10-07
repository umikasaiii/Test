// Distributed session (two PWAs, one DataChannel): room creation/joining through the minimal signaling service, the WebRTC connection (RadioPeer), the two-player lobby and the
// pre-start link quality gate. Nothing here touches the emulator; the game itself runs on each device and only DS radio frames cross the DataChannel.
// The signaling service only ever sees the 6-digit code, two random tokens and WebRTC offer/answer/ICE messages. No ROM, save, BIOS or firmware leaves the device.
import { RadioPeer, rateQuality } from "./radio-peer.js";

const HEARTBEAT_MS = 8000;

/** Base URL of the signaling service: ?signal=URL (tests, LAN) > the page's own origin (the Worker serves /signal on the same host). */
export function signalBase(opt) {
  const v = opt && opt("signal", ""); if (v) return String(v).replace(/\/$/, "");
  return location.origin;
}

export class SignalClient {
  constructor(base) { this.base = base; this.code = ""; this.token = ""; this.es = null; this.hb = 0; this.onMsg = () => {}; this.onPeer = () => {}; this.onClosed = () => {}; this.onLink = () => {}; this.closed = false; }
  async post(path, body) {
    const r = await fetch(this.base + "/signal/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    let j = {}; try { j = await r.json(); } catch { /* empty */ }
    return { status: r.status, j };
  }
  async create() { const r = await this.post("create", {}); if (r.status !== 200) throw new Error("create:" + r.status); this.code = r.j.code; this.token = r.j.token; this.ttlSec = r.j.ttlSec; this.open(); return this.code; }
  async join(code) {
    const r = await this.post("join", { code }); if (r.status !== 200) { const e = new Error(r.j.error || "join:" + r.status); e.status = r.status; throw e; }
    this.code = code; this.token = r.j.token; this.open(); return code;
  }
  open() {
    this.es = new EventSource(`${this.base}/signal/events?code=${this.code}&token=${this.token}`);
    const j = (e) => { try { return JSON.parse(e.data); } catch { return {}; } };
    this.es.addEventListener("msg", (e) => this.onMsg(j(e).data));
    this.es.addEventListener("peer", (e) => this.onPeer(j(e).state));
    this.es.addEventListener("hello", (e) => { const d = j(e); if (d.peer) this.onPeer("joined"); });
    this.es.addEventListener("closed", (e) => { this.onClosed(j(e).why || "closed"); });
    this.es.onerror = () => { if (this.es && this.es.readyState === 2 && !this.closed) this.onClosed("signaling"); };
    this.hb = setInterval(() => this.send({ k: "hello" }), HEARTBEAT_MS);             // proves this page is alive to the room
  }
  send(data) { if (this.closed) return; this.post("send", { code: this.code, token: this.token, data }).catch(() => {}); }
  async leave() {
    if (this.closed) return; this.closed = true; clearInterval(this.hb);
    if (this.es) { this.es.close(); this.es = null; }
    try { await this.post("leave", { code: this.code, token: this.token }); } catch { /* the room expires by itself */ }
  }
}

/** states: idle > waiting (host: room open) > connecting > lobby > starting > playing > lost | closed */
export class Session {
  /** @param {{role:'host'|'guest', base:string, game?:{id:string,code:string,title:string}, iceServers?:object[], radioMode?:object, impair?:object, onChange?:()=>void, onStart?:()=>void, onLost?:(why:string)=>void}} o */
  constructor(o) {
    this.o = o; this.role = o.role; this.sig = new SignalClient(o.base); this.peer = null; this.state = "idle"; this.code = ""; this.why = "";
    this.dlplay = false; this.me = { ready: false }; this.other = { present: false, ready: false, hidden: false, game: null }; this.quality = null; this.qualityBusy = false; this.gameOk = o.role === "host";
    this.t0 = performance.now(); this.timing = { connectMs: 0, firstFrameMs: 0 };
  }
  change(s, why) { if (this.state === "closed" && s !== "closed") return; if (s) { this.state = s; if (why) this.why = why; } if (this.o.onChange) this.o.onChange(this); }

  async create() {
    this.code = await this.sig.create(); this.wire(); this.change("waiting"); return this.code;
  }
  async join(code) {
    this.code = await this.sig.join(code); this.wire(); this.change("connecting");
    return this.code;
  }
  wire() {
    const sig = this.sig;
    sig.onMsg = (m) => { if (this.peer) this.peer.onSignal(m); };
    sig.onPeer = (st) => {
      if (this.role === "host" && st === "joined" && !this.peer) { this.makePeer(); this.change("connecting"); this.peer.begin().catch((e) => this.lost("signaling: " + e)); }
      if (this.role === "host" && st === "left" && this.state !== "playing" && this.state !== "starting") { this.dropPeer(); this.other = { present: false, ready: false, hidden: false, game: null }; this.quality = null; this.me.ready = false; this.change("waiting"); }
    };
    sig.onClosed = (why) => { if (this.state === "playing" || this.state === "starting") return; if (this.state !== "closed") this.lost(this.role === "guest" ? "la partita è stata chiusa dall'amico" : "stanza chiusa"); };
    if (this.role === "guest") this.makePeer();
  }
  makePeer() {
    this.peer = new RadioPeer({ role: this.role, iceServers: this.o.iceServers || [], radioMode: this.o.radioMode, impair: this.o.impair, signal: { send: (m) => this.sig.send(m) },
      onState: (s, why) => this.onPeerState(s, why), onCtl: (m) => this.onCtl(m) });
  }
  dropPeer() { if (this.peer) { this.peer.close(); this.peer = null; } }

  onPeerState(s, why) {
    if (s === "open" && this.state !== "playing" && this.state !== "starting") {
      this.timing.connectMs = performance.now() - this.t0; this.other.present = true;
      this.peer.sendCtl({ t: "hello", role: this.role, game: this.o.game || null });
      this.change("lobby");
      if (this.role === "host") this.measure();
    } else if (s === "lost") this.lost(why || "connessione persa");
    else this.change();
  }
  lost(why) { if (this.state === "closed") return; this.why = why; this.state = "lost"; if (this.o.onLost) this.o.onLost(why); this.change(); }

  /** quality gate: a few seconds of RTT/jitter/loss on the same channel and settings the game will use (host measures, tells the guest) */
  async measure(ms = 2500) {
    if (this.qualityBusy || !this.peer) return; this.qualityBusy = true; this.change();
    const p = await this.peer.probe(ms, 50), q = rateQuality(p); this.quality = { ...q, probe: p }; this.qualityBusy = false;
    if (this.peer) this.peer.sendCtl({ t: "quality", level: q.level, label: q.label, oneWayMs: q.oneWayMs });
    this.change();
  }
  onCtl(m) {
    if (m.t === "hello") {
      this.other.present = true; this.other.game = m.game;
      if (this.role === "guest") {
        this.gameOk = !!(m.game && this.o.hasGame && this.o.hasGame(m.game)); this.hostGame = m.game;
        // no copy of the game here: the friend's console sends it through the DS's own Download Play (no ROM ever travels), if this device has what the DS menu needs
        this.dlplay = !this.gameOk && !!(m.game && m.game.dlplay && this.o.canDownload && this.o.canDownload(m.game));
        if (this.peer) this.peer.sendCtl({ t: "mode", dl: this.dlplay, hp: !!self.crossOriginIsolated });
      }
      this.change();
    }
    else if (m.t === "mode") { this.dlplay = !!m.dl; this.other.hp = m.hp; this.change(); }
    else if (m.t === "ready") { this.other.ready = !!m.v; this.change(); }
    else if (m.t === "quality") { if (this.role === "guest") { this.quality = { level: m.level, label: m.label, oneWayMs: m.oneWayMs }; this.change(); } }
    else if (m.t === "start") { if (this.role === "guest" && this.state === "lobby") this.begin(); }
    else if (m.t === "vis") { this.other.hidden = !!m.hidden; this.change(); }
    else if (m.t === "bye") { if (this.role === "host" && this.state === "lobby") return; if (this.state !== "closed") this.lost("il giocatore ha lasciato la partita"); }   // a guest leaving the lobby just frees the slot (signaling says "left")
  }
  setReady(v) { this.me.ready = !!v; if (this.peer) this.peer.sendCtl({ t: "ready", v: !!v }); this.change(); }
  /** why the host cannot start yet (shown in the lobby; the room is kept): missing screen references / system files / high-performance mode for Download Play */
  hostBlock() { return this.role === "host" && this.o.hostCheck ? this.o.hostCheck(this) : ""; }
  canStart() { return this.role === "host" && this.state === "lobby" && this.other.ready && !!this.peer && this.peer.state === "open" && !this.hostBlock(); }
  /** host: START (the guest has said PRONTO) */
  start() { if (!this.canStart()) return false; this.peer.sendCtl({ t: "start" }); this.begin(); return true; }
  begin() { this.change("starting"); if (this.o.onStart) this.o.onStart(this); }
  playing() { this.change("playing"); }

  async close(why = "") {
    if (this.state === "closed") return;
    if (this.peer) { this.peer.sendCtl({ t: "bye" }); }
    const s = this.sig; const p = this.peer; this.state = "closed"; this.peer = null;
    await s.leave(); if (p) setTimeout(() => p.close(), 50);                                     // let the bye leave before the channel closes
    if (this.o.onChange) this.o.onChange(this);
  }
}
