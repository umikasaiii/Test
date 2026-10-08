// DSLink Cloud client for the PWA: account (passkey, with a password fallback), profile, friends, presence, invites and the library METADATA.
// Cloud is OPTIONAL. The emulator, the local library and Single Player never call it, never wait for it and keep working when it is unreachable: every call here is
// best effort and failures are values, not exceptions that could reach the player. Nothing private is ever sent: no ROM, BIOS, firmware, refs.json, save or radio frame.
//
// Where the Cloud lives needs no setup: cloud-config.json (written by the deploy/package step) says where /api, /signal and the presence socket are. Empty = this page's own origin
// (the Worker serves the PWA itself). ?cloud=URL / ?signal=URL are developer overrides only.
export const DEFAULT_CONFIG = { api: "", signal: "", ws: "" };
const trim = (u) => String(u || "").replace(/\/$/, "");

export async function loadConfig(opt) {
  let c = { ...DEFAULT_CONFIG };
  try { const r = await fetch(new URL("./cloud-config.json", import.meta.url), { cache: "no-cache" }); if (r.ok) { const j = await r.json(); if (j && typeof j === "object") c = { ...c, ...j }; } } catch { /* offline or not deployed with a config: same origin */ }
  const dev = opt && opt("cloud", ""); if (dev) c = { api: trim(dev), signal: trim(dev), ws: trim(dev) };
  const sg = opt && opt("signal", ""); if (sg) c.signal = trim(sg);
  c.api = trim(c.api); c.signal = trim(c.signal); c.ws = trim(c.ws);
  self.__dslinkConfig = c;
  return c;
}

