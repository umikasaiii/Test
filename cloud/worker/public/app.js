// DSLink PWA: account, friends + presence, private game library, invites, game screen.
// Rules: user-controlled text is only ever inserted with textContent (never innerHTML); no ROM/BIOS bytes are ever kept by the page
// beyond the upload stream; nothing private is stored in the service worker cache.
import { startGame } from "./game.js";

const $app = document.getElementById("app");
const $toast = document.getElementById("toast");
const state = { me: null, friends: [], requests: { incoming: [], outgoing: [] }, games: [], invites: [], ws: null, status: "OFFLINE", system: [], modal: null };
const AV = ["#e5484d", "#f76b15", "#f5a524", "#3ecf8e", "#12a594", "#0091ff", "#3e63dd", "#8e4ec6", "#d6409f", "#6e6e80", "#00a2c7", "#ab4aba"];

const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === "class") e.className = v; else if (k.startsWith("on")) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};
const toast = (msg) => { $toast.textContent = msg; $toast.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => ($toast.hidden = true), 3500); };
const ERR = { username_taken: "Nome utente già in uso", invalid_credentials: "Credenziali non valide", too_many_attempts: "Troppi tentativi, riprova più tardi", user_not_found: "Utente non trovato", already_friends: "Siete già amici",
  request_already_pending: "Richiesta già inviata", friend_offline: "Il tuo amico è offline", friend_busy: "Il tuo amico sta già giocando", unsupported_file: "File non riconosciuto (servono .nds, .chd o .cue+.bin)", invalid_nds: "Il file non è una ROM Nintendo DS valida",
  invalid_combination: "Seleziona un solo gioco: un .nds, un .chd oppure un .cue con i suoi .bin", cue_bin_mismatch: "Il .cue non corrisponde ai file .bin scelti", invite_expired: "Invito scaduto", already_in_game: "Sei già in una partita", needs_direct_upload: "File troppo grande per questo ambiente" };
const errText = (j) => ERR[j?.error] || j?.message || j?.error || "Errore";

async function api(method, path, body, raw) {
  const opt = { method, headers: {}, credentials: "same-origin" };
  if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers["content-type"] = "application/json"; }
  if (raw) { opt.body = raw; }
  const r = await fetch(path, opt);
  let j = null; try { j = await r.json(); } catch { /* empty */ }
  if (!r.ok) { const e = new Error(errText(j)); e.status = r.status; e.body = j; throw e; }
  return j;
}

// ------------------------------------------------------------------ passkeys (manual base64url <-> ArrayBuffer, works on every WebAuthn browser)
const b64u = { dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) => c.charCodeAt(0)).buffer,
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") };
const credToJSON = (c) => {
  const r = c.response, out = { id: c.id, rawId: b64u.enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(), authenticatorAttachment: c.authenticatorAttachment || undefined };
  if (r.attestationObject) out.response = { clientDataJSON: b64u.enc(r.clientDataJSON), attestationObject: b64u.enc(r.attestationObject), transports: r.getTransports ? r.getTransports() : [] };
  else out.response = { clientDataJSON: b64u.enc(r.clientDataJSON), authenticatorData: b64u.enc(r.authenticatorData), signature: b64u.enc(r.signature), userHandle: r.userHandle ? b64u.enc(r.userHandle) : undefined };
  return out;
};
async function passkeyRegister(username, displayName) {
  const { cid, options } = await api("POST", "/api/auth/passkey/register/options", { username, displayName });
  const pk = { ...options, challenge: b64u.dec(options.challenge), user: { ...options.user, id: b64u.dec(options.user.id) }, excludeCredentials: (options.excludeCredentials || []).map((c) => ({ ...c, id: b64u.dec(c.id) })) };
  const cred = await navigator.credentials.create({ publicKey: pk });
  return api("POST", "/api/auth/passkey/register/verify", { cid, response: credToJSON(cred) });
}
async function passkeyLogin() {
  const { cid, options } = await api("POST", "/api/auth/passkey/login/options", {});
  const pk = { ...options, challenge: b64u.dec(options.challenge), allowCredentials: (options.allowCredentials || []).map((c) => ({ ...c, id: b64u.dec(c.id) })) };
  const cred = await navigator.credentials.get({ publicKey: pk });
  return api("POST", "/api/auth/passkey/login/verify", { cid, response: credToJSON(cred) });
}

