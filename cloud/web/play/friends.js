// "Gioca con amici" screens: create a game / join with code or QR, the two-player lobby and the "connection lost" screen. Pure UI on top of session.js.
// What the user sees: a 6-digit code (and its QR), HOST / PLAYER 2, Connessione... / Connesso / Pronto, OTTIMA / BUONA / NON ADATTA. Never SDP, IP, ports or ICE.
import { Session, signalBase } from "./session.js";
import { opt } from "./options.js";

export function initFriends(ctx) {
  const { $, show } = ctx;
  let session = null, scanStop = null;

  const joinUrl = (code) => {
    const u = new URL(location.href); u.search = ""; u.hash = ""; u.searchParams.set("join", code);
    const sg = opt("signal", ""); if (sg) u.searchParams.set("signal", sg);
    return u.href;
  };
  // the same game on both devices: same ROM (same id) or the same cartridge code (another dump of the same game)
  const localGame = (g) => g && (ctx.games().find((x) => x.id === g.id) || ctx.games().find((x) => g.code && x.code === g.code));
  const sessionOpts = (role, game) => ({
    role, base: signalBase(opt), game, iceServers: [{ urls: "stun:stun.l.google.com:19302" }].filter(() => opt("stun", "1") !== "0"),
    radioMode: opt("radiomode", "") === "ordered" ? { ordered: true } : opt("radiomode", "") === "reliable" ? { ordered: true } : undefined,
    impair: { delayMs: +opt("delay", 0) || 0, jitterMs: +opt("jitter", 0) || 0, lossPct: +opt("loss", 0) || 0 },
    hasGame: (g) => !!localGame(g),
    onChange: render, onStart: (s) => ctx.startGame(s.role === "host" ? s.o.game.id : localGame(s.hostGame).id, s), onLost: (why) => ctx.onLost(why),
  });
  const errText = (e) => (e && e.status === 404 ? "Codice non valido o partita scaduta." : e && e.status === 409 ? "La partita è già al completo." : e && e.status === 429 ? "Troppi tentativi. Riprova tra un minuto." : "Non riesco a collegarmi. Controlla la connessione.");

  // SharedArrayBuffer for the radio receive ring needs cross-origin isolation; on static hosting the service worker provides it. First use: turn it on and reload once (the plain
  // message-queue path still works when it cannot be had, e.g. no service worker; the lobby tells the user the limits)
  async function ensureIsolation(then) {
    if (self.crossOriginIsolated || opt("coi", "auto") === "0" || !("serviceWorker" in navigator) || !self.isSecureContext) return false;
    let tried = false; try { tried = sessionStorage.getItem("dslink.coiTried") === "1"; } catch { /* blocked */ }
    if (tried) return false;
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 1500))]); if (!reg || !navigator.serviceWorker.controller) return false;
    try { sessionStorage.setItem("dslink.coiTried", "1"); } catch { /* blocked */ }
    await new Promise((resolve) => { const to = setTimeout(resolve, 1500); navigator.serviceWorker.addEventListener("message", function f(e) { if (e.data && e.data.t === "coi") { clearTimeout(to); navigator.serviceWorker.removeEventListener("message", f); resolve(); } }); navigator.serviceWorker.controller.postMessage({ t: "coi", on: true }); });
    const u = new URL(location.href); u.searchParams.set("friends", then); location.replace(u.href); return true;
  }

  // ---- create
  $("btnCreate").onclick = async () => {
    if (await ensureIsolation("create")) return;
    const games = ctx.games(); const sel = $("friendGame"); sel.innerHTML = "";
    $("createErr").textContent = games.length ? "" : "Aggiungi prima un gioco alla libreria.";
    for (const g of games) { const o = document.createElement("option"); o.value = g.id; o.textContent = g.title || g.id; sel.append(o); }
    $("btnMakeRoom").disabled = !games.length; show("friends-create");
  };
  $("btnCreateBack").onclick = () => show("library");
  $("btnMakeRoom").onclick = async () => {
    const g = ctx.games().find((x) => x.id === $("friendGame").value); if (!g) return;
    $("btnMakeRoom").disabled = true; $("createErr").textContent = "";
    try {
      session = new Session(sessionOpts("host", { id: g.id, code: g.code, title: g.title }));
      await session.create(); show("lobby"); render(session);
    } catch (e) { session = null; $("createErr").textContent = errText(e); }
    $("btnMakeRoom").disabled = false;
  };

  // ---- join
  $("btnJoin").onclick = async () => {
    if (await ensureIsolation("join")) return; $("joinErr").textContent = ""; $("joinCode").value = ""; $("scanHint").textContent = ""; show("friends-join"); };
  $("btnJoinBack").onclick = () => { stopScan(); show("library"); };
  $("joinCode").oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); };
  $("btnDoJoin").onclick = () => doJoin($("joinCode").value);
  async function doJoin(code) {
    stopScan(); if (!/^\d{6}$/.test(code)) { $("joinErr").textContent = "Il codice ha 6 cifre."; return; }
    $("joinErr").textContent = ""; $("btnDoJoin").disabled = true;
    try {
      session = new Session(sessionOpts("guest", null));
      await session.join(code); show("lobby"); render(session);
    } catch (e) { session = null; $("joinErr").textContent = errText(e); show("friends-join"); }
    $("btnDoJoin").disabled = false;
  }
  async function startScan() {
    const hint = $("scanHint");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { hint.textContent = "La fotocamera non è disponibile qui. Inserisci il codice."; return; }
    let media; try { media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }); } catch { hint.textContent = "Non riesco ad usare la fotocamera. Inserisci il codice."; return; }
    const v = $("scanVideo"); v.srcObject = media; v.hidden = false; await v.play().catch(() => {});
    if (!("BarcodeDetector" in window) && typeof jsQR !== "function") await new Promise((r) => { const s = document.createElement("script"); s.src = "../mp/vendor/jsQR.js"; s.onload = s.onerror = r; document.head.append(s); });
    const det = "BarcodeDetector" in window ? new window.BarcodeDetector({ formats: ["qr_code"] }) : null, cv = document.createElement("canvas"); let alive = true;
    scanStop = () => { alive = false; media.getTracks().forEach((t) => t.stop()); v.srcObject = null; v.hidden = true; scanStop = null; };
    hint.textContent = "Inquadra il QR dell'amico…";
    (async function loop() {
      while (alive) {
        let raw = ""; try { if (det) { const f = await det.detect(v); raw = f[0] ? f[0].rawValue : ""; } else if (v.videoWidth && typeof jsQR === "function") { cv.width = v.videoWidth; cv.height = v.videoHeight; const g = cv.getContext("2d"); g.drawImage(v, 0, 0); const r = jsQR(g.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height); raw = r ? r.data : ""; } } catch { /* next frame */ }
        const m = /(?:[?&]join=|^)(\d{6})(?:&|$)/.exec(raw || ""); if (m) { $("joinCode").value = m[1]; doJoin(m[1]); return; }
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
  }
  function stopScan() { if (scanStop) scanStop(); }
  $("btnScan").onclick = () => { if (scanStop) stopScan(); else startScan(); };

  // ---- lobby
  const slot = (id, text, cls) => { const e = $(id); e.textContent = text; e.className = "st " + (cls || ""); };
  function render(s) {
    if (s !== session || !s) return;
    const host = s.role === "host", open = s.peer && (s.peer.state === "open" || s.peer.state === "degraded"), both = open && s.other.present;
    $("lobbyTitle").textContent = host ? "La tua partita" : "Partita dell'amico";
    $("lobbyCode").hidden = !host; $("codeText").textContent = host ? s.code : "";
    if (host && s.code && $("codeQr").dataset.code !== s.code) drawQr(s.code);
    const mine = s.me.ready ? ["Pronto", "ok"] : ["Connesso", "ok"], theirs = !both ? (s.state === "connecting" ? ["Connessione…", "wait"] : ["In attesa…", "wait"]) : s.other.ready ? ["Pronto", "ok"] : ["Connesso", "ok"];
    slot("stHost", host ? mine[0] : theirs[0], host ? mine[1] : theirs[1]); slot("stGuest", host ? theirs[0] : mine[0], host ? theirs[1] : mine[1]);
    const q = s.quality; $("lobbyQuality").className = "quality " + (q ? q.level : ""); $("lobbyQuality").textContent = s.qualityBusy ? "Controllo la connessione…" : q ? "Connessione: " + q.label : "";
    let note = "";
    if (!both) note = host ? "Fai inserire il codice all'amico." : "Mi collego alla partita…";
    else if (!host && s.hostGame && !s.gameOk) note = `Per giocare serve «${s.hostGame.title}»: aggiungilo alla tua libreria.`;
    else if (q && q.level === "RED") note = "La connessione non è adatta: avvicinatevi al router Wi-Fi o usate la stessa rete. Puoi provare comunque.";
    else if (s.other.hidden) note = "L'amico ha messo l'app in secondo piano…";
    $("lobbyNote").textContent = note;
    $("btnReady").hidden = host ? true : !both; $("btnReady").disabled = !s.gameOk; $("btnReady").textContent = s.me.ready ? "ANNULLA" : "PRONTO";
    $("btnStart").hidden = !host; $("btnStart").disabled = !s.canStart();
  }
  function drawQr(code) {
    const c = $("codeQr"); c.dataset.code = code;
    if (typeof qrcode !== "function") return;
    const q = qrcode(0, "M"); q.addData(joinUrl(code)); q.make(); const n = q.getModuleCount(), g = c.getContext("2d"), px = Math.floor(c.width / (n + 2));
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.fillStyle = "#000";
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) g.fillRect((k + 1) * px, (r + 1) * px, px, px);
  }
  $("btnReady").onclick = () => { if (session) session.setReady(!session.me.ready); };
  $("btnStart").onclick = () => { if (session) session.start(); };
  $("btnLobbyLeave").onclick = () => leave();
  async function leave() { const s = session; session = null; if (s) await s.close(); show("library"); }
  $("btnLostBack").onclick = () => show("library");

  // ?join=CODE (QR scanned with the camera app): open the join screen and connect
  const jc = new URLSearchParams(location.search).get("join");   // (the page opened from a QR is not isolated yet: the message-queue path is used; the next visit gets the ring)
  return {
    get session() { return session; },
    leave, doJoin,
    /** the game ended or the link dropped while playing: close the room and tell the user */
    async lost(why) { const s = session; session = null; if (s) { s.state === "closed" || (await s.close()); } $("lostNote").textContent = why || ""; show("lost"); },
    async endSession() { const s = session; session = null; if (s) await s.close(); },
    resume() { const f = new URLSearchParams(location.search).get("friends"); if (f === "create") $("btnCreate").onclick(); else if (f === "join") $("btnJoin").onclick(); },
    autoJoin() { if (jc && /^\d{6}$/.test(jc)) { $("joinCode").value = jc; show("friends-join"); doJoin(jc); } },
  };
}
