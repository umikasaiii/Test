// DSLink PWA signaling room: the MINIMUM needed to let two browsers build a WebRTC connection. One room = one host + at most one guest, identified by a 6-digit code.
// It relays small JSON messages (offer / answer / ICE candidates / bye) and tells each side when the other joined or left. That is all:
//   - rooms are ephemeral (they expire after TTL of inactivity, and close when the host leaves)
//   - nothing is stored: no ROM, save, BIOS, firmware, account or log of the traffic; relayed messages are validated and size-capped
// Written once with web-standard APIs (Request/Response/ReadableStream) and used by BOTH the Node development/LAN server (dev_server.mjs) and the Worker's Durable Object (cloud/worker/src/signal.ts).
export const KINDS = new Set(["offer", "answer", "ice", "bye", "hello"]);
export const MAX_MSG = 16384;
const enc = new TextEncoder();

export function validMessage(d) {
  if (!d || typeof d !== "object" || Array.isArray(d) || !KINDS.has(d.k)) return false;
  let s; try { s = JSON.stringify(d); } catch { return false; }
  return s.length <= MAX_MSG;
}
export const token = () => { const a = new Uint8Array(16); crypto.getRandomValues(a); return [...a].map((b) => b.toString(16).padStart(2, "0")).join(""); };
export const newCode = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return String(a[0] % 1000000).padStart(6, "0"); };

export class Room {
  constructor(code, { ttlMs = 600000, graceMs = 6000, staleMs = 25000, inviteOnly = false, now = () => Date.now() } = {}) {
    this.code = code; this.ttlMs = ttlMs; this.graceMs = graceMs; this.staleMs = staleMs; this.now = now; this.seen = { host: now(), guest: now() };
    this.tok = { host: token(), guest: null }; this.stream = { host: null, guest: null }; this.timer = { host: 0, guest: 0 };
    this.guestEver = false; this.closed = false; this.touch(); this.queued = { host: [], guest: [] };
    // an invite room is created for ONE known guest: its token exists from the start (handed to the invitee by the account API), the public code can never take the seat
    this.inviteOnly = inviteOnly; if (inviteOnly) this.tok.guest = token();
    this.hostEver = false; this.phase = null; this.lastState = "CREATED";
  }
  /** CREATED > WAITING > READY > STARTING > IN_GAME, DISCONNECTED when a side vanishes mid-session, CLOSED at the end. Derived from who is connected + the host's phase. */
  computeState() {
    if (this.closed) return "CLOSED";
    const host = !!this.stream.host, guest = !!this.stream.guest;
    if (!host) return this.hostEver ? "DISCONNECTED" : "CREATED";
    if (!guest) return this.phase ? "DISCONNECTED" : "WAITING";
    return this.phase || "READY";
  }
  get state() { return this.computeState(); }
  refresh() { const s = this.computeState(); if (s === this.lastState) return; this.lastState = s; this.emit("host", "state", { state: s }); this.emit("guest", "state", { state: s }); }
  /** the host moves the room through its lobby phases (READY = back to the lobby, STARTING, IN_GAME) */
  setPhase(role, phase) {
    if (this.closed) return { error: "no_room", status: 404 };
    if (role !== "host") return { error: "host_only", status: 403 };
    if (!["READY", "STARTING", "IN_GAME"].includes(phase)) return { error: "bad_state", status: 400 };
    if (!this.stream.host || !this.stream.guest) return { error: "not_ready", status: 409 };
    this.touch(); this.phase = phase === "READY" ? null : phase; this.refresh(); return { ok: true, state: this.computeState() };
  }
  touch() { this.last = this.now(); }
  expired() { return this.closed || this.now() - this.last > this.ttlMs; }
  roleOf(t) { return t && t === this.tok.host ? "host" : t && this.tok.guest && t === this.tok.guest ? "guest" : null; }

