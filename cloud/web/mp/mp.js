// DSLink multiplayer UX (LAN/local, no cloud). The UI renders ONE document, /api/mp/state, from this device's gateway; it never decides session logic itself.
import { mountControls } from "/controls/controls.js";

const $ = (id) => document.getElementById(id);
// GUEST WEB PAGE (/guest/): a browser on another device (the iPhone's Safari or Home-Screen web app) that plays through the HOST's gateway. It owns no console:
// the host streams it video/audio and takes its buttons/touch. Its session lives in the host's gateway under /g/<id>/ (the id is this browser's own random handle).
const GUEST = location.pathname.startsWith("/guest");
const SID = (() => {
  const mk = () => { const a = new Uint8Array(16); (self.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : a.forEach((_, i) => { a[i] = Math.floor(Math.random() * 256); }); return [...a].map((b) => b.toString(16).padStart(2, "0")).join(""); };
  try { let v = localStorage.getItem("dslink.guest.sid"); if (!/^[0-9a-f]{32}$/.test(v || "")) { v = mk(); localStorage.setItem("dslink.guest.sid", v); } return v; } catch { return mk(); }
})();
if (GUEST) document.body.classList.add("guest");
const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const api = async (method, path, body) => {
  const init = { method };
  if (body instanceof FormData) init.body = body; else if (body) { init.headers = { "content-type": "application/json" }; init.body = JSON.stringify(body); }
  const r = await fetch(GUEST && path.startsWith("/api/mp/") ? "/g/" + SID + path : path, init); let j = {}; try { j = await r.json(); } catch { /* empty */ }
  return { ok: r.ok, status: r.status, j };
};
const DEV = new URLSearchParams(location.search).has("dev") || (() => { try { return localStorage.getItem("dslink.dev") === "1"; } catch { return false; } })();
if (DEV) document.body.classList.add("dev");

let st = { state: "IDLE" }, view = GUEST ? "join" : "home", games = [], selected = null, stream = null, lastDump = "", streamTries = 0, lastStreamAt = 0, pendingLeave = null;
const RECENT_KEY = "dslink.mp.recent";
const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; } };
const remember = (g) => { try { const r = [{ id: g.id, title: g.title, ts: Date.now() }, ...recent().filter((x) => x.id !== g.id)].slice(0, 4); localStorage.setItem(RECENT_KEY, JSON.stringify(r)); } catch { /* ignore */ } };

// ---------------------------------------------------------------- screens + history
const screens = () => [...document.querySelectorAll(".screen")];
function show(name) { screens().forEach((s) => s.classList.toggle("on", s.dataset.screen === name)); document.body.dataset.screen = name; }
function go(next, push = true) { view = next; if (push) history.pushState({ view: next }, ""); render(); }
history.replaceState({ view: "home" }, "");
window.addEventListener("popstate", (e) => {
  const busy = BUSY.includes(st.state);
  if (busy) { history.pushState({ view }, ""); askLeave(); return; }       // Back inside a session never loses it silently
  view = (e.state && e.state.view) || "home"; if (!["home", "create", "join"].includes(view)) view = "home"; render();
});
// Back from the Android app (and any host that wants it): true = the page handled it. Does not depend on history entries (browsers skip entries made without a user gesture).
window.dslinkBack = () => { if (BUSY.includes(st.state)) { askLeave(); return true; } if (view !== "home") { view = "home"; render(); return true; } return false; };
document.querySelectorAll("[data-back]").forEach((b) => { b.onclick = () => history.back(); });

function askLeave() {
  const host = st.role === "host";
  $("confirmTitle").textContent = host ? "Annullare la partita?" : "Uscire dalla partita?";
  $("confirmYes").textContent = host ? "SÌ, ANNULLA" : "SÌ, ESCI";
  $("confirm").hidden = false;
}
$("confirmNo").onclick = () => { $("confirm").hidden = true; };
$("confirmYes").onclick = async () => { $("confirm").hidden = true; await leaveSession(); };
async function leaveSession() { stopStream(); await api("POST", "/api/mp/cancel"); await api("POST", "/api/mp/reset"); view = "home"; await poll(); }

