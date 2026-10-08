// DSLink Cloud storage client: the user's OWN ROMs, BIOS/firmware and save history in their private Cloud space, synchronised with the local store.
// Rules this module keeps:
//  - the emulator only ever uses LOCAL files (OPFS / IndexedDB): a ROM from the Cloud is downloaded, hash-verified and stored locally BEFORE it runs; a save is never read or written over the network while a game runs;
//  - every Cloud call is best effort: a failure is a value ({ok:false, error}), never an exception that reaches the player, and never deletes or changes a local file;
//  - nothing here logs a file name, a hash or a byte of content.
import { sha256Hex } from "./sha256.js";

const CHUNK_RETRY = 3;
const hex = (u) => [...new Uint8Array(u)].map((b) => b.toString(16).padStart(2, "0")).join("");
const b64url = (u8) => { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const ERR_TEXT = {
  cloud_quota_exceeded: "Spazio Cloud esaurito. Il file resta sul dispositivo.", file_too_large: "File troppo grande per il Cloud.", save_too_large: "Il salvataggio è troppo grande per il Cloud.",
  storage_unavailable: "Il Cloud non riesce ad accedere ai file adesso. Riprova più tardi: nulla è andato perso.", network: "Cloud non raggiungibile. Il gioco in locale funziona comunque.", hash_mismatch: "Il file non è arrivato integro. Riprova.",
  invalid_file: "Il Cloud non riconosce questo file.", game_id_mismatch: "Il file non corrisponde a questo gioco.", rate_limited: "Troppe richieste. Riprova tra poco.", too_many_uploads: "Ci sono troppi caricamenti in corso.",
  unauthenticated: "Accedi al tuo account per usare il Cloud.", file_not_found: "Il file non è più nel Cloud.", local_quota: "Spazio del browser esaurito su questo dispositivo. Libera spazio e riprova.", cancelled: "Operazione annullata.",
};
export const errMsg = (e) => ERR_TEXT[e && (e.error || e)] || (e && e.error ? "Errore: " + e.error : "Errore");

/** XMLHttpRequest PUT/POST of a binary body with byte-level upload progress (fetch has none): works on mobile browsers, never holds a second copy of the data */
function xhrSend(method, url, body, onProgress) {
  return new Promise((resolve) => {
    const x = new XMLHttpRequest(); x.open(method, url); x.withCredentials = true; x.timeout = 180000;
    if (body) x.setRequestHeader("content-type", "application/octet-stream");
    if (onProgress && x.upload) x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    x.onload = () => { let j = {}; try { j = JSON.parse(x.responseText); } catch { /* empty */ } const ok = x.status >= 200 && x.status < 300; resolve({ ok, status: x.status, error: ok ? "" : (j.error || "http_" + x.status), body: j }); };
    x.onerror = x.ontimeout = x.onabort = () => resolve({ ok: false, status: 0, error: "network", body: {} });
    x.send(body || null);
  });
}

export class CloudFiles {
  /** @param {{cloud: import("./cloud.js").Cloud, store: any, opt: Function}} d */
  constructor(d) {
    this.cloud = d.cloud; this.store = d.store; this.opt = d.opt || (() => "");
    this.games = new Map(); this.system = new Map(); this.heads = new Map(); this.usage = { usedBytes: 0, quotaBytes: 0 };
    this.conflicts = new Map(); this.busy = new Set(); this.listeners = new Set(); this.lastSync = 0;
  }
  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const f of this.listeners) { try { f(ev, this); } catch { /* a listener never breaks sync */ } } }
  get ready() { return this.cloud.state === "user"; }
  url(path) { return this.cloud.cfg.api + path; }

  // ---------------------------------------------------------------- identity of this device (not secret, only tells the user which device wrote a save)
  deviceId() {
    try { let v = localStorage.getItem("dslink.device"); if (!v) { v = "dev-" + hex(crypto.getRandomValues(new Uint8Array(10))); localStorage.setItem("dslink.device", v); } return v; }
    catch { return this._tmp || (this._tmp = "dev-" + hex(crypto.getRandomValues(new Uint8Array(10)))); }
  }
  deviceName() {
    const o = this.opt("devname", ""); if (o) return String(o).slice(0, 40);
    try { const v = localStorage.getItem("dslink.devicename"); if (v) return v.slice(0, 40); } catch { /* none */ }
    const ua = navigator.userAgent || "";
    return /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : "Browser";
  }
  setDeviceName(n) { try { localStorage.setItem("dslink.devicename", String(n).slice(0, 40)); } catch { /* none */ } }

  // ---------------------------------------------------------------- what the Cloud holds
  async refresh() {
    if (!this.ready) { this.games.clear(); this.system.clear(); this.heads.clear(); this.emit("refresh"); return { ok: false, error: "unauthenticated" }; }
    const [f, s, u] = await Promise.all([this.cloud.api("GET", "/api/files"), this.cloud.api("GET", "/api/saves"), this.cloud.api("GET", "/api/storage")]);
    if (!f.ok) return f;
    this.games = new Map(f.body.games.map((g) => [g.gameId, g])); this.system = new Map(f.body.system.map((g) => [g.name, g]));
    if (s.ok) this.heads = new Map(s.body.saves.map((x) => [x.gameId, x]));
    if (u.ok) this.usage = u.body; else this.usage = { usedBytes: f.body.usedBytes, quotaBytes: f.body.quotaBytes };
    this.emit("refresh"); return { ok: true };
  }
  inCloud(gameId) { return this.games.has(gameId); }

  // ---------------------------------------------------------------- upload
  /** Upload a buffer as a Cloud file (game or system). onProgress({loaded,total,pct,phase}). Resolves {ok} | {ok:false,error}. */
  async upload(kind, name, buf, { title = "", onProgress } = {}) {
    if (!this.ready) return { ok: false, error: "unauthenticated" };
    const total = buf.byteLength, report = (phase, loaded) => onProgress && onProgress({ phase, loaded, total, pct: total ? Math.min(100, Math.floor((loaded / total) * 100)) : 0 });
    report("hash", 0);
    const sha = await sha256Hex(buf);
    const body = { kind, name, size: total, sha256: sha, title };
    if (kind === "game") body.header = b64url(new Uint8Array(buf, 0, Math.min(512, total)));
    const init = await this.cloud.api("POST", "/api/files/uploads", body);
    if (!init.ok) return init;
    if (init.body.done) { report("done", total); await this.refresh(); return { ok: true, deduplicated: true }; }
    const { uploadId, chunkSize, partsTotal } = init.body; let sent = 0;
    for (let n = 1; n <= partsTotal; n++) {
      const start = (n - 1) * chunkSize, end = Math.min(total, n * chunkSize), part = new Uint8Array(buf, start, end - start);   // a view: no second copy of the file in memory
      let r;
      for (let a = 1; a <= CHUNK_RETRY; a++) {
        r = await xhrSend("PUT", this.url(`/api/files/uploads/${uploadId}/parts/${n}`), part, (l) => report("upload", sent + l));
        if (r.ok || (r.status >= 400 && r.status < 500)) break;                                // network / 5xx: retry this part only
        await sleep(400 * a);
      }
      if (!r.ok) { await this.cloud.api("DELETE", `/api/files/uploads/${uploadId}`).catch(() => {}); return r; }
      sent = end; report("upload", sent);
    }
    report("verify", total);
    const done = await xhrSend("POST", this.url(`/api/files/uploads/${uploadId}/complete`), null);
    if (!done.ok) { if (done.error !== "network") await this.cloud.api("DELETE", `/api/files/uploads/${uploadId}`).catch(() => {}); return done; }
    report("done", total); await this.refresh(); return { ok: true };
  }

  // ---------------------------------------------------------------- download (the file becomes LOCAL before anything uses it)
  /** Download a Cloud file into memory, resuming from the received offset when the connection drops, verify its SHA-256. Resolves {ok, buf} | {ok:false,error}. */
  async download(kind, name, { onProgress } = {}) {
    if (!this.ready) return { ok: false, error: "unauthenticated" };
    const meta = (kind === "game" ? this.games : this.system).get(name);
    if (!meta) { await this.refresh(); if (!(kind === "game" ? this.games : this.system).get(name)) return { ok: false, error: "file_not_found" }; }
    const m = (kind === "game" ? this.games : this.system).get(name), total = m.size, out = new Uint8Array(total); let got = 0;      // one buffer, filled in place
    const report = (phase) => onProgress && onProgress({ phase, loaded: got, total, pct: Math.floor((got / total) * 100) });
    report("download");
    for (let attempt = 1; got < total && attempt <= 4; attempt++) {
      try {
        const res = await fetch(this.url(`/api/files/${kind}/${name}`), { credentials: "include", headers: got ? { range: `bytes=${got}-` } : undefined });
        if (!res.ok && res.status !== 206) { if (res.status >= 400 && res.status < 500) { let j = {}; try { j = await res.json(); } catch { /* empty */ } return { ok: false, error: j.error || "http_" + res.status }; } throw new Error("http"); }
        if (res.status === 200 && got) got = 0;                                                  // the server ignored the range: start over
        const rd = res.body.getReader();
        for (;;) { const { value, done } = await rd.read(); if (done) break; if (got + value.length > total) return { ok: false, error: "size_mismatch" }; out.set(value, got); got += value.length; report("download"); }
      } catch { await sleep(300 * attempt); }                                                    // dropped: retry from `got`
    }
    if (got < total) return { ok: false, error: "network" };                                     // nothing was written anywhere: the partial buffer is simply dropped
    report("verify");
    if ((await sha256Hex(out.buffer)) !== m.sha256) return { ok: false, error: "hash_mismatch" };
    report("done"); return { ok: true, buf: out.buffer };
  }

  async removeGame(gameId) { const r = await this.cloud.api("DELETE", `/api/files/game/${gameId}`); if (r.ok) await this.refresh(); return r; }
  async removeSystem(name) { const r = await this.cloud.api("DELETE", `/api/files/system/${name}`); if (r.ok) await this.refresh(); return r; }
  async deleteSaves(gameId) { const r = await this.cloud.api("DELETE", `/api/saves/${gameId}`); if (r.ok) await this.refresh(); return r; }

  /** BIOS / firmware: fetch the ones this device lacks (the user's own files, from the user's own Cloud). Returns the names stored. */
  async pullSystem(defs) {
    if (!this.ready) return [];
    const got = [];
    for (const s of defs) {
      if (!this.system.has(s.file)) continue;
      const have = await this.store.get("system/" + s.file); if (have && s.sizes.includes(have.byteLength)) continue;          // a local file always wins
      const d = await this.download("system", s.file); if (!d.ok) continue;
      if (!s.sizes.includes(d.buf.byteLength)) continue;
      try { await this.store.put("system/" + s.file, d.buf); got.push(s.file); } catch { /* local storage full: nothing lost, the Cloud still has it */ }
    }
    return got;
  }

  // ---------------------------------------------------------------- saves
  async _state(id) { try { const b = await this.store.get(`library/${id}/sync.json`); return b ? JSON.parse(new TextDecoder().decode(b)) : null; } catch { return null; } }
  async _setState(id, rev, sha) { await this.store.put(`library/${id}/sync.json`, new TextEncoder().encode(JSON.stringify({ rev, sha })).buffer); }
  async localSaveTime(id) { try { const b = await this.store.get(`library/${id}/save.meta.json`); return b ? JSON.parse(new TextDecoder().decode(b)).t || 0 : 0; } catch { return 0; } }
  async markLocalSave(id, t = Date.now()) { try { await this.store.put(`library/${id}/save.meta.json`, new TextEncoder().encode(JSON.stringify({ t })).buffer); } catch { /* informational only */ } }

  /** Compare the local save with the Cloud head and do the safe thing. Never overwrites a different save silently.
   *  Resolves {action: none|in-sync|pushed|pulled|conflict|offline|error|skip, ...} */
  async syncSave(localId, gameId) {
    if (!this.ready) return { action: "skip" };
    const key = localId; if (this.busy.has(key)) return { action: "busy" }; this.busy.add(key);
    try {
      const r = await this.cloud.api("GET", `/api/saves/${gameId}`);
      if (!r.ok) return { action: r.error === "network" ? "offline" : "error", error: r.error };
      const head = r.body.head, local = await this.store.get(`library/${localId}/save`), st = await this._state(localId);
      if (!head) {
        if (!local) return { action: "none" };
        return await this._push(localId, gameId, local, 0, false);
      }
      if (!local) return await this._pull(localId, gameId, head, false);
      const lsha = await sha256Hex(local);
      if (lsha === head.sha256) { await this._setState(localId, head.revision, lsha); this.conflicts.delete(localId); return { action: "in-sync", revision: head.revision }; }
      const localChanged = !st || st.sha !== lsha, cloudChanged = !st || st.rev !== head.revision;
      if (localChanged && cloudChanged) return await this._conflict(localId, gameId, head, local);
      if (cloudChanged) return await this._pull(localId, gameId, head, true);
      return await this._push(localId, gameId, local, head.revision, false);
    } finally { this.busy.delete(key); }
  }
  async _conflict(localId, gameId, head, local) {
    const c = { localId, gameId, head, local: { size: local.byteLength, deviceName: this.deviceName(), time: await this.localSaveTime(localId) } };
    this.conflicts.set(localId, c); this.emit("conflict"); return { action: "conflict", conflict: c };
  }
  async _push(localId, gameId, data, base, force) {
    const sha = await sha256Hex(data);
    const q = `base=${base}&sha=${sha}&device=${encodeURIComponent(this.deviceId())}&name=${encodeURIComponent(this.deviceName())}${force ? "&force=1" : ""}`;
    const r = await xhrSend("PUT", this.url(`/api/saves/${gameId}?${q}`), new Uint8Array(data));
    if (r.status === 409) { const local = await this.store.get(`library/${localId}/save`); return await this._conflict(localId, gameId, r.body.head, local || data); }
    if (!r.ok) return { action: r.error === "network" ? "offline" : "error", error: r.error };
    const rev = r.body.revision; await this._setState(localId, rev, sha); this.conflicts.delete(localId);
    if (r.body.head) this.heads.set(gameId, r.body.head);
    this.lastSync = Date.now(); this.emit("sync"); return { action: r.body.unchanged ? "in-sync" : "pushed", revision: rev };
  }
  async _pull(localId, gameId, head, hadLocal, rev) {
    const res = await fetch(this.url(`/api/saves/${gameId}/data${rev ? "?rev=" + rev : ""}`), { credentials: "include" }).catch(() => null);
    if (!res || !res.ok) return { action: res ? "error" : "offline", error: res ? "http_" + res.status : "network" };
    const buf = await res.arrayBuffer();
    if ((await sha256Hex(buf)) !== head.sha256) return { action: "error", error: "hash_mismatch" };
    if (hadLocal) { const old = await this.store.get(`library/${localId}/save`); if (old) await this.store.put(`library/${localId}/save.bak`, old); }     // the replaced local save is kept
    await this.store.put(`library/${localId}/save`, buf); await this.markLocalSave(localId, head.updatedAt); await this._setState(localId, head.revision, head.sha256);
    this.conflicts.delete(localId); this.heads.set(gameId, head); this.lastSync = Date.now(); this.emit("sync");
    return { action: "pulled", revision: head.revision };
  }
  /** the user chose: "local" = USA QUESTO (this device's save becomes the newest revision, the other stays in the history), "cloud" = USA L'ALTRO (the Cloud save replaces the local one, which is kept as save.bak) */
  async resolve(localId, gameId, choice) {
    const c = this.conflicts.get(localId); const head = c ? c.head : (await this.cloud.api("GET", `/api/saves/${gameId}`)).body.head;
    if (!head) return { action: "none" };
    if (choice === "local") { const local = await this.store.get(`library/${localId}/save`); return await this._push(localId, gameId, local, head.revision, true); }
    return await this._pull(localId, gameId, head, true);
  }
  async history(gameId) { const r = await this.cloud.api("GET", `/api/saves/${gameId}`); return r.ok ? r.body.history : []; }
  /** restore an older revision: the Cloud makes it the newest one and this device takes it (the previous local save is kept as save.bak) */
  async restore(localId, gameId, revision) {
    const r = await this.cloud.api("POST", `/api/saves/${gameId}/restore`, { revision, device: this.deviceId(), name: this.deviceName() });
    if (!r.ok) return { action: "error", error: r.error };
    return await this._pull(localId, gameId, r.body.head, true);
  }
  /** all local games that are part of the account's Cloud (ROM in the Cloud, or a save already synced): used at start, on login, when the network comes back and manually */
  async syncAll(localGames, gameIdOf) {
    if (!this.ready) return [];
    await this.refresh(); const out = [];
    for (const g of localGames) {
      const gid = gameIdOf(g); if (!gid) continue;
      if (!this.inCloud(gid) && !this.heads.has(gid)) continue;
      out.push({ id: g.id, gameId: gid, ...(await this.syncSave(g.id, gid)) });
    }
    return out;
  }
}