  /** a guest takes the free slot (a second guest is refused; a guest that left can be replaced) */
  join() {
    if (this.closed) return { error: "no_room", status: 404 };
    if (this.tok.guest) return { error: "full", status: 409 };       // (an invite room is always "full": the seat is reserved)
    this.tok.guest = token(); this.guestEver = true; this.touch();
    this.emit("host", "peer", { state: "joined" });
    return { token: this.tok.guest };
  }
  /** SSE response for one side. Events: hello (role + peer presence), peer {state}, msg {data}, closed {why}. Messages sent before the stream opened are replayed. */
  subscribe(role) {
    if (this.closed) return null;
    const self = this; let ctl;
    const stream = new ReadableStream({
      start(c) { ctl = c; },
      cancel() { if (self.stream[role] === ctl) { self.stream[role] = null; self.scheduleLeave(role); self.refresh(); } },
    });
    if (this.stream[role]) { try { this.stream[role].close(); } catch { /* already closed */ } }
    this.stream[role] = ctl; clearTimeout(this.timer[role]); this.touch(); this.seen[role] = this.now();
    if (role === "host") this.hostEver = true; else this.guestEver = true;
    this.write(ctl, "hello", { role, peer: role === "host" ? !!this.tok.guest && !!this.stream.guest : true, state: this.computeState(), inviteOnly: this.inviteOnly });
    for (const q of this.queued[role].splice(0)) this.write(ctl, q.event, q.data);
    if (role === "guest") this.emit("host", "peer", { state: "joined" });
    this.refresh();
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream", "cache-control": "no-store", "x-accel-buffering": "no", "access-control-allow-origin": "*" } });
  }
  write(ctl, event, data) { try { ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); return true; } catch { return false; } }
  emit(role, event, data) {
    const c = this.stream[role];
    if (c && this.write(c, event, data)) return true;
    if (event === "msg") { const q = this.queued[role]; q.push({ event, data }); if (q.length > 64) q.shift(); }
    return false;
  }
  ping() {                                                       // keep open streams alive; a failed write, or silence for staleMs, means that side's page is gone
    if (this.closed) return; const t = this.now();
    for (const r of ["host", "guest"]) {
      if (r === "guest" && !this.tok.guest) continue;
      if (this.stream[r]) { try { this.stream[r].enqueue(enc.encode(": ping\n\n")); } catch { this.stream[r] = null; this.scheduleLeave(r); this.refresh(); } }
      if (this.stream[r] && t - this.seen[r] > this.staleMs) { this.stream[r] = null; this.leave(r, "stale"); if (this.closed) return; }   // a stream believed open but silent: that page is gone
    }
  }
  /** relay a validated message to the other side */
  send(role, data) {
    if (this.closed) return { error: "no_room", status: 404 };
    if (!validMessage(data)) return { error: "bad_message", status: 400 };
    this.touch(); this.seen[role] = this.now(); const to = role === "host" ? "guest" : "host";
    if (data.k === "hello") return { ok: true, delivered: false };                // heartbeat: proves this page is alive, relayed to nobody
    if (data.k === "bye") { this.leave(role, "bye"); return { ok: true, delivered: true }; }
    return { ok: true, delivered: this.emit(to, "msg", { data }) };
  }
  scheduleLeave(role) { clearTimeout(this.timer[role]); this.timer[role] = setTimeout(() => { if (!this.stream[role]) this.leave(role, "disconnected"); }, this.graceMs); }
  leave(role, why = "left") {
    if (this.closed) return;
    clearTimeout(this.timer[role]);
    if (role === "host") { this.emit("guest", "closed", { why }); this.close(); return; }
    const gone = why === "bye" || why === "left";                    // an explicit goodbye ends the lobby phase; a vanished page (stale / disconnected) only pauses it: the guest may come back
    if (gone) this.phase = null;
    if (!this.inviteOnly && (gone || !this.phase)) this.tok.guest = null;   // a public room frees the seat (an invite room keeps it for the invitee until it expires; so does a game in progress)
    if (this.stream.guest) { try { this.stream.guest.close(); } catch { /* closed */ } this.stream.guest = null; }
    this.queued.guest = []; this.emit("host", "peer", { state: "left" }); this.refresh();
  }
  close() {
    if (!this.closed) { this.closed = true; this.lastState = "CLOSED"; this.emit("host", "state", { state: "CLOSED" }); this.emit("guest", "state", { state: "CLOSED" }); }
    this.closed = true; for (const r of ["host", "guest"]) { clearTimeout(this.timer[r]); if (this.stream[r]) { try { this.stream[r].close(); } catch { /* closed */ } this.stream[r] = null; } }
  }
}

export const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" };
export const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS } });
