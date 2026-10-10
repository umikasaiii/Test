// Distributed session (two PWAs, one DataChannel): room creation/joining through the minimal signaling service, the WebRTC connection (RadioPeer), the two-player lobby and the
// pre-start link quality gate. Nothing here touches the emulator; the game itself runs on each device and only DS radio frames cross the DataChannel.
// The signaling service only ever sees the 6-digit code, two random tokens and WebRTC offer/answer/ICE messages. No ROM, save, BIOS or firmware leaves the device.
import { RadioPeer } from "./radio-peer.js";
import { classify, chooseMode, outageLimit } from "./netquality.js";

const HEARTBEAT_MS = 8000;

/** Base URL of the signaling service. Normal use needs NO configuration: the DSLink Cloud address comes from cloud-config.json, written at deploy time (see cloud.js).
 *  ?signal=URL is only a developer override (tests, a LAN server); with no config at all the page's own origin is used (the Worker serves /signal on the same host). */
export function signalBase(opt) {
  const v = opt && opt("signal", ""); if (v) return String(v).replace(/\/$/, "");
  const c = self.__dslinkConfig && self.__dslinkConfig.signal; if (c) return String(c).replace(/\/$/, "");
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
  /** a room created elsewhere (an accepted invite): both tokens are issued by the account API, nothing is created or joined by code */
  attach(code, token) { this.code = code; this.token = token; this.open(); return code; }
  /** the host moves the room through STARTING / IN_GAME (the room tells both sides; best effort) */
  setState(state) { if (this.closed) return; this.post("state", { code: this.code, token: this.token, state }).catch(() => {}); }
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
    this.dlplay = false; this.decision = null; this.forced = false; this.netEvents = 0; this.outages = []; this.me = { ready: false }; this.other = { present: false, ready: false, hidden: false, game: null }; this.quality = null; this.qualityBusy = false; this.gameOk = o.role === "host";
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
  /** enter a room made by an accepted invite: no code to type, the tokens already say who is who */
  attach(code, token) {
    this.code = code; this.wire(); this.change(this.role === "host" ? "waiting" : "connecting"); this.sig.attach(code, token);
    return code;
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
    this.peer = new RadioPeer({ role: this.role, iceServers: this.o.iceServers || [], iceTransportPolicy: this.o.iceTransportPolicy, radioMode: this.o.radioMode, impair: this.o.impair, signal: { send: (m) => this.sig.send(m) },
      onState: (s, why) => this.onPeerState(s, why), onCtl: (m) => this.onCtl(m), onRecovered: (ms) => this.onRecovered(ms) });
    this.attachNetwork();
  }
  dropPeer() { this.detachNetwork(); if (this.peer) { this.peer.close(); this.peer = null; } }

  onPeerState(s, why) {
    if (s === "open" && this.state !== "playing" && this.state !== "starting") {
      this.timing.connectMs = performance.now() - this.t0; this.other.present = true;
      this.peer.sendCtl({ t: "hello", role: this.role, game: this.o.game || null });
      this.change("lobby");
      if (this.role === "host") this.measure();
    } else if (s === "lost") this.lost(why || "connessione persa");
    else this.change();
  }
  lost(why) { if (this.state === "closed") return; this.detachNetwork(); this.why = why; this.state = "lost"; if (this.o.onLost) this.o.onLost(why); this.change(); }

  /** the network profile of THIS game (the host knows its game; the guest learns it from the host's hello) */
  profile() { const g = this.role === "host" ? this.o.game : this.hostGame; return this.o.profileOf ? this.o.profileOf(g) : "UNKNOWN"; }
  hostedAvailable() { return !!(this.o.hostedAvailable && this.o.hostedAvailable()); }
  /** PRE-START quality gate: a few seconds on the SAME channel and settings the game will use + the ICE path, classified for this game's profile, then a mode decision.
   *  Nothing is started silently on a link that is probably too slow: the lobby asks (RIPROVA / CONTINUA COMUNQUE / USA MODALITA HOSTED). */
  async measure(ms = 2500) {
    if (this.qualityBusy || !this.peer) return; this.qualityBusy = true; this.forced = false; this.change();
    let pre; try { pre = await this.peer.preflight(ms); } catch { pre = null; }
    const profile = this.profile(), q = classify(pre, profile), d0 = chooseMode({ path: pre ? pre.path : "unknown", quality: q, profile, hostedAvailable: this.hostedAvailable() });
    // the gate belongs to Internet rooms (ICE servers present); a local / LAN room keeps the measure-only behaviour of the local Distributed mode
    const d = (this.o.iceServers || []).length ? d0 : { ...d0, block: false, warn: false, actions: [], message: "" };
    this.quality = { ...q, probe: pre, path: pre ? pre.path : "unknown", profile }; this.decision = d; this.qualityBusy = false;
    if (this.peer) this.peer.sendCtl({ t: "quality", level: q.level, label: q.label, oneWayMs: q.oneWayMs, path: this.quality.path, profile, mode: d.mode, block: d.block, warn: d.warn, message: d.message });
    this.change();
  }
  /** RIPROVA */
  retryMeasure() { return this.measure(); }
  /** CONTINUA COMUNQUE: the user accepts the risk for this session */
  continueAnyway() { this.forced = true; if (this.peer) this.peer.sendCtl({ t: "forced" }); this.change(); }
  /** USA MODALITA HOSTED: only when a compatible Hosted host exists on the device (never invented) */
  useHosted() { if (!this.hostedAvailable()) return false; return !!(this.o.startHosted && this.o.startHosted(this)); }

  // ---- network changes (Wi-Fi <-> mobile, sleep/resume, NAT rebinding): pause, restart ICE, verify, resume - or end cleanly
  attachNetwork() {
    if (this.netOff || typeof window === "undefined") return;
    const fire = (why) => { if (this.peer && this.state !== "closed" && this.state !== "lost") { this.netEvents++; this.peer.networkChanged(why); this.change(); } };
    const on = () => fire("online"), off = () => fire("offline"), conn = () => fire("connection");
    window.addEventListener("online", on); window.addEventListener("offline", off); const c = navigator.connection; if (c && c.addEventListener) c.addEventListener("change", conn);
    this.netOff = () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); if (c && c.removeEventListener) c.removeEventListener("change", conn); this.netOff = null; };
  }
  detachNetwork() { if (this.netOff) this.netOff(); }
  /** the link came back after `ms` of radio silence */
  async onRecovered(ms) {
    this.outages.push(ms);
    if (this.state === "playing") {
      if (ms > outageLimit(this.profile())) this.lost("La connessione è stata interrotta troppo a lungo per questo gioco.");     // the DS side has given up: end cleanly, say why
      else this.change();
    } else if (this.state === "lobby" && this.role === "host") this.measure(1500);                                                        // verify the new link before the game starts
    else this.change();
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
    else if (m.t === "quality") { if (this.role === "guest") { this.quality = { level: m.level, label: m.label, oneWayMs: m.oneWayMs, path: m.path, profile: m.profile }; this.decision = { mode: m.mode, block: !!m.block, warn: !!m.warn, message: m.message || "", actions: [], relay: m.path === "relay" }; this.change(); } }
    else if (m.t === "forced") { this.forced = true; this.change(); }
    else if (m.t === "start") { if (this.role === "guest" && this.state === "lobby") this.begin(); }
    else if (m.t === "vis") { this.other.hidden = !!m.hidden; this.change(); }
    else if (m.t === "bye") { if (this.role === "host" && this.state === "lobby") return; if (this.state !== "closed") this.lost("il giocatore ha lasciato la partita"); }   // a guest leaving the lobby just frees the slot (signaling says "left")
  }
  setReady(v) { this.me.ready = !!v; if (this.peer) this.peer.sendCtl({ t: "ready", v: !!v }); this.change(); }
  /** why the host cannot start yet (shown in the lobby; the room is kept): missing screen references / system files / high-performance mode for Download Play */
  hostBlock() { return this.role === "host" && this.o.hostCheck ? this.o.hostCheck(this) : ""; }
  canStart() { return this.role === "host" && this.state === "lobby" && this.other.ready && !!this.peer && this.peer.state === "open" && !this.hostBlock() && !this.netBlock(); }
  /** the quality gate says "probably too slow" and nobody chose CONTINUA COMUNQUE (nor is the link still being measured) */
  netBlock() { return this.role === "host" && (this.qualityBusy || (this.decision && this.decision.block && !this.forced)); }
  /** host: START (the guest has said PRONTO) */
  start() { if (!this.canStart()) return false; this.peer.sendCtl({ t: "start" }); this.begin(); return true; }
  begin() { this.change("starting"); if (this.role === "host") this.sig.setState("STARTING"); if (this.o.onStart) this.o.onStart(this); }
  playing() { this.change("playing"); if (this.role === "host") this.sig.setState("IN_GAME"); }

  async close(why = "") {
    if (this.state === "closed") return; this.detachNetwork();
    if (this.peer) { this.peer.sendCtl({ t: "bye" }); }
    const s = this.sig; const p = this.peer; this.state = "closed"; this.peer = null;
    await s.leave(); if (p) setTimeout(() => p.close(), 50);                                     // let the bye leave before the channel closes
    if (this.o.onChange) this.o.onChange(this);
  }
}