// ---------------------------------------------------------------- polling
async function poll() {
  const r = await api("GET", "/api/mp/state" + (DEV ? "?dev=1" : "")).catch(() => null);
  if (!r || !r.ok) return;
  const dump = JSON.stringify(r.j);
  if (dump === lastDump) return;
  lastDump = dump; st = r.j; render();
}
setInterval(poll, 600);
document.addEventListener("visibilitychange", () => { if (!document.hidden) { lastDump = ""; poll(); } });
window.addEventListener("online", poll);

// ---------------------------------------------------------------- rendering
const STEP_LIST = ["Preparazione partita…", "Connessione al secondo giocatore…", "Avvio Nintendo DS…", "Ricerca partita…", "Download Play…", "Avvio partita…"];
const BUSY = ["WAITING_FOR_PEER", "JOINING", "CONNECTED", "NETWORK_CHECK", "READY", "STARTING", "DOWNLOAD_PLAY", "IN_GAME", "RECONNECTING", "CREATING_ROOM"];
let guard = false;
function render() {
  const s = st.state;
  if (BUSY.includes(s) && !guard) { history.pushState({ guard: true }, ""); guard = true; }   // Back inside a session must stay in the app and ask, even after a reload
  if (!BUSY.includes(s)) guard = false;
  $("reconnect").hidden = s !== "RECONNECTING";
  document.body.classList.toggle("ingame", !!stream && (s === "IN_GAME" || s === "RECONNECTING"));
  if (s !== "IN_GAME" && s !== "RECONNECTING") stopStream();
  switch (s) {
    case "IDLE": show(view); if (view === "home") renderHome(); if (view === "create") renderCreate(); if (view === "join") renderJoin(); break;
    case "CREATING_ROOM": $("joiningTitle").textContent = "Creo la stanza…"; $("joiningStep").textContent = ""; show("joining"); break;
    case "JOINING": $("joiningTitle").textContent = "Mi collego…"; $("joiningStep").textContent = st.step || ""; show("joining"); break;
    case "NETWORK_CHECK": if (st.role === "guest") { show("netcheck"); break; } renderLobby(); show("lobby"); break;
    case "WAITING_FOR_PEER": case "CONNECTED": case "READY": renderLobby(); show("lobby"); break;
    case "STARTING": case "DOWNLOAD_PLAY": renderStarting(); show("starting"); break;
    case "IN_GAME": if (!stream) { renderStarting(); show("starting"); } ensureStream(); break;
    case "RECONNECTING": if (!stream) { renderStarting(); show("starting"); } else ensureStream(); break;
    case "ENDED": case "ERROR": renderEnded(); show("ended"); break;
  }
  if (DEV) $("devDump").textContent = JSON.stringify(st.dev || st, null, 1).slice(0, 4000);
}

function renderHome() {
  const r = recent(); $("recent").hidden = !r.length;
  $("recentList").innerHTML = ""; r.forEach((g) => { const li = document.createElement("li"), b = document.createElement("button"); b.innerHTML = `<span></span><small>Crea di nuovo</small>`; b.firstChild.textContent = g.title; b.onclick = () => quickCreate(g.id); li.append(b); $("recentList").append(li); });
}
async function quickCreate(id) { const res = await api("POST", "/api/mp/create", { gameId: id, mode: devMode() }); if (!res.ok) { alertErr(res.j.error); return; } await poll(); }
const devMode = () => (DEV ? $("devMode").value : "auto");

async function loadGames() { const r = await api("GET", "/api/mp/library"); games = r.j.games || []; }
async function renderCreate() {
  await loadGames();
  const ul = $("gameList"); ul.innerHTML = "";
  if (!games.length) { const li = document.createElement("li"); li.textContent = "La libreria è vuota. Aggiungi un gioco."; ul.append(li); }
  games.forEach((g) => { const li = document.createElement("li"); li.className = selected === g.id ? "sel" : ""; li.innerHTML = `<span></span><span class="tick">✓</span>`; li.firstChild.textContent = g.title; li.onclick = () => { selected = g.id; renderCreate(); }; ul.append(li); });
  $("btnMakeRoom").disabled = !selected;
}
$("btnCreate").onclick = () => { selected = null; $("createErr").textContent = ""; go("create"); };
$("btnJoin").onclick = () => { $("joinErr").textContent = ""; go("join"); };
$("romFile").onchange = async (e) => {
  const f = e.target.files[0]; if (!f) return; const fd = new FormData(); fd.append("rom", f);
  $("createErr").textContent = "Aggiungo il gioco…"; const r = await api("POST", "/api/mp/library", fd);
  $("createErr").textContent = r.ok ? "" : (r.j.error || "File non valido."); if (r.ok) selected = r.j.id; e.target.value = ""; renderCreate();
};
$("btnMakeRoom").onclick = async () => {
  const g = games.find((x) => x.id === selected); if (!g) return;
  const r = await api("POST", "/api/mp/create", { gameId: g.id, mode: devMode() });
  if (!r.ok) { $("createErr").textContent = r.j.error.message; return; }
  remember(g); await poll();
};