// ---- WebAuthn JSON <-> browser objects (explicit conversion: works on every browser that has WebAuthn, no dependency on the newer *FromJSON helpers)
const b64uToBuf = (s) => { const p = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4); const bin = atob(p), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u.buffer; };
const bufToB64u = (b) => { const u = new Uint8Array(b); let s = ""; for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
export const passkeysSupported = () => !!(self.PublicKeyCredential && navigator.credentials && navigator.credentials.create && self.isSecureContext);

export class Cloud {
  constructor(config) {
    this.cfg = config; this.user = null; this.state = "unknown";          // unknown | anon | user | offline
    this.listeners = new Set(); this.ws = null; this.wsTimer = 0; this.pingTimer = 0; this.wantPresence = false; this.myState = { state: "online", gameId: "" };
    this.friends = []; this.requests = { incoming: [], outgoing: [] }; this.invites = { incoming: [], outgoing: [] }; this.library = []; this.blocked = [];
    this.presence = "OFFLINE";
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const f of this.listeners) { try { f(ev, this); } catch { /* a listener never breaks the client */ } } }

  async api(method, path, body) {
    let r;
    try {
      r = await fetch(this.cfg.api + path, { method, credentials: "include", headers: body !== undefined ? { "content-type": "application/json" } : undefined, body: body !== undefined ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined });
    } catch { if (this.state !== "anon") this.state = this.user ? "user" : "offline"; return { ok: false, status: 0, error: "network", body: {} }; }
    let j = {}; try { j = await r.json(); } catch { /* empty */ }
    return { ok: r.ok, status: r.status, error: r.ok ? "" : (j.error || "http_" + r.status), body: j };
  }

  // ---------------------------------------------------------------- session
  /** restore the session at startup (the cookie is HttpOnly: this is the only way to know). Never throws, never blocks the app. */
  async restore() {
    const r = await this.api("GET", "/api/me");
    if (r.ok) { this.user = r.body.user; this.passkeys = r.body.passkeys; this.avatars = r.body.avatars; this.state = "user"; this.emit("login"); this.startPresence(); await this.refreshAll(); }
    else if (r.status === 401) { this.user = null; this.state = "anon"; this.emit("anon"); }
    else { this.user = null; this.state = "offline"; this.emit("offline"); }
    return this.state;
  }
  async afterLogin(r) {
    if (!r.ok) return r;
    this.user = r.body.user; this.state = "user"; this.emit("login"); this.startPresence(); await this.refreshAll(); return r;
  }
  async registerPassword(username, password, displayName) { return this.afterLogin(await this.api("POST", "/api/auth/register", { username, password, ...(displayName ? { displayName } : {}) })); }
  async loginPassword(username, password) { return this.afterLogin(await this.api("POST", "/api/auth/login", { username, password })); }

  async registerPasskey(username, displayName) {
    if (!passkeysSupported()) return { ok: false, error: "passkeys_unsupported", body: {} };
    const o = await this.api("POST", "/api/auth/passkey/register/options", { username, ...(displayName ? { displayName } : {}) });
    if (!o.ok) return o;
    const opts = o.body.options;
    let cred;
    try {
      cred = await navigator.credentials.create({ publicKey: { ...opts, challenge: b64uToBuf(opts.challenge), user: { ...opts.user, id: b64uToBuf(opts.user.id) }, excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) } });
    } catch (e) { return { ok: false, error: e && e.name === "NotAllowedError" ? "cancelled" : "passkey_failed", body: {} }; }
    const resp = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment || undefined, clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON), attestationObject: bufToB64u(cred.response.attestationObject), transports: cred.response.getTransports ? cred.response.getTransports() : [] } };
    return this.afterLogin(await this.api("POST", "/api/auth/passkey/register/verify", { cid: o.body.cid, response: resp }));
  }
  async loginPasskey() {
    if (!passkeysSupported()) return { ok: false, error: "passkeys_unsupported", body: {} };
    const o = await this.api("POST", "/api/auth/passkey/login/options", {});
    if (!o.ok) return o;
    const opts = o.body.options;
    let cred;
    try { cred = await navigator.credentials.get({ publicKey: { ...opts, challenge: b64uToBuf(opts.challenge), allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })) } }); }
    catch (e) { return { ok: false, error: e && e.name === "NotAllowedError" ? "cancelled" : "passkey_failed", body: {} }; }
    const resp = { id: cred.id, rawId: bufToB64u(cred.rawId), type: cred.type, clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      response: { clientDataJSON: bufToB64u(cred.response.clientDataJSON), authenticatorData: bufToB64u(cred.response.authenticatorData), signature: bufToB64u(cred.response.signature), userHandle: cred.response.userHandle ? bufToB64u(cred.response.userHandle) : "" } };
    return this.afterLogin(await this.api("POST", "/api/auth/passkey/login/verify", { cid: o.body.cid, response: resp }));
  }
  async logout() {
    this.stopPresence(); await this.api("POST", "/api/auth/logout", {});
    this.user = null; this.state = "anon"; this.friends = []; this.invites = { incoming: [], outgoing: [] }; this.requests = { incoming: [], outgoing: [] }; this.library = []; this.emit("logout");
  }
  sessions() { return this.api("GET", "/api/auth/sessions"); }
  revokeSession(id) { return this.api("DELETE", "/api/auth/sessions/" + id); }
  revokeOthers() { return this.api("POST", "/api/auth/sessions/revoke-others", {}); }
  async updateProfile(p) { const r = await this.api("PATCH", "/api/me", p); if (r.ok) { this.user = r.body.user; this.emit("profile"); } return r; }

  // ---------------------------------------------------------------- social
  async refreshAll() { await Promise.all([this.loadFriends(), this.loadRequests(), this.loadInvites(), this.loadLibrary()]); this.emit("data"); }
  async loadFriends() { const r = await this.api("GET", "/api/friends"); if (r.ok) this.friends = r.body.friends; return r; }
  async loadRequests() { const r = await this.api("GET", "/api/friends/requests"); if (r.ok) this.requests = r.body; return r; }
  async loadInvites() { const r = await this.api("GET", "/api/play/invites"); if (r.ok) this.invites = r.body; return r; }
  async loadBlocked() { const r = await this.api("GET", "/api/blocks"); if (r.ok) this.blocked = r.body.blocked; return r; }
  search(q) { return this.api("GET", "/api/users/search?q=" + encodeURIComponent(q)); }
  sendRequest(username) { return this.api("POST", "/api/friends/requests", { username }); }
  acceptRequest(id) { return this.api("POST", `/api/friends/requests/${id}/accept`, {}); }
  refuseRequest(id) { return this.api("POST", `/api/friends/requests/${id}/refuse`, {}); }
  cancelRequest(id) { return this.api("DELETE", `/api/friends/requests/${id}`); }
  removeFriend(userId) { return this.api("DELETE", `/api/friends/${userId}`); }
  block(username) { return this.api("POST", "/api/blocks", { username }); }
  unblock(userId) { return this.api("DELETE", `/api/blocks/${userId}`); }

  // ---------------------------------------------------------------- invites (to a signaling room)
  invite(friendId, gameId) { return this.api("POST", "/api/play/invites", { friendId, gameId }); }
  respondInvite(id, accept) { return this.api("POST", `/api/play/invites/${id}/respond`, { accept }); }
  cancelInvite(id) { return this.api("DELETE", `/api/play/invites/${id}`); }

  // ---------------------------------------------------------------- library metadata (never the files)
  async loadLibrary() { const r = await this.api("GET", "/api/cloud/library"); if (r.ok) this.library = r.body.entries; return r; }
  /** push the metadata of this device's local library (title, platform, product code...): the cloud learns WHICH games the account has, never the files */
  async syncLibrary(entries) { if (this.state !== "user" || !entries.length) return { ok: false, error: "skipped", body: {} }; const r = await this.api("POST", "/api/cloud/library/sync", { entries }); if (r.ok) await this.loadLibrary(); return r; }
  markPlayed(gameId) { return this.state === "user" ? this.api("POST", `/api/cloud/library/${gameId}/played`, {}) : Promise.resolve({ ok: false }); }
  setFavorite(gameId, favorite) { return this.api("POST", `/api/cloud/library/${gameId}/favorite`, { favorite }); }
  removeEntry(gameId) { return this.api("DELETE", `/api/cloud/library/${gameId}`); }

  // ---------------------------------------------------------------- presence (realtime WebSocket: OFFLINE / ONLINE / MENU / IN_GAME)
  wsBase() {
    const w = this.cfg.ws || this.cfg.api || location.origin;
    return w.replace(/^http/, "ws");
  }
  startPresence() { this.wantPresence = true; if (!this.ws) this.openSocket(0); }
  stopPresence() { this.wantPresence = false; clearTimeout(this.wsTimer); clearInterval(this.pingTimer); if (this.ws) { try { this.ws.send(JSON.stringify({ t: "bye" })); } catch { /* closing */ } try { this.ws.close(); } catch { /* closed */ } this.ws = null; } this.presence = "OFFLINE"; }
  async openSocket(attempt) {
    if (!this.wantPresence || this.ws) return;
    const tk = await this.api("POST", "/api/ws-ticket", {});     // one-shot ticket: the socket needs no cookie, so it also works from a page on another origin
    if (!tk.ok) { if (tk.status === 401) { this.user = null; this.state = "anon"; this.emit("anon"); return; } this.scheduleReconnect(attempt); return; }
    let ws;
    try { ws = new WebSocket(`${this.wsBase()}/api/ws?ticket=${encodeURIComponent(tk.body.ticket)}`); } catch { this.scheduleReconnect(attempt); return; }
    this.ws = ws;
    ws.onopen = () => { attempt = 0; this.sendState(); clearInterval(this.pingTimer); this.pingTimer = setInterval(() => { try { ws.send('{"t":"ping"}'); } catch { /* gone */ } }, 20000); };
    ws.onmessage = (e) => { let m; try { m = JSON.parse(e.data); } catch { return; } this.onEvent(m); };
    ws.onclose = () => { clearInterval(this.pingTimer); if (this.ws === ws) this.ws = null; this.presence = "OFFLINE"; if (this.wantPresence) this.scheduleReconnect(attempt); };
    ws.onerror = () => { /* onclose follows */ };
  }
  scheduleReconnect(attempt) { clearTimeout(this.wsTimer); this.wsTimer = setTimeout(() => this.openSocket(attempt + 1), Math.min(30000, 1000 * 2 ** Math.min(attempt, 5))); }
  /** what THIS device is doing: "online" | "menu" | "game" (+ catalog game id) */
  setActivity(state, gameId = "") { this.myState = { state, gameId }; this.sendState(); }
  sendState() { if (this.ws && this.ws.readyState === 1) { try { this.ws.send(JSON.stringify({ t: "state", state: this.myState.state, ...(this.myState.gameId ? { gameId: this.myState.gameId } : {}) })); } catch { /* gone */ } } }
  onEvent(m) {
    switch (m.t) {
      case "hello": case "self_presence": this.presence = m.status; this.emit("self"); break;
      case "presence": { const f = this.friends.find((x) => x.userId === m.userId); if (f) { f.status = m.status; f.game = m.game || null; } this.emit("presence"); break; }
      case "friend_request": case "friend_update": this.loadFriends().then(() => this.loadRequests()).then(() => this.emit("data")); this.emit("notice", m); break;
      case "invite": this.loadInvites().then(() => this.emit("data")); this.emit("invite", m); break;
      case "invite_update": this.loadInvites().then(() => this.emit("data")); this.emit("invite_update", m); break;
      default: break;
    }
  }
}
