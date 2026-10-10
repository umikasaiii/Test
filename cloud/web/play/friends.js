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
  // ICE servers come from the Cloud (short-lived TURN credentials, never in the app); anonymous play gets public STUN only
  const sessionOpts = (role, game, ice = {}) => ({
    role, base: signalBase(opt), game, iceServers: ice.iceServers || [], iceTransportPolicy: ice.iceTransportPolicy, relayAvailable: ice.relayAvailable,
    profileOf: (g) => ctx.profileOf(g), hostedAvailable: () => ctx.hostedAvailable(), startHosted: (s) => ctx.startHosted(s),
    radioMode: opt("radiomode", "") === "ordered" ? { ordered: true } : opt("radiomode", "") === "reliable" ? { ordered: true } : undefined,
    impair: { delayMs: +opt("delay", 0) || 0, jitterMs: +opt("jitter", 0) || 0, lossPct: +opt("loss", 0) || 0 },
    hasGame: (g) => !!localGame(g),
    canDownload: () => ctx.hasSystem(),
    hostCheck: (s) => (s.dlplay ? hpBlock(s) || ctx.hostDlBlock() : ""),
    onChange: render, onStart: (s) => (s.role === "guest" && s.dlplay ? ctx.startGame(null, s) : ctx.startGame(s.role === "host" ? s.o.game.id : localGame(s.hostGame).id, s)), onLost: (why) => ctx.onLost(why),
  });
  const errText = (e) => (e && e.status === 404 ? "Codice non valido o partita scaduta." : e && e.status === 409 ? "La partita è già al completo." : e && e.status === 429 ? "Troppi tentativi. Riprova tra un minuto." : "Non riesco a collegarmi. Controlla la connessione.");

  // HIGH-PERFORMANCE MODE (SharedArrayBuffer radio ring). Real games wait for radio replies inside very tight windows: the message-queue fallback is NOT enough for them (measured with Mario Party DS:
  // Download Play fails in the handshake). The ring needs a cross-origin isolated page; on static hosting the service worker provides it. The reload is done at the LAST moment before the
  // network is used, with the intent saved (create: chosen game; join: the room code), so nothing is asked twice and no room exists yet that could be lost.
  const INTENT = "dslink.intent", TRIED = "dslink.coiTried";
  const store = (k, v) => { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, v); } catch { /* blocked */ } };
  const load = (k) => { try { return sessionStorage.getItem(k); } catch { return null; } };
  const isolated = () => !!self.crossOriginIsolated;
  async function prepare(intent) {
    if (isolated() || opt("coi", "auto") === "0" || !("serviceWorker" in navigator) || !self.isSecureContext || load(TRIED) === "1") return false;
    const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 5000))]); if (!reg || !reg.active) return false;   // first visit: the worker is still installing
    if (!navigator.serviceWorker.controller) await new Promise((r) => { const to = setTimeout(r, 3000); navigator.serviceWorker.addEventListener("controllerchange", () => { clearTimeout(to); r(); }, { once: true }); });
    store(TRIED, "1"); store(INTENT, JSON.stringify(intent));
    await new Promise((resolve) => { const to = setTimeout(resolve, 2000); navigator.serviceWorker.addEventListener("message", function f(e) { if (e.data && e.data.t === "coi") { clearTimeout(to); navigator.serviceWorker.removeEventListener("message", f); resolve(); } }); reg.active.postMessage({ t: "coi", on: true }); });
    const u = new URL(location.href); u.searchParams.delete("friends"); u.hash = ""; location.replace(u.href); return true;   // (a ?join=CODE of a scanned QR stays in the URL)
  }
  const hpBlock = (s) => (!isolated() ? "Modalità multiplayer ad alte prestazioni richiesta, non disponibile su questo browser." : s.other.hp === false ? "Il dispositivo dell'amico non supporta la modalità multiplayer ad alte prestazioni." : "");

  // ---- an accepted invite: the room already exists (made by the account API), both tokens say who is who, nothing is typed. The isolation step is the same as for create/join.
  async function startInvite(o) { if (await prepare({ kind: "invite", ...o })) return; beginInvite(o); }
  async function beginInvite(o) {
    const lg = ctx.gameByCloudId(o.gameId), ice = await ctx.ice();
    session = new Session(sessionOpts(o.role, o.role === "host" && lg ? { id: lg.id, code: lg.code, title: lg.title, dlplay: true } : null, ice));
    session.attach(o.code, o.token); show("lobby"); render(session);
  }

  // ---- create
  $("btnCreate").onclick = async () => {
    const games = ctx.games(); const sel = $("friendGame"); sel.innerHTML = "";
    $("createErr").textContent = games.length ? "" : "Aggiungi prima un gioco alla libreria.";
    for (const g of games) { const o = document.createElement("option"); o.value = g.id; o.textContent = g.title || g.id; sel.append(o); }
    $("btnMakeRoom").disabled = !games.length; show("friends-create");
  };
  $("btnCreateBack").onclick = () => show("library");
  $("btnMakeRoom").onclick = () => makeRoom($("friendGame").value);
  async function makeRoom(gameId) {
    const g = ctx.games().find((x) => x.id === gameId); if (!g) return;
    $("btnMakeRoom").disabled = true; $("createErr").textContent = "";
    if (await prepare({ kind: "create", gameId })) return;
    try {
      session = new Session(sessionOpts("host", { id: g.id, code: g.code, title: g.title, dlplay: true }, await ctx.ice()));
      await session.create(); show("lobby"); render(session);
    } catch (e) { session = null; show("friends-create"); $("createErr").textContent = errText(e); }
    $("btnMakeRoom").disabled = false;
  }

  // ---- join
  $("btnJoin").onclick = () => { $("joinErr").textContent = ""; $("joinCode").value = ""; $("scanHint").textContent = ""; show("friends-join"); };
  $("btnJoinBack").onclick = () => { stopScan(); show("library"); };
  $("joinCode").oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); };
  $("btnDoJoin").onclick = () => doJoin($("joinCode").value);
  async function doJoin(code) {
    stopScan(); if (!/^\d{6}$/.test(code)) { $("joinErr").textContent = "Il codice ha 6 cifre."; return; }
    $("joinErr").textContent = ""; $("btnDoJoin").disabled = true;
    if (await prepare({ kind: "join", code })) return;
    try {
      session = new Session(sessionOpts("guest", null, await ctx.ice()));
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
    $("nmHost").textContent = host ? "Tu" : "Il tuo amico"; $("nmGuest").textContent = host ? (both ? "Il tuo amico" : "In attesa") : "Tu";
    for (const id of ["stHost", "stGuest"]) { const e = $(id), was = e.dataset.was; if (was !== e.textContent) { e.dataset.was = e.textContent; if (e.textContent === "Pronto") e.classList.add("ready"); } }
    const q = s.quality, d = s.decision; $("lobbyQuality").className = "quality " + (q ? q.level : ""); $("lobbyQuality").textContent = s.qualityBusy ? "Controllo la connessione…" : q ? "Connessione: " + q.label : "";
    $("lobbyNet").textContent = both && q && q.path && q.path !== "unknown" ? (q.path === "relay" ? "Tramite relay" : "Diretta") + (s.o.relayAvailable === false && q.path !== "relay" ? " · relay non disponibile" : "") : "";
    const ask = host && !!d && d.block && !s.forced && !s.qualityBusy && both;
    $("netWarn").hidden = !ask; if (ask) { $("netWarnText").textContent = d.message; $("btnNetHosted").hidden = !s.hostedAvailable(); }
    $("netBanner").hidden = !(s.peer && s.peer.state === "degraded" && (s.state === "lobby" || s.state === "starting" || s.state === "playing"));
    let note = "";
    if (!both) note = host ? "Fai inserire il codice all'amico." : "Mi collego alla partita…";
    else if (!host && s.hostGame && !s.gameOk && s.dlplay) note = `Non hai «${s.hostGame.title}»: lo scarichi dal DS dell'amico con Download Play (servono BIOS e firmware, nessun gioco).`;
    else if (!host && s.hostGame && !s.gameOk) note = `Per giocare serve «${s.hostGame.title}»: aggiungilo alla tua libreria, oppure importa BIOS e firmware per scaricarlo dal DS dell'amico.`;
    else if (host && s.dlplay && s.hostBlock()) note = s.hostBlock();
    else if (!host && s.dlplay && !isolated()) note = hpBlock(s);
    else if (host && s.dlplay) note = "Il tuo amico scarica il gioco dal tuo DS (Download Play).";
    else if (d && d.block && !host) note = d.message + " Attendi la scelta dell'amico.";
    else if (host && s.netBlock() && s.qualityBusy) note = "Controllo la connessione prima di iniziare…";
    else if (d && d.warn) note = d.message;
    else if (q && q.level === "RED") note = "La connessione non è adatta: avvicinatevi al router Wi-Fi o usate la stessa rete. Puoi provare comunque.";
    else if (s.other.hidden) note = "L'amico ha messo l'app in secondo piano…";
    $("lobbyNote").textContent = note;
    $("btnReady").hidden = host ? true : !both; $("btnReady").disabled = !(s.gameOk || s.dlplay) || (s.dlplay && !isolated()); $("btnReady").textContent = s.me.ready ? "ANNULLA" : "PRONTO";
    $("lobbyRefsWrap").hidden = !(host && s.dlplay && /refs\.json/.test(s.hostBlock()));
    $("btnStart").hidden = !host; $("btnStart").disabled = !s.canStart();
  }
  function drawQr(code) {
    const c = $("codeQr"); c.dataset.code = code;
    if (typeof qrcode !== "function") return;
    const q = qrcode(0, "M"); q.addData(joinUrl(code)); q.make(); const n = q.getModuleCount(), g = c.getContext("2d"), px = Math.floor(c.width / (n + 2));
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.fillStyle = "#000";
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (q.isDark(r, k)) g.fillRect((k + 1) * px, (r + 1) * px, px, px);
  }
  $("lobbyRefs").onchange = async (e) => { const f = e.target.files[0]; e.target.value = ""; if (f && await ctx.importRefsFile(f) && session) render(session); };   // the room stays: refs.json can be imported while it is open
  $("btnReady").onclick = () => { if (session) session.setReady(!session.me.ready); };
  $("btnStart").onclick = () => { if (session) session.start(); };
  $("btnNetRetry").onclick = () => { if (session) session.retryMeasure(); };
  $("btnNetGo").onclick = () => { if (session) session.continueAnyway(); };
  $("btnNetHosted").onclick = () => { if (session && session.useHosted()) leave(); };
  $("btnLobbyLeave").onclick = () => leave();
  const clearNet = () => { $("netWarn").hidden = true; $("netBanner").hidden = true; };      // overlays of the lobby never outlive it
  async function leave() { const s = session; session = null; clearNet(); if (s) await s.close(); show("library"); }
  $("btnLostBack").onclick = () => show("library");

  // ?join=CODE (QR scanned with the camera app): open the join screen and connect
  const jc = new URLSearchParams(location.search).get("join");
  return {
    get session() { return session; },
    leave, doJoin, startInvite,
    /** the game ended or the link dropped while playing: close the room and tell the user */
    async lost(why) { const s = session; session = null; clearNet(); if (s) { s.state === "closed" || (await s.close()); } $("lostNote").textContent = why || ""; show("lost"); },
    async endSession() { const s = session; session = null; clearNet(); if (s) await s.close(); },
    /** after the isolation reload: carry on with what the user was doing (no new questions) */
    resume() {
      const raw = load(INTENT); store(INTENT, null); let it = null; try { it = raw ? JSON.parse(raw) : null; } catch { /* none */ }
      const f = new URLSearchParams(location.search).get("friends");
      if (it && it.kind === "create" && ctx.games().some((x) => x.id === it.gameId)) { $("btnCreate").onclick(); $("friendGame").value = it.gameId; makeRoom(it.gameId); return true; }
      if (it && it.kind === "invite" && /^\d{6}$/.test(it.code || "") && it.token) { beginInvite(it); return true; }
      if (it && it.kind === "join" && /^\d{6}$/.test(it.code || "")) { $("btnJoin").onclick(); $("joinCode").value = it.code; doJoin(it.code); return true; }
      if (f === "create") $("btnCreate").onclick(); else if (f === "join") $("btnJoin").onclick();
      return false;
    },
    /** a QR scanned with the camera app opens .../play/?join=CODE: join that room (after the isolation step, if needed), without asking for the code again */
    autoJoin() { if (jc && /^\d{6}$/.test(jc)) { $("joinCode").value = jc; show("friends-join"); const u = new URL(location.href); u.searchParams.delete("join"); try { history.replaceState(null, "", u.href); } catch { /* ok */ } doJoin(jc); } },
  };
}