// ------------------------------------------------------------------ presence socket: ONLINE while open; ping every 20 s; reconnect with backoff
let presenceTimer = null, backoff = 1000;
function connectPresence() {
  if (state.ws || !state.me) return;
  const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/ws`);
  state.ws = ws;
  ws.onopen = () => { backoff = 1000; clearInterval(presenceTimer); presenceTimer = setInterval(() => ws.readyState === 1 && ws.send('{"t":"ping"}'), 20000); loadAll(); };
  ws.onmessage = (m) => onEvent(JSON.parse(m.data));
  ws.onclose = () => { state.ws = null; clearInterval(presenceTimer); if (state.me) setTimeout(connectPresence, backoff = Math.min(backoff * 2, 15000)); };
}
function onEvent(e) {
  if (e.t === "presence") { const f = state.friends.find((x) => x.userId === e.userId); if (f) { f.status = e.status; render(); } else loadFriends(); }
  else if (e.t === "self_presence") { state.status = e.status; }
  else if (e.t === "friend_request") { loadFriends(); toast(`${e.user.displayName} vuole essere tuo amico`); }
  else if (e.t === "friend_update") { loadFriends(); }
  else if (e.t === "invite") { state.invites = [...state.invites.filter((i) => i.id !== e.id), { id: e.id, from: e.from, game: e.game, expiresAt: e.expiresAt }]; render(); }
  else if (e.t === "invite_update") {
    state.invites = state.invites.filter((i) => i.id !== e.id);
    if (e.status === "accepted" && e.sessionId) enterSession(e.sessionId);
    else if (e.status === "refused") toast(`${e.by.displayName} ha rifiutato l'invito`);
    render();
  }
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && state.me) { if (!state.ws) connectPresence(); loadAll(); } });

// ------------------------------------------------------------------ data
const loadFriends = async () => { try { const [f, r] = await Promise.all([api("GET", "/api/friends"), api("GET", "/api/friends/requests")]); state.friends = f.friends; state.requests = r; render(); } catch { /* offline */ } };
const loadGames = async () => { try { state.games = (await api("GET", "/api/library")).games; render(); } catch { /* offline */ } };
const loadInvites = async () => { try { state.invites = (await api("GET", "/api/invites")).incoming.map((i) => ({ id: i.id, from: i.other, game: i.game, expiresAt: i.expiresAt })); render(); } catch { /* offline */ } };
const loadSystem = async () => { try { state.system = (await api("GET", "/api/library/system")).files; } catch { /* offline */ } };
const loadAll = () => Promise.all([loadFriends(), loadGames(), loadInvites(), loadSystem()]);

// ------------------------------------------------------------------ views
const avatar = (u) => h("div", { class: "avatar", style: `background:${AV[Number(String(u.avatar).slice(1)) % AV.length] || AV[0]}` }, (u.displayName || "?").slice(0, 1).toUpperCase());
const STATUS = { ONLINE: "Online", IN_GAME: "In gioco", OFFLINE: "Offline" };
const PLAT = { nds: "Nintendo DS", ps1: "PlayStation" };