// join: code, QR, nearby
let nearbyTimer = 0;
function renderJoin() { clearTimeout(nearbyTimer); refreshNearby(); }
async function refreshNearby() {
  if (GUEST || document.body.dataset.screen !== "join" || st.state !== "IDLE") return;   // a browser guest never discovers rooms: it joins the host it opened the page from
  const r = await api("GET", "/api/mp/nearby"); const rooms = r.j.rooms || [];
  const ul = $("nearbyList"); ul.innerHTML = "";
  rooms.forEach((n) => { const li = document.createElement("li"); li.innerHTML = `<div><span></span><small></small></div><button>UNISCITI</button>`; li.querySelector("span").textContent = n.title; li.querySelector("small").textContent = `Host: ${n.host}`; li.querySelector("button").onclick = () => doJoin({ room: n.room }); ul.append(li); });
  $("nearbyEmpty").hidden = rooms.length > 0; $("nearbyEmpty").textContent = "Nessuna partita trovata sulla rete. Inserisci il codice o scansiona il QR.";
  nearbyTimer = setTimeout(refreshNearby, 1500);
}
$("codeInput").oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); $("btnJoinCode").disabled = e.target.value.length !== 6; };
async function doJoin(req) { $("joinErr").textContent = ""; const r = await api("POST", "/api/mp/join", req); if (!r.ok) { $("joinErr").textContent = r.j.error.message; await poll(); return; } await poll(); }
$("btnJoinCode").onclick = () => doJoin({ code: $("codeInput").value, addr: DEV ? $("devAddr").value.trim() : "" });
$("btnJoinPayload").onclick = () => doJoin({ payload: $("payloadInput").value });
$("btnJoiningCancel").onclick = async () => { await leaveSession(); };

function drawQR(payload) {
  const c = $("qr"); if (c.dataset.payload === payload) return; c.dataset.payload = payload;
  const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  if (!payload || typeof qrcode !== "function") return;
  const q = qrcode(0, "M"); q.addData(payload); q.make();
  const n = q.getModuleCount(), cell = Math.floor((c.width - 16) / n), off = Math.floor((c.width - cell * n) / 2);
  g.fillStyle = "#000"; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (q.isDark(y, x)) g.fillRect(off + x * cell, off + y * cell, cell, cell);
}

