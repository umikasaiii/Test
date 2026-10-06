// DSLink multiplayer UX (LAN/local, no cloud). The UI renders ONE document, /api/mp/state, from this device's gateway; it never decides session logic itself.
import { mountControls } from "/controls/controls.js";

const $ = (id) => document.getElementById(id);
const api = async (method, path, body) => {
  const init = { method };
  if (body instanceof FormData) init.body = body; else if (body) { init.headers = { "content-type": "application/json" }; init.body = JSON.stringify(body); }
  const r = await fetch(path, init); let j = {}; try { j = await r.json(); } catch { /* empty */ }
  return { ok: r.ok, status: r.status, j };
};
const DEV = new URLSearchParams(location.search).has("dev") || (() => { try { return localStorage.getItem("dslink.dev") === "1"; } catch { return false; } })();
if (DEV) document.body.classList.add("dev");

let st = { state: "IDLE" }, view = "home", games = [], selected = null, stream = null, lastDump = "", streamTries = 0, lastStreamAt = 0, pendingLeave = null;
const RECENT_KEY = "dslink.mp.recent";
const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]"); } catch { return []; } };
const remember = (g) => { try { const r = [{ id: g.id, title: g.title, ts: Date.now() }, ...recent().filter((x) => x.id !== g.id)].slice(0, 4); localStorage.setItem(RECENT_KEY, JSON.stringify(r)); } catch { /* ignore */ } };

// ---------------------------------------------------------------- screens + history
const screens = () => [...document.querySelectorAll(".screen")];
function show(name) { screens().forEach((s) => s.classList.toggle("on", s.dataset.screen === name)); document.body.dataset.screen = name; }
function go(next, push = true) { view = next; if (push) history.pushState({ view: next }, ""); render(); }
history.replaceState({ view: "home" }, "");
window.addEventListener("popstate", (e) => {
  const busy = ["WAITING_FOR_PEER", "JOINING", "CONNECTED", "NETWORK_CHECK", "READY", "STARTING", "DOWNLOAD_PLAY", "IN_GAME", "RECONNECTING", "CREATING_ROOM"].includes(st.state);
  if (busy) { history.pushState({ view }, ""); askLeave(); return; }       // Back inside a session never loses it silently
  view = (e.state && e.state.view) || "home"; if (!["home", "create", "join"].includes(view)) view = "home"; render();
});
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
function render() {
  const s = st.state;
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
  if (document.body.dataset.screen !== "join" || st.state !== "IDLE") return;
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

function playerRow(label, p, hostRow) {
  const li = document.createElement("li"); const name = document.createElement("span"); const stt = document.createElement("span"); stt.className = "st";
  name.textContent = p && p.name ? `${label} · ${p.name}` : label;
  if (!p) { stt.textContent = "In attesa…"; stt.classList.add("wait"); }
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
  const h = (st.players || []).find((p) => p.role === "host"), g = (st.players || []).find((p) => p.role === "guest");
  ul.append(playerRow("HOST", h, true), playerRow("PLAYER 2", g, false));
  const n = st.net || {}; const badge = $("netBadge"); badge.textContent = n.label || "In verifica…"; badge.className = "badge " + (n.done ? n.class : ""); $("netHint").textContent = n.done ? (n.hint || "") : "";
  $("lobbyNotice").textContent = st.error ? st.error.message : (m.note || (st.step && st.state !== "READY" ? st.step : ""));
  const pend = (st.players || []).find((p) => p.pending); $("approveBox").hidden = !(host && pend); if (pend) $("approveName").textContent = `${pend.name} vuole unirsi`;
  $("btnStart").hidden = !host; $("btnStart").disabled = !st.canStart;
  const me = (st.players || []).find((p) => p.role === "guest"); $("btnReady").hidden = host || !me || !me.connected; $("btnReady").textContent = me && me.ready ? "ANNULLA PRONTO" : "PRONTO";
  $("btnCancel").textContent = host ? "ANNULLA PARTITA" : "ESCI";
}
$("btnStart").onclick = async () => { const r = await api("POST", "/api/mp/start"); if (!r.ok) $("lobbyNotice").textContent = r.j.error.message; await poll(); };
$("btnReady").onclick = async () => { const me = (st.players || []).find((p) => p.role === "guest"); await api("POST", "/api/mp/ready", { ready: !(me && me.ready) }); lastDump = ""; await poll(); };
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
    if (raw.startsWith("dslink://join?")) { scanStop(); doJoin({ payload: raw }); return; }
    requestAnimationFrame(tick);
  };
  tick();
};
$("btnScanClose").onclick = () => { if (scanStop) scanStop(); else $("scanner").hidden = true; };

// ---------------------------------------------------------------- the game screen: WebRTC to the console that is shown on THIS device (or, Hosted guest, to the host)
function stopStream() {
  if (!stream) return;
  const s = stream; stream = null;
  try { s.controls.destroy(); s.ws.close(); s.pc.close(); } catch { /* closed */ }
  $("game").hidden = true; $("game").innerHTML = ""; delete window.dslinkGame; document.body.classList.remove("ingame");
}
async function ensureStream() {
  const ig = st.ingame; if (!ig) return;
  if (stream && !["failed", "closed", "disconnected"].includes(stream.pc.connectionState)) return;
  if (Date.now() - lastStreamAt < 3000) return; lastStreamAt = Date.now(); stopStream();
  const root = $("game"); root.hidden = false; root.innerHTML = "";
  const video = document.createElement("video"); video.playsInline = true; video.autoplay = true; root.append(video);
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

// ---------------------------------------------------------------- developer menu
let taps = 0; $("logo").onclick = () => { if (++taps >= 5) { taps = 0; document.body.classList.toggle("dev"); try { localStorage.setItem("dslink.dev", document.body.classList.contains("dev") ? "1" : "0"); } catch { /* ignore */ } location.reload(); } };
$("devMode").onchange = () => api("POST", "/api/mp/dev/mode", { mode: $("devMode").value });
function alertErr(e) { const t = (e && e.message) || "Qualcosa è andato storto."; $("createErr").textContent = t; }
window.__mp = { joinPayload: (p) => doJoin({ payload: p }), get state() { return st; } };   // test hook
poll();