function viewAuth() {
  let mode = "login", usePassword = false;
  const box = h("div");
  const draw = () => {
    box.replaceChildren();
    const msg = h("div", { class: "err", role: "alert" });
    const user = h("input", { type: "text", placeholder: "Nome utente", autocomplete: "username webauthn", autocapitalize: "none", id: "username" });
    const disp = h("input", { type: "text", placeholder: "Nome visualizzato (facoltativo)", maxlength: 32, id: "displayName" });
    const pass = h("input", { type: "password", placeholder: "Password (almeno 10 caratteri)", autocomplete: mode === "login" ? "current-password" : "new-password", id: "password" });
    const go = async (fn) => { msg.textContent = ""; try { await fn(); await boot(); } catch (e) { msg.textContent = e.name === "NotAllowedError" ? "Operazione annullata" : e.message; } };
    box.append(h("div", {},
      h("div", { class: "tabs" }, h("button", { class: mode === "login" ? "on" : "", id: "tabLogin", onclick: () => { mode = "login"; draw(); } }, "Accedi"), h("button", { class: mode === "register" ? "on" : "", id: "tabRegister", onclick: () => { mode = "register"; draw(); } }, "Crea account")),
      mode === "register" ? [user, disp] : (usePassword ? user : null),
      usePassword ? pass : null,
      msg,
      !usePassword ? h("button", { class: "primary", id: "btnPasskey", style: "width:100%", onclick: () => go(async () => { if (mode === "register") await passkeyRegister(user.value.trim().toLowerCase(), disp.value.trim() || undefined); else await passkeyLogin(); }) }, mode === "register" ? "Crea account con passkey" : "Accedi con passkey") : null,
      usePassword ? h("button", { class: "primary", id: "btnPassword", style: "width:100%", onclick: () => go(async () => { const u = user.value.trim().toLowerCase(); if (mode === "register") await api("POST", "/api/auth/register", { username: u, displayName: disp.value.trim() || undefined, password: pass.value }); else await api("POST", "/api/auth/login", { username: u, password: pass.value }); }) }, mode === "register" ? "Crea account" : "Accedi") : null,
      h("p", { class: "hint" }, h("a", { href: "#", id: "togglePw", onclick: (ev) => { ev.preventDefault(); usePassword = !usePassword; draw(); } }, usePassword ? "Usa una passkey (consigliato)" : "Preferisco usare una password"))));
  };
  draw();
  return h("div", {}, h("h1", {}, "DSLink"), h("p", { class: "sub" }, "Gioca con i tuoi amici ai tuoi giochi, dal browser."), box);
}