function playerRow(label, p, hostRow, optional) {
  const li = document.createElement("li"); const name = document.createElement("span"); const stt = document.createElement("span"); stt.className = "st";
  name.textContent = p && p.name ? `${label} · ${p.name}` : label;
  if (!p) { stt.textContent = optional ? "Facoltativo" : "In attesa…"; stt.classList.add("wait"); }
  else if (p.pending) { stt.textContent = "Chiede di unirsi"; stt.classList.add("pend"); }
  else if (hostRow) { stt.textContent = "✓ Pronto"; stt.classList.add("ok"); }
  else if (p.ready) { stt.textContent = "✓ Pronto"; stt.classList.add("ok"); }
  else { stt.textContent = "✓ Connesso"; stt.classList.add("ok"); }
  li.append(name, stt); return li;
}
function renderLobby() {
  const host = st.role === "host";
  $("lobbyGame").textContent = (st.game && st.game.title) || "";
  const m = st.mode || {}; $("lobbyMode").textContent = "Modalità: " + (m.effective === "distributed" ? "Distribuita" : m.effective === "hosted" ? "Hosted" : "Automatica");
  $("lobbyCode").textContent = st.code || "------"; drawQR(host ? st.qr : ""); document.querySelector(".codebox").style.display = host ? "" : "none";
  const ul = $("players"); ul.innerHTML = "";
  const pls = st.players || [], h = pls.find((p) => p.role === "host"), g1 = pls.find((p) => p.slot === 1), g2 = pls.find((p) => p.slot === 2);
  ul.append(playerRow("HOST", h, true), playerRow("PLAYER 2", g1, false), playerRow("PLAYER 3", g2, false, !!g1 && !g2));   // up to two guests; the second one is optional
  const n = st.net || {}; const badge = $("netBadge"); badge.textContent = n.label || "In verifica…"; badge.className = "badge " + (n.done ? n.class : ""); $("netHint").textContent = n.done ? (n.hint || "") : "";
  $("lobbyNotice").textContent = st.error ? st.error.message : (m.note || (st.step && st.state !== "READY" ? st.step : ""));
  const pend = (st.players || []).find((p) => p.pending); $("approveBox").hidden = !(host && pend); if (pend) $("approveName").textContent = `${pend.name} vuole unirsi`;
  $("btnStart").hidden = !host; $("btnStart").disabled = !st.canStart;
  const me = (st.players || []).find((p) => p.role === "guest" && p.slot === st.you); $("btnReady").hidden = host || !me || !me.connected; $("btnReady").textContent = me && me.ready ? "ANNULLA PRONTO" : "PRONTO";
  $("btnCancel").textContent = host ? "ANNULLA PARTITA" : "ESCI";
}
$("btnStart").onclick = async () => { const r = await api("POST", "/api/mp/start"); if (!r.ok) $("lobbyNotice").textContent = r.j.error.message; await poll(); };
$("btnReady").onclick = async () => { const me = (st.players || []).find((p) => p.role === "guest" && p.slot === st.you); await api("POST", "/api/mp/ready", { ready: !(me && me.ready) }); lastDump = ""; await poll(); };
$("btnCancel").onclick = () => askLeave();
$("btnApprove").onclick = async () => { await api("POST", "/api/mp/approve", { accept: true }); await poll(); };
$("btnReject").onclick = async () => { await api("POST", "/api/mp/approve", { accept: false }); await poll(); };

function renderStarting() {
  const items = [...$("startSteps").children]; const idx = items.findIndex((li) => li.dataset.step === st.step);
  items.forEach((li, i) => { li.className = idx < 0 ? "" : i < idx ? "done" : i === idx ? "doing" : ""; });
  $("startNote").textContent = (st.mode && st.mode.note) || "";
  $("startTitle").textContent = st.state === "RECONNECTING" ? "Riconnessione…" : "Avvio della partita";
}
$("btnStartCancel").onclick = () => askLeave();

function renderEnded() {
  const e = st.error || { code: "internal", message: "Qualcosa è andato storto. Riprova." };
  $("endTitle").textContent = ["peer_lost", "peer_left"].includes(e.code) ? "Connessione persa" : "Partita terminata"; $("endMsg").textContent = e.message;
  const recoverable = ["peer_lost", "peer_left", "setup_timeout", "start_failed"].includes(e.code);
  $("btnBackLobby").hidden = !recoverable; $("btnCloseGame").textContent = recoverable ? "CHIUDI PARTITA" : "OK";
}
$("btnBackLobby").onclick = async () => { const r = await api("POST", "/api/mp/lobby-return"); if (!r.ok) { await api("POST", "/api/mp/reset"); view = "home"; } await poll(); };
$("btnCloseGame").onclick = async () => { await api("POST", "/api/mp/reset"); view = "home"; history.replaceState({ view: "home" }, ""); lastDump = ""; await poll(); };

// ---------------------------------------------------------------- QR scanning (camera needs a secure origin; falls back to code entry)
let scanStop = null;
$("btnScan").onclick = async () => {
  $("scanner").hidden = false; $("scanHint").textContent = "Inquadra il QR della partita";
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $("scanHint").textContent = "La fotocamera non è disponibile su questa connessione. Inserisci il codice della partita."; return; }
  let media; try { media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); } catch { $("scanHint").textContent = "Non riesco ad usare la fotocamera. Inserisci il codice della partita."; return; }
  const v = $("scanVideo"); v.srcObject = media; await v.play().catch(() => {});
  const det = "BarcodeDetector" in window ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null, cv = document.createElement("canvas"); let alive = true;
  scanStop = () => { alive = false; media.getTracks().forEach((t) => t.stop()); $("scanner").hidden = true; scanStop = null; };
  const tick = async () => {
    if (!alive) return; let raw = "";
    try { if (det) { const f = await det.detect(v); raw = f[0] ? f[0].rawValue : ""; } else if (v.videoWidth && typeof jsQR === "function") { cv.width = v.videoWidth; cv.height = v.videoHeight; const g = cv.getContext("2d"); g.drawImage(v, 0, 0); const r = jsQR(g.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height); raw = r ? r.data : ""; } } catch { /* next frame */ }
    if (raw.startsWith("dslink://join?") || /^http:\/\/[^/]+\/guest\/\?/.test(raw)) { scanStop(); doJoin({ payload: raw }); return; }
    requestAnimationFrame(tick);
  };
  tick();
};
$("btnScanClose").onclick = () => { if (scanStop) scanStop(); else $("scanner").hidden = true; };

// ---------------------------------------------------------------- the game screen: WebRTC to the console that is shown on THIS device (or, Hosted guest, to the host)
function stopStream() {
  if (!stream) return;
  const s = stream; stream = null;
  try { s.controls.destroy(); if (s.ws) s.ws.close(); if (s.pc) s.pc.close(); if (s.ro) s.ro.disconnect(); } catch { /* closed */ }
  if (s.native) { try { ANDROID.gameVisible(false); } catch { /* app gone */ } }
  $("game").hidden = true; $("game").innerHTML = ""; $("game").classList.remove("native"); delete window.dslinkGame; document.body.classList.remove("ingame", "native"); document.documentElement.classList.remove("native");
}
// ---- Android app: the console of THIS device is drawn by the app itself (shared memory -> GL surface behind the page), the page only supplies the frozen touch
// controls. The controls engine lays the picture out exactly as before; its rectangles are handed to the app, and its buttons/stylus go to the app's input path.
const ANDROID = window.DSLinkAndroid || null;
function ensureNative() {
  if (stream) return;
  const root = $("game"); root.hidden = false; root.innerHTML = ""; root.classList.add("native");
  const ph = document.createElement("div"); ph.className = "ctl-placeholder";
  let down = false;
  const sink = { btn: (k, d) => ANDROID.btn(k, !!d), stylus: (x, y, d, m) => { if (!m) down = !!d; ANDROID.touch(x, y, m ? down : !!d); }, ui() {} };
  const controls = mountControls({ container: root, video: ph, platform: "nds", persist: true, onLeave: () => askLeave(), sink });
  let raf = 0;
  const report = () => {
    raf = 0; const dpr = window.devicePixelRatio || 1, c = ph.parentElement.getBoundingClientRect(), v = ph.getBoundingClientRect();
    try { ANDROID.setLayout(c.left * dpr, c.top * dpr, c.right * dpr, c.bottom * dpr, v.left * dpr, v.top * dpr, v.right * dpr, v.bottom * dpr, true); } catch { /* app gone */ }
  };
  const kick = () => { if (!raf) raf = requestAnimationFrame(report); };
  const ro = new MutationObserver(kick);
  ro.observe(ph, { attributes: true, attributeFilter: ["style"] }); ro.observe(ph.parentElement, { attributes: true, attributeFilter: ["style"] });
  window.addEventListener("resize", kick); window.addEventListener("orientationchange", kick);
  stream = { native: true, controls, ro }; window.dslinkGame = { native: true, btn: sink.btn, touch: sink.stylus, get controls() { return controls; } };
  document.body.classList.add("ingame", "native"); document.documentElement.classList.add("native");
  kick(); setTimeout(kick, 120); setTimeout(kick, 500);
  try { ANDROID.gameVisible(true); } catch { /* app gone */ }
}
async function ensureStream() {
  const ig = st.ingame; if (!ig) return;
  if (ig.native && ANDROID) { ensureNative(); return; }
  if (stream && !stream.native && !["failed", "closed", "disconnected"].includes(stream.pc.connectionState)) return;
  if (Date.now() - lastStreamAt < 3000) return; lastStreamAt = Date.now(); stopStream();
  const root = $("game"); root.hidden = false; root.innerHTML = "";
  const video = document.createElement("video"); video.playsInline = true; video.autoplay = true; root.append(video);
  if (GUEST || IOS) {   // iOS lets a page autoplay only muted video; the first touch on the controls (a user gesture) switches the sound on
    video.muted = true;
    const unmute = () => { video.muted = false; video.play().catch(() => {}); root.removeEventListener("pointerdown", unmute, true); root.removeEventListener("touchend", unmute, true); };
    root.addEventListener("pointerdown", unmute, true); root.addEventListener("touchend", unmute, true);
  }
  const remote = ig.base ? new URL(ig.base) : location, host = remote.host;
  let ice = []; if (!ig.base) { const c = await fetch("/api/config").then((r) => r.json()).catch(() => ({})); ice = c.iceServers || []; }
  const pc = new RTCPeerConnection({ iceServers: ice });
  const dc = pc.createDataChannel("input", { ordered: true }), dcMove = pc.createDataChannel("move", { ordered: false, maxRetransmits: 0 });
  pc.addTransceiver("video", { direction: "recvonly" }); pc.addTransceiver("audio", { direction: "recvonly" });
  pc.ontrack = (e) => { if (!video.srcObject) video.srcObject = new MediaStream(); video.srcObject.addTrack(e.track); video.play().catch(() => {}); };
  const ws = new WebSocket(`${remote.protocol === "https:" ? "wss" : "ws"}://${host}/ws?code=${ig.code}&player=${ig.player}&token=${ig.token}`);
  ws.onmessage = async (m) => { const s = JSON.parse(m.data); if (s.type === "answer") await pc.setRemoteDescription({ type: "answer", sdp: s.sdp }); else if (s.type === "candidate" && s.candidate) await pc.addIceCandidate(s.candidate); };
  pc.onicecandidate = (e) => { if (e.candidate && ws.readyState === 1) ws.send(JSON.stringify({ type: "candidate", candidate: e.candidate.toJSON() })); };
  ws.onopen = async () => { const o = await pc.createOffer(); await pc.setLocalDescription(o); ws.send(JSON.stringify({ type: "offer", sdp: o.sdp })); };
  const send = (o, ch = dc) => { if (ch.readyState === "open") ch.send(JSON.stringify(o)); };
  const btn = (k, d) => send({ t: "btn", k, d }), touch = (x, y, d, m) => send({ t: "touch", x, y, d, m }, m ? dcMove : dc);
  const controls = mountControls({ container: root, video, platform: "nds", persist: true, onLeave: () => askLeave(), sink: { btn, stylus: touch, ui() {} } });
  stream = { pc, ws, dc, controls, video }; window.dslinkGame = { pc, dc, dcMove, ws, video, btn, touch, get controls() { return controls; } };
  document.body.classList.add("ingame");
}