function viewHome() {
  const m = state.me;
  const reqs = state.requests.incoming;
  const friendInput = h("input", { type: "text", placeholder: "Nome utente dell'amico", id: "friendName", autocapitalize: "none" });
  return h("div", {},
    h("div", { class: "row sp" }, h("div", { class: "row" }, avatar(m), h("div", {}, h("div", { class: "name", id: "meName" }, m.displayName), h("div", { class: "sub" }, "@" + m.username))), h("button", { class: "small", id: "btnSettings", onclick: () => { state.modal = "settings"; render(); } }, "Impostazioni")),

    h("h2", {}, "AMICI", reqs.length ? h("span", { class: "badge" }, reqs.length) : null),
    reqs.map((r) => h("div", { class: "card row", "data-req": r.id }, avatar(r.user), h("div", { class: "grow" }, h("div", { class: "name" }, r.user.displayName), h("div", { class: "sub" }, "vuole essere tuo amico")),
      h("button", { class: "small ok", onclick: () => friendAct(`/api/friends/requests/${r.id}/accept`) }, "Accetta"), h("button", { class: "small", onclick: () => friendAct(`/api/friends/requests/${r.id}/refuse`) }, "Rifiuta"))),
    state.friends.length ? state.friends.map((f) => h("div", { class: "card row", "data-friend": f.userId }, avatar(f), h("div", { class: "grow" }, h("div", { class: "name" }, f.displayName), h("div", { class: "sub" }, h("span", { class: "dot " + f.status }), STATUS[f.status])),
      h("button", { class: "small primary", disabled: f.status !== "ONLINE", onclick: () => { state.modal = { invite: f }; render(); } }, "INVITA"), h("button", { class: "small", title: "Rimuovi", onclick: async () => { if (confirm(`Rimuovere ${f.displayName} dagli amici?`)) friendAct(`/api/friends/${f.userId}`, "DELETE"); } }, "✕"))) : h("p", { class: "hint" }, "Non hai ancora amici. Aggiungine uno con il suo nome utente."),
    h("div", { class: "row" }, h("div", { class: "grow" }, friendInput), h("button", { id: "btnAddFriend", onclick: async () => { try { await api("POST", "/api/friends/requests", { username: friendInput.value.trim().toLowerCase() }); friendInput.value = ""; toast("Richiesta inviata"); loadFriends(); } catch (e) { toast(e.message); } } }, "Aggiungi")),

    h("h2", {}, "I TUOI GIOCHI"),
    state.games.length ? state.games.map((g) => h("div", { class: "card", "data-game": g.id }, h("div", { class: "row sp" }, h("div", { class: "grow" }, h("div", { class: "name" }, g.title), h("div", { class: "sub" }, PLAT[g.platform] + (g.hasSave ? " · salvataggio" : ""))),
      h("button", { class: "small", title: "Elimina dalla libreria", onclick: async () => { if (confirm(`Eliminare "${g.title}" dalla tua libreria?`)) { await api("DELETE", `/api/library/games/${g.id}`); loadGames(); } } }, "🗑")),
      h("div", { class: "row" }, h("button", { class: "primary grow", onclick: () => play(g) }, "GIOCA"), h("button", { class: "grow", onclick: () => { state.modal = { pickFriend: g }; render(); } }, "INVITA")))) : h("p", { class: "hint" }, "La tua libreria è vuota. Aggiungi un gioco dal tuo dispositivo: resta privato, solo tuo."),
    h("button", { class: "primary", id: "btnAddGame", style: "width:100%;margin-top:8px", onclick: addGame }, "+ AGGIUNGI GIOCO"),
    h("p", { class: "hint" }, "DSLink non fornisce né scarica giochi o BIOS: i file restano nel tuo spazio privato."));
}

async function friendAct(path, method = "POST") { try { await api(method, path); await loadFriends(); } catch (e) { toast(e.message); } }

function modal() {
  const mo = state.modal, inv = state.invites[0];
  if (inv) { // incoming invite always on top
    return h("div", { class: "modal", id: "inviteModal" }, h("div", { class: "box" }, h("h1", {}, "Invito a giocare"), h("p", { id: "inviteText" }, `${inv.from.displayName} ti invita a giocare a ${inv.game.title}`),
      h("div", { class: "row" }, h("button", { class: "ok", id: "btnAccept", onclick: () => answer(inv, true) }, "ACCETTA"), h("button", { id: "btnRefuse", onclick: () => answer(inv, false) }, "RIFIUTA"))));
  }
  if (!mo) return null;
  if (mo.invite) return pickGame(mo.invite);
  if (mo.pickFriend) return pickFriend(mo.pickFriend);
  if (mo === "settings") return settings();
  return null;
}
async function answer(inv, accept) {
  state.invites = state.invites.filter((i) => i.id !== inv.id); render();
  try { const r = await api("POST", `/api/invites/${inv.id}/respond`, { accept }); if (accept) enterSession(r.sessionId); } catch (e) { toast(e.message); }
}
const closeModal = () => { state.modal = null; render(); };
function pickGame(friend) {
  return h("div", { class: "modal" }, h("div", { class: "box" }, h("h1", {}, `Invita ${friend.displayName}`), state.games.length ? state.games.map((g) => h("button", { class: "card", style: "width:100%;text-align:left", onclick: () => sendInvite(friend, g) }, g.title, h("div", { class: "sub" }, PLAT[g.platform]))) : h("p", { class: "hint" }, "Aggiungi prima un gioco alla tua libreria."), h("div", { class: "row" }, h("button", { onclick: closeModal }, "Annulla"))));
}
function pickFriend(game) {
  const online = state.friends.filter((f) => f.status === "ONLINE");
  return h("div", { class: "modal" }, h("div", { class: "box" }, h("h1", {}, `Invita a ${game.title}`), online.length ? online.map((f) => h("button", { class: "card row", style: "width:100%;text-align:left", onclick: () => sendInvite(f, game) }, avatar(f), f.displayName)) : h("p", { class: "hint" }, "Nessun amico online al momento."), h("div", { class: "row" }, h("button", { onclick: closeModal }, "Annulla"))));
}
async function sendInvite(friend, game) { state.modal = null; try { await api("POST", "/api/invites", { friendId: friend.userId, gameId: game.id }); toast(`Invito inviato a ${friend.displayName}`); } catch (e) { toast(e.message); } render(); }

function settings() {
  const row = (platform, name, label) => {
    const have = state.system.find((s) => s.platform === platform && s.name === name);
    const inp = h("input", { type: "file", hidden: true, onchange: async () => { const f = inp.files[0]; if (!f) return; try { await api("PUT", `/api/library/system/${platform}/${name}`, undefined, f); await loadSystem(); toast(`${label} caricato`); } catch (e) { toast(e.message); } render(); } });
    return h("div", { class: "row sp", style: "margin:8px 0" }, h("div", { class: "grow" }, h("div", { class: "name" }, label), h("div", { class: "sub" }, have ? "caricato (privato)" : "non caricato")), inp,
      h("button", { class: "small", onclick: () => inp.click() }, have ? "Sostituisci" : "Carica"), have ? h("button", { class: "small", onclick: async () => { await api("DELETE", `/api/library/system/${platform}/${name}`); await loadSystem(); render(); } }, "Elimina") : null);
  };
  return h("div", { class: "modal" }, h("div", { class: "box", style: "max-height:90vh;overflow:auto" }, h("h1", {}, "Impostazioni"),
    h("h2", {}, "Il tuo profilo"), h("div", { class: "row" }, h("div", { class: "grow" }, h("input", { type: "text", id: "newName", value: state.me.displayName, maxlength: 32 })), h("button", { class: "small", onclick: async () => { const v = document.getElementById("newName").value.trim(); if (v) { const r = await api("PATCH", "/api/me", { displayName: v }); state.me = r.user; render(); } } }, "Salva")),
    h("h2", {}, "BIOS / firmware Nintendo DS (tuoi, privati)"), row("nds", "bios7.bin", "bios7.bin"), row("nds", "bios9.bin", "bios9.bin"), row("nds", "firmware.bin", "firmware.bin"),
    h("p", { class: "hint" }, "Servono per far partire la console senza cartuccia (Download Play). Non vengono mai condivisi con altri giocatori."),
    h("h2", {}, "Account"),
    h("button", { class: "danger", style: "width:100%;margin:6px 0", id: "btnDeleteAll", onclick: async () => { if (!confirm("Eliminare TUTTI i giochi della libreria?")) return; for (const g of state.games) await api("DELETE", `/api/library/games/${g.id}`); await loadGames(); toast("Libreria eliminata"); } }, "Elimina tutta la libreria"),
    h("button", { style: "width:100%;margin:6px 0", onclick: async () => { await api("POST", "/api/auth/logout"); await boot(); } }, "Esci"),
    h("button", { class: "danger", style: "width:100%;margin:6px 0", id: "btnDeleteAccount", onclick: async () => { const u = prompt(`Per eliminare account e tutti i dati scrivi il tuo nome utente (${state.me.username}):`); if (u === state.me.username) { await api("DELETE", "/api/account", { confirm: u }); toast("Account eliminato"); await boot(); } } }, "Elimina account e dati"),
    h("div", { class: "row" }, h("button", { onclick: closeModal }, "Chiudi"))));
}