// A stream that dropped (Wi-Fi blip, Safari back from the background) is rebuilt while the session is still IN_GAME: the host keeps the console running for the grace period.
setInterval(() => { if (st.state === "IN_GAME" && stream && !stream.native && stream.pc && ["failed", "closed", "disconnected"].includes(stream.pc.connectionState)) ensureStream(); }, 2000);

// ---------------------------------------------------------------- guest page: the QR the host shows is a web address (the iPhone's Camera opens it here); the page joins with it once
if (GUEST) {
  const q = new URLSearchParams(location.search);
  if (q.get("c") && q.get("s")) {
    const payload = location.href;
    history.replaceState({ view: "join" }, "", "/guest/");   // the secret does not stay in the address bar / history
    setTimeout(() => { if (st.state === "IDLE") doJoin({ payload }); }, 150);
  }
}

// ---------------------------------------------------------------- Android app extras (system files, performance overlay, NSD hints)
if (ANDROID) {
  $("btnSysFiles").hidden = false; $("btnSysFiles").onclick = () => ANDROID.openSystemFiles();
  document.querySelectorAll(".devandroid").forEach((e) => { e.hidden = false; });
  $("devOverlay").onchange = () => ANDROID.setDevOverlay($("devOverlay").checked);
  $("devEncTest").onclick = () => { $("devEncOut").textContent = "Test in corso (qualche secondo)…"; setTimeout(() => { try { $("devEncOut").textContent = ANDROID.encoderSelfTest(); } catch { $("devEncOut").textContent = "non disponibile"; } }, 60); };
}
// ---------------------------------------------------------------- developer menu
let taps = 0; $("logo").onclick = () => { if (++taps >= 5) { taps = 0; document.body.classList.toggle("dev"); try { localStorage.setItem("dslink.dev", document.body.classList.contains("dev") ? "1" : "0"); } catch { /* ignore */ } location.reload(); } };
$("devMode").onchange = () => api("POST", "/api/mp/dev/mode", { mode: $("devMode").value });
function alertErr(e) { const t = (e && e.message) || "Qualcosa è andato storto."; $("createErr").textContent = t; }
window.__mp = { joinPayload: (p) => doJoin({ payload: p }), get state() { return st; } };   // test hook
poll();