// ------------------------------------------------------------------ add game: header sniffed in the browser (platform hint), verified again by the server, bytes go straight to private storage
function addGame() {
  const inp = h("input", { type: "file", multiple: true, accept: ".nds,.chd,.cue,.bin", hidden: true, id: "gameFile" });
  inp.addEventListener("change", async () => { const files = [...inp.files]; if (files.length) await uploadGame(files); });
  document.body.append(inp); inp.click(); setTimeout(() => inp.remove(), 60000);
}
const toB64 = (buf) => { let s = ""; const b = new Uint8Array(buf); for (const x of b) s += String.fromCharCode(x); return btoa(s); };
function putWithProgress(url, file, headers, onp) {
  return new Promise((res, rej) => { const x = new XMLHttpRequest(); x.open("PUT", url); for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v); x.upload.onprogress = (e) => e.lengthComputable && onp(e.loaded / e.total); x.onload = () => (x.status < 300 ? res() : rej(new Error("Caricamento non riuscito (" + x.status + ")"))); x.onerror = () => rej(new Error("Rete non disponibile")); x.send(file); });
}
async function uploadGame(files) {
  const bar = h("i"); const prog = h("div", { class: "modal", id: "uploading" }, h("div", { class: "box" }, h("h1", {}, "Aggiunta del gioco…"), h("div", { class: "progress" }, bar), h("p", { class: "hint", id: "uploadMsg" }, "Verifica del file")));
  document.body.append(prog);
  try {
    const meta = await Promise.all(files.map(async (f) => ({ name: f.name, size: f.size, header: toB64(await f.slice(0, 1024).arrayBuffer()) })));
    const c = await api("POST", "/api/library/games", { files: meta });
    let done = 0; const total = files.reduce((s, f) => s + f.size, 0);
    for (const u of c.uploads) {
      const f = files.find((x) => x.name === u.name);
      const base = done;
      await putWithProgress(u.url, f, u.mode === "proxy" ? { } : { }, (p) => { bar.style.width = ((base + p * f.size) / total * 100) + "%"; });
      done += f.size;
    }
    document.getElementById("uploadMsg").textContent = "Controllo finale…";
    const r = await api("POST", `/api/library/games/${c.gameId}/complete`);
    toast(`${r.title} aggiunto alla libreria`);
  } catch (e) { toast(e.message); }
  prog.remove(); await loadGames();
}

// ------------------------------------------------------------------ sessions
async function play(game) { try { const r = await api("POST", "/api/sessions", { gameId: game.id }); enterSession(r.sessionId); } catch (e) { toast(e.message); } }
let inSession = false;
async function enterSession(id) {
  if (inSession) return; inSession = true;
  const wait = h("div", { class: "modal", id: "starting" }, h("div", { class: "box" }, h("h1", {}, "Avvio della partita…"), h("p", { class: "hint", id: "startMsg" }, "Sto preparando la console")));
  document.body.append(wait);
  try {
    let info;
    for (let i = 0; i < 90; i++) { info = (await api("GET", `/api/sessions/${id}`)).session; if (info.status === "running" || info.status === "ended") break; await new Promise((r) => setTimeout(r, 1000)); }
    wait.remove();
    if (info.status !== "running") { toast("Impossibile avviare la partita"); inSession = false; return; }
    startGame({ sessionId: id, info, api, onExit: async () => { inSession = false; try { await api("POST", `/api/sessions/${id}/end`); } catch { /* ended */ } render(); } });
  } catch (e) { wait.remove(); toast(e.message); inSession = false; }
}

// ------------------------------------------------------------------ shell
function render() {
  if (inSession) return;
  $app.replaceChildren(state.me ? viewHome() : viewAuth());
  document.querySelectorAll(".modal:not(#uploading):not(#starting)").forEach((m) => m.remove());
  const m = state.me ? modal() : null; if (m) document.body.append(m);
}
async function boot() {
  try { state.me = (await api("GET", "/api/me")).user; } catch { state.me = null; }
  if (state.ws) { state.ws.close(); state.ws = null; }
  state.friends = []; state.games = []; state.invites = []; state.modal = null;
  render();
  if (state.me) { connectPresence(); loadAll(); }
}
window.__dslink = { state, api };   // test hook
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
boot();
