// DSLink PWA player (Foundation 1): the Nintendo DS runs INSIDE this page (WebAssembly), on this device. Library, BIOS/firmware and saves are stored in the browser only.
// No account, no server round trip for emulation: after the page is loaded the player works offline.
import { mountControls } from "../controls/controls.js";
import { openStore, requestPersistence, estimate } from "./storage.js";
import { sha256Hex } from "./sha256.js";
import { Player, detectCaps } from "./player.js";
import { opt, setOpt } from "./options.js";
import { initFriends } from "./friends.js";
import { loadConfig, Cloud, passkeysSupported } from "./cloud.js";
import { initCloudUI } from "./cloudui.js";
import { CloudFiles, errMsg } from "./cloudfiles.js";
import { DlAssist, validateRefs, HOST_REFS } from "./dlassist.js";

const $ = (id) => document.getElementById(id);
let DEV = opt("dev", "") === "1" || (() => { try { return localStorage.getItem("dslink.dev") === "1"; } catch { return false; } })();
const SYS = [
  { key: "bios7", file: "bios7.bin", title: "BIOS ARM7", sizes: [16384] },
  { key: "bios9", file: "bios9.bin", title: "BIOS ARM9", sizes: [4096] },
  { key: "firmware", file: "firmware.bin", title: "Firmware", sizes: [131072, 262144, 524288] },
];
let store = null, caps = null, games = [], sysInfo = {}, player = null, controls = null, current = null, guard = false, saveChain = Promise.resolve(), savesWritten = 0, friends = null, cloud = null, cloudUi = null, cfiles = null, refsText = null, assist = null;

const show = (name) => { document.body.dataset.screen = name; document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.dataset.screen === name)); };
const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.round(n / 1024) + " KB");

// ---------------------------------------------------------------- start up
async function boot() {
  caps = detectCaps();
  const missing = [];
  if (!caps.wasm) missing.push("WebAssembly");
  if (!caps.moduleWorker) missing.push("Web Worker moderni");
  if (!caps.webgl && !document.createElement("canvas").getContext("2d")) missing.push("grafica");
  if (missing.length) { $("unsupported").hidden = false; $("unsupported").textContent = "Questo browser non supporta: " + missing.join(", ") + ". Aggiorna Chrome o Safari."; }
  try {
    const prefer = new URLSearchParams(location.search).get("store") || "auto";
    store = await openStore(prefer);
  } catch (e) { $("libErr").textContent = "Archivio del browser non disponibile: " + (e && e.message || e); }
  if (store) { requestPersistence(); $("storageNote").textContent = "Archivio: " + (store.kind === "opfs" ? "OPFS" : "IndexedDB") + (store.why ? " (" + store.why + ")" : ""); }
  renderDiag(); bindOptions();
  await refresh();
  show("library");
  $("devOverlay").hidden = !DEV; setInterval(() => { if (DEV) devTick(); }, 500);
  if ("serviceWorker" in navigator && self.isSecureContext && !new URLSearchParams(location.search).has("nosw")) navigator.serviceWorker.register("./sw.js", { scope: "./" }).then(watchUpdate).catch(() => {});
  friends = initFriends({ $, show, games: () => games, gameByCloudId: (gid) => localByGameId().get(gid), importRefsFile, hasSystem: () => SYS.every((x) => sysInfo[x.key] && sysInfo[x.key].ok), hasRefs: () => !!refsText && validateRefs(refsText).ok,
    hostDlBlock: () => { if (!SYS.every((x) => sysInfo[x.key] && sysInfo[x.key].ok)) return "Servono BIOS e firmware su questo dispositivo."; if (!refsText) return "Manca refs.json: importalo prima di avviare."; const v = validateRefs(refsText, HOST_REFS); return v.ok ? "" : v.error; }, startGame: (id, session) => playGame(id, session), onLost: (why) => onSessionLost(why) });
  // DSLink Cloud: OPTIONAL (account, friends, invites, library metadata). Where it lives comes from cloud-config.json - no setup. Nothing below blocks or breaks playing locally.
  const cfg = await loadConfig(opt).catch(() => ({ api: "", signal: "", ws: "" }));
  cloud = new Cloud(cfg);
  cloudUi = initCloudUI({ $, show, cloud, passkeys: passkeysSupported, syncLibrary, localByGameId, playLocal: (id) => playGame(id), startInvite: (o) => friends.startInvite(o) });
  cfiles = new CloudFiles({ cloud, store, opt });
  cloud.on((ev) => { if (ev === "login") { cloud.setActivity("menu"); syncLibrary(); cloudStart(); } if (ev === "logout" || ev === "anon" || ev === "offline") { cfiles.refresh().then(renderLibrary); } });
  cfiles.on((ev) => { if (ev === "conflict" && !current && document.body.dataset.screen === "library") { const c = [...cfiles.conflicts.values()][0]; if (c) askConflict(c); } if (ev !== "sync") renderLibrary(); updateUsage(); });
  bindCloudUi();
  addEventListener("online", () => { if (cfiles.ready) syncEverything(false); });
  setInterval(() => { if (current && cfiles.ready && savesWritten !== lastPushed) pushCurrent(); }, 120000);
  cloud.restore().catch(() => {});
  addEventListener("pagehide", (e) => { const s = friends && friends.session; if (s && !e.persisted && s.peer) s.peer.sendCtl({ t: "bye" }); });
  window.dslinkPlay = api();
  if (!friends.resume()) friends.autoJoin();
  document.addEventListener("visibilitychange", () => { if (cloud && cloud.state === "user" && !document.hidden) { cloud.sendState(); cloud.refreshAll().catch(() => {}); } });
}

function bindOptions() {
  const sel = (id, name, def) => { const e = $(id); e.value = opt(name, def); e.onchange = () => setOpt(name, e.value); };
  sel("optRadioRing", "radioring", "auto"); sel("optRender", "render", "auto"); sel("optAudio", "audio", "auto"); sel("optLatency", "latency", "");
  $("optDev").checked = DEV; $("optDev").onchange = () => { DEV = $("optDev").checked; setOpt("dev", DEV ? "1" : ""); $("devOverlay").hidden = !DEV; };
}
function renderDiag() {
  const yn = (v) => (v ? "sì" : "NO");
  const lines = [`WebAssembly: ${yn(caps.wasm)}`, `Web Worker (module): ${yn(caps.moduleWorker)}`, `WebGL2: ${yn(caps.webgl2)}  WebGL: ${yn(caps.webgl)}`, `AudioWorklet: ${yn(caps.audioWorklet)}  AudioContext: ${yn(caps.audioContext)}`,
    `Archivio: ${store ? (store.kind === "opfs" ? "OPFS" : "IndexedDB" + (caps.opfs ? " (OPFS presente ma non scrivibile qui)" : " (OPFS assente)")) : "nessuno"}`, `IndexedDB: ${yn(caps.indexedDB)}`,
    `Contesto sicuro (https): ${yn(caps.secure)}`, `App installata (standalone): ${yn(caps.standalone)}`, `Touch: ${yn(caps.touch)}`, `Service worker: ${yn(caps.serviceWorker)}`,
    `Thread WASM possibili (SharedArrayBuffer + isolamento): ${yn(caps.sab && caps.crossOriginIsolated)} (non necessari)`];
  $("diagText").textContent = lines.join("\n");
}
// The cloud identifies a game by platform + product code (stable across devices and regions of the same dump); the file itself is only ever local.
const gameIdOf = (g) => (g && g.code ? "nds-" + String(g.code).toLowerCase().replace(/[^a-z0-9]/g, "") : "");
function localByGameId() { const m = new Map(); for (const g of games) { const id = gameIdOf(g); if (id.length >= 5 && !m.has(id)) m.set(id, g); } return m; }
let syncT = 0;
function syncLibrary() {                       // push this device's library METADATA (never files) after login and whenever the local library changes
  clearTimeout(syncT); syncT = setTimeout(() => {
    if (!cloud || cloud.state !== "user") return;
    const entries = games.filter((g) => gameIdOf(g).length >= 5).map((g) => ({ gameId: gameIdOf(g), platform: "nds", title: g.title || g.code, productCode: g.code, coreId: "melonds-ds", multiplayerMode: "distributed", downloadPlaySupported: false }));
    cloud.syncLibrary(entries).catch(() => {});
  }, 400);
}
async function refresh() {
  games = [];
  if (store) {
    for (const p of await store.list("library/")) {
      if (!p.endsWith("/meta.json")) continue;
      try { games.push(JSON.parse(new TextDecoder().decode(await store.get(p)))); } catch { /* damaged entry: ignore */ }
    }
    for (const s of SYS) { const b = await store.get("system/" + s.file); sysInfo[s.key] = b ? { size: b.byteLength, ok: s.sizes.includes(b.byteLength) } : null; }
    const rb = await store.get("system/refs.json"); refsText = rb ? new TextDecoder().decode(rb) : null;      // screen references: this device only, never sent, never logged
  }
  games.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  renderLibrary(); syncLibrary();
}

function renderLibrary() {
  const ul = $("gameList"); ul.innerHTML = "";
  if (!games.length && !(cfiles && cfiles.ready && cfiles.games.size)) { const li = document.createElement("li"); li.textContent = "Nessun gioco. Aggiungine uno."; ul.append(li); }
  const cl = cfiles && cfiles.ready;
  for (const g of games) {
    const gid = gameIdOf(g), inCloud = cl && gid && cfiles.inCloud(gid);
    const li = document.createElement("li"); li.className = "game"; li.dataset.id = g.id; if (cl) li.dataset.state = inCloud ? "both" : "local";
    const t = document.createElement("span"); t.className = "t"; t.textContent = g.title || g.id; const sm = document.createElement("small"); sm.textContent = (g.code || "") + " · " + fmtSize(g.size); t.append(sm);
    if (cl) { const tag = document.createElement("span"); tag.className = "tag " + (inCloud ? "both" : ""); tag.textContent = inCloud ? "LOCALE + CLOUD" : "SOLO LOCALE"; t.append(tag); }
    if (cl && cfiles.conflicts.has(g.id)) { const w = document.createElement("span"); w.className = "tag warn"; w.textContent = "⚠ DUE SALVATAGGI"; t.append(w); }
    const play = document.createElement("button"); play.className = "cta primary play"; play.textContent = "GIOCA"; play.onclick = () => playGame(g.id);
    const del = document.createElement("button"); del.className = "del"; del.setAttribute("aria-label", "Rimuovi dal dispositivo"); del.textContent = "✕"; del.onclick = () => removeGame(g);
    li.append(t, play, del);
    if (cl) {
      const acts = document.createElement("div"); acts.className = "acts";
      const mk = (txt, fn, cls = "mini") => { const b = document.createElement("button"); b.className = cls; b.textContent = txt; b.onclick = fn; acts.append(b); return b; };
      if (!inCloud) mk("SALVA NEL MIO CLOUD", () => uploadGameUi(g));
      else { mk("RIMUOVI DAL DISPOSITIVO", () => removeGame(g)); mk("RIMUOVI DAL CLOUD", () => removeFromCloud(gid, g.title), "mini danger"); }
      if (inCloud || cfiles.heads.has(gid)) mk("SALVATAGGI", () => openHistory(g, gid));
      if (cfiles.conflicts.has(g.id)) mk("RISOLVI", () => askConflict(cfiles.conflicts.get(g.id)), "mini primary");
      li.append(acts);
    }
    ul.append(li);
  }
  if (cl) {                                    // games that are in the account's Cloud but not on this device: CLOUD ONLY
    const local = localByGameId();
    for (const [gid, f] of cfiles.games) {
      if (local.has(gid)) continue;
      const li = document.createElement("li"); li.className = "game cloudonly"; li.dataset.gameid = gid; li.dataset.state = "cloud";
      const e = cloud.library.find((x) => x.gameId === gid);
      const t = document.createElement("span"); t.className = "t"; t.textContent = (e && e.title) || f.title || gid; const sm = document.createElement("small"); sm.textContent = gid.slice(4).toUpperCase() + " · " + fmtSize(f.size); t.append(sm);
      const tag = document.createElement("span"); tag.className = "tag cloud"; tag.textContent = "SOLO CLOUD"; t.append(tag);
      const play = document.createElement("button"); play.className = "cta primary play"; play.textContent = "GIOCA"; play.onclick = () => playCloudOnly(gid);
      const acts = document.createElement("div"); acts.className = "acts";
      const dl = document.createElement("button"); dl.className = "mini"; dl.textContent = "SCARICA"; dl.onclick = () => downloadInstall(gid);
      const rm = document.createElement("button"); rm.className = "mini danger"; rm.textContent = "RIMUOVI DAL CLOUD"; rm.onclick = () => removeFromCloud(gid, (e && e.title) || f.title);
      acts.append(dl, rm); li.append(t, play, acts); ul.append(li);
    }
  }
  const sl = $("sysList"); sl.innerHTML = "";
  for (const s of SYS) {
    const li = document.createElement("li"); li.dataset.key = s.key;
    const t = document.createElement("span"); t.className = "t"; t.textContent = `${s.title} (${s.file})`;
    const st = document.createElement("small"); const info = sysInfo[s.key];
    if (!info) { st.textContent = "Non presente"; } else if (info.ok) { st.textContent = "✓ importato · " + fmtSize(info.size); st.className = "ok"; } else { st.textContent = "Dimensione non valida (" + fmtSize(info.size) + ")"; st.className = "bad"; }
    t.append(st);
    const lab = document.createElement("label"); lab.className = "pick"; lab.textContent = "SCEGLI"; const inp = document.createElement("input"); inp.type = "file"; inp.hidden = true; inp.dataset.sys = s.key;
    inp.onchange = () => importSystem(s, inp); lab.append(inp);
    li.append(t, lab);
    if (cl) {
      const inC = cfiles.system.has(s.file), here = info && info.ok, acts = document.createElement("div"); acts.className = "acts"; li.dataset.cloud = inC ? "1" : "0";
      const mk = (txt, fn, cls = "mini") => { const b = document.createElement("button"); b.className = cls; b.textContent = txt; b.onclick = fn; acts.append(b); };
      if (here && !inC) mk("SALVA NEL MIO CLOUD", () => uploadSystemUi(s));
      if (!here && inC) mk("RECUPERA DAL CLOUD", () => recoverSystemUi(s));
      if (inC) { const c = document.createElement("small"); c.className = "ok"; c.textContent = "☁ nel tuo Cloud"; acts.append(c); mk("RIMUOVI DAL CLOUD", () => removeSystemFromCloud(s), "mini danger"); }
      li.append(acts);
    }
    sl.append(li);
  }
  const rl = document.createElement("li"); rl.dataset.key = "refs";
  const rt = document.createElement("span"); rt.className = "t"; rt.textContent = "Riferimenti schermate (refs.json), solo per ospitare"; const rs = document.createElement("small");
  const rv = refsText ? validateRefs(refsText) : null;
  if (!refsText) rs.textContent = "Non presente"; else if (rv.ok) { rs.textContent = "✓ importato · " + rv.names.length + " schermate"; rs.className = "ok"; } else { rs.textContent = rv.error; rs.className = "bad"; }
  rt.append(rs);
  const rlab = document.createElement("label"); rlab.className = "pick"; rlab.textContent = "SCEGLI"; const rin = document.createElement("input"); rin.type = "file"; rin.hidden = true; rin.dataset.sys = "refs";
  rin.onchange = () => importRefs(rin); rlab.append(rin); rl.append(rt, rlab); sl.append(rl);
}

// ---------------------------------------------------------------- import (all local)
async function romId(buf) {
  // Stable per game: size + first and last 4 MB (fast even for big cartridges and the same with or without WebCrypto)
  const u = new Uint8Array(buf), N = 4 << 20, head = u.subarray(0, Math.min(N, u.length)), tail = u.subarray(Math.max(0, u.length - N));
  const sz = new Uint8Array(8); new DataView(sz.buffer).setUint32(0, u.length);
  const all = new Uint8Array(head.length + tail.length + 8); all.set(sz, 0); all.set(head, 8); all.set(tail, 8 + head.length);
  return (await sha256Hex(all.buffer)).slice(0, 24);
}
function romInfo(buf) {
  const u = new Uint8Array(buf);
  if (u.length < 0x200) return null;
  const ascii = (a, b) => String.fromCharCode(...u.subarray(a, b)).replace(/\0.*$/, "").trim();
  const code = ascii(12, 16);
  if (!/^[A-Z0-9]{4}$/.test(code)) return null;
  return { title: ascii(0, 12) || code, code };
}
$("romFile").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ""; if (!f || !store) return;
  $("libErr").textContent = "Aggiungo il gioco…";
  try {
    const buf = await f.arrayBuffer(); const info = romInfo(buf);
    if (!info) { $("libErr").textContent = "Questo non sembra un file .nds valido."; return; }
    const id = await romId(buf);
    await store.put(`library/${id}/rom.nds`, buf);
    const nameTitle = (f.name || "").replace(/\.(nds|srl)$/i, "");
    await store.put(`library/${id}/meta.json`, new TextEncoder().encode(JSON.stringify({ id, title: nameTitle || info.title, code: info.code, size: buf.byteLength, added: Date.now() })).buffer);
    $("libErr").textContent = ""; await refresh();
    if (autoCloud() && cfiles && cfiles.ready) { const lg = games.find((x) => x.id === id); if (lg) await uploadGameUi(lg); }
  } catch (err) { $("libErr").textContent = "Non riesco a salvare il gioco: " + (err && err.message || err); }
};
async function importSystem(s, inp) {
  const f = inp.files[0]; inp.value = ""; if (!f || !store) return;
  const buf = await f.arrayBuffer();
  if (!s.sizes.includes(buf.byteLength)) { sysInfo[s.key] = { size: buf.byteLength, ok: false }; renderLibrary(); return; }   // wrong file: not stored
  await store.put("system/" + s.file, buf); await refresh();
  if (autoCloud() && cfiles && cfiles.ready) await uploadSystemUi(s);
}
async function importRefs(inp) { const f = inp.files[0]; inp.value = ""; if (f) await importRefsFile(f); }
async function importRefsFile(f) {
  if (!store) return false;
  const text = await f.text(), v = validateRefs(text);
  if (!v.ok) { const keep = refsText; refsText = text; renderLibrary(); refsText = keep; $("libErr").textContent = v.error; return false; }   // wrong file: shown, not stored; its content is never logged
  $("libErr").textContent = ""; await store.put("system/refs.json", new TextEncoder().encode(text).buffer); await refresh(); return true;
}
async function removeGame(g) {
  const gid = gameIdOf(g), inC = cfiles && cfiles.ready && gid && cfiles.inCloud(gid);
  if (!store || !confirm(inC ? `Rimuovere "${g.title}" da questo dispositivo? Resta nel tuo Cloud: potrai scaricarlo di nuovo.` : `Rimuovere "${g.title}" e il suo salvataggio da questo dispositivo?`)) return;
  if (cfiles && cfiles.ready && gid && !inC && cfiles.heads.has(gid)) await cfiles.syncSave(g.id, gid).catch(() => {});      // the Cloud keeps this game's save: make sure it has the latest before the local copy goes
  for (const n of ["rom.nds", "meta.json", "save", "save.meta.json", "sync.json", "save.bak", "save.conflict"]) await store.del(`library/${g.id}/${n}`);
  await refresh();
}

// ---------------------------------------------------------------- play
const KEYS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", z: "b", x: "a", a: "y", s: "x", q: "l", w: "r", Enter: "start", Shift: "select" };
const onKey = (d) => (e) => { const k = KEYS[e.key]; if (k && player) { player.btn(k, d); e.preventDefault(); } };
const kd = onKey(true), ku = onKey(false);

async function playGame(id, session) {
  if (current || !store) return;
  const dlGuest = id === null;                           // Download Play guest: NO cartridge, the console boots its own firmware menu
  const g = dlGuest ? { id: "dl-guest", title: "Download Play" } : games.find((x) => x.id === id); if (!g) return;
  id = g.id; current = id;
  player = new Player({
    canvas: document.createElement("canvas"),
    onSram: (gid, data) => { saveChain = saveChain.then(() => store.put(`library/${gid}/save`, data)).then(() => { savesWritten++; if (cfiles) cfiles.markLocalSave(gid); }).catch(() => { $("libErr").textContent = "Salvataggio non riuscito"; }); },
    onError: (msg) => fail(msg),
    onShutdown: () => { window.__lastShutdown = player && player.shutdownInfo; leave(true); },
    onNeedGesture: () => { $("resumeHint").hidden = false; },       // the browser wants a tap before the audio (and the game) may continue
    onResumed: () => { $("resumeHint").hidden = true; },
  });
  player.prepare();                       // the tap's gesture creates the AudioContext
  $("loadingNote").textContent = "Carico " + (g.title || "il gioco") + "…"; show("loading");
  try {
    const rom = dlGuest ? null : await store.get(`library/${id}/rom.nds`); if (!dlGuest && !rom) throw new Error("Gioco non trovato nell'archivio");
    const system = {}; for (const s of SYS) { const b = await store.get("system/" + s.file); if (b && s.sizes.includes(b.byteLength)) system[s.file] = b; }
    if (!dlGuest && cfiles && cfiles.ready) {                           // latest save from the account's other devices (short, best effort: offline or slow never blocks the game)
      const gidc = gameIdOf(g);
      if (gidc && (cfiles.inCloud(gidc) || cfiles.heads.has(gidc))) {
        const r = await Promise.race([cfiles.syncSave(id, gidc), new Promise((res) => setTimeout(() => res({ action: "timeout" }), 3500))]).catch(() => ({}));
        if (r && r.action === "conflict") await askConflict(r.conflict);
      }
    }
    const sram = dlGuest ? null : await store.get(`library/${id}/save`);
    buildGame();
    await player.start({ id, rom, system, sram, radio: session ? { role: session.role === "host" ? 1 : 2, peer: session.peer } : undefined });
    if (session) session.playing();
    if (cloud) { cloud.setActivity("game", gameIdOf(g)); if (!dlGuest) cloud.markPlayed(gameIdOf(g)).catch(() => {}); }
    if (session && session.dlplay) startAssist(session);
    show("game"); $("game").hidden = false; $("app").style.display = "none";
    if (!guard) { history.pushState({ game: true }, ""); guard = true; }
    addEventListener("keydown", kd); addEventListener("keyup", ku);
    if (player.audioBlocked()) $("resumeHint").hidden = false;
  } catch (e) { fail(e && e.message || String(e)); }
}

// Download Play assistant: the host's game menus / the guest's DS menu are driven automatically (see dlassist.js)
function startAssist(session) {
  stopAssist(); let refs = {}; try { refs = refsText ? JSON.parse(refsText.replace(/^\uFEFF/, "")) : {}; } catch { /* host check already refused */ }
  const role = session.role === "host" ? "host" : "guest";
  assist = new DlAssist({ role, player, refs, scale: +opt("dlscale", 1) || 1, onStep: (st) => { $("assistStep").textContent = st; $("assistStep").hidden = !st; } });
  assist.run().then((r) => { if (r.ok) $("assistStep").hidden = true; else if (!assist || !assist.stopped) { $("assistStep").hidden = false; $("assistStep").textContent = "Assistente: " + r.failed; } });
}
function stopAssist() { if (assist) { assist.stop(); assist = null; } $("assistStep").hidden = true; }

function buildGame() {
  const root = $("game"); root.innerHTML = ""; root.hidden = false;
  const canvas = player.canvas; let down = false;
  const sink = { btn: (k, d) => player.btn(k, !!d), stylus: (x, y, d, m) => { if (!m) down = !!d; player.touch(x, y, m ? down : !!d); }, ui() {} };
  controls = mountControls({ container: root, video: canvas, platform: "nds", persist: true, onLeave: () => askLeave(), sink });
}
function askLeave() { $("confirm").hidden = false; }
$("confirmNo").onclick = () => { $("confirm").hidden = true; };
$("confirmYes").onclick = async () => { $("confirm").hidden = true; await leave(false); };
async function leave(fromCore) {
  if (!current) return;
  stopAssist();
  if (friends) await friends.endSession();                 // the other player is told (bye) before this side shuts down
  removeEventListener("keydown", kd); removeEventListener("keyup", ku);
  if (!fromCore && player) { await player.save(true); }
  const p = player; player = null; if (p) await p.stop();
  await saveChain;                                         // the last save is on disk before the library shows again
  const leftId = current;
  if (controls) { controls.destroy(); controls = null; }
  $("game").hidden = true; $("game").innerHTML = ""; $("app").style.display = ""; $("resumeHint").hidden = true;
  current = null; show("library"); if (cloud) cloud.setActivity("menu");
  afterGame(leftId);
  showUpdateBar();
}
function fail(msg) {
  stopAssist();
  if (friends) friends.endSession().catch(() => {});
  const p = player; player = null; if (p) p.stop().catch(() => {});
  if (controls) { controls.destroy(); controls = null; }
  $("game").hidden = true; $("game").innerHTML = ""; $("app").style.display = ""; current = null;
  $("errorNote").textContent = msg; show("error"); if (cloud) cloud.setActivity("menu");
}
$("btnErrBack").onclick = () => show("library");
$("btnResume").onclick = async () => { if (player) { await player.unlockAudio(); await player.resume(); } $("resumeHint").hidden = true; };
addEventListener("popstate", () => { if (current) { history.pushState({ game: true }, ""); askLeave(); } else guard = false; });

async function onSessionLost(why) {
  if (current) await leave(false);          // no zombie worker/core: the local game is closed (its save is kept) and the user is told why
  if (friends) await friends.lost(why);
}

// ---------------------------------------------------------------- DSLink Cloud storage: ROMs, BIOS/firmware and saves of THIS account, synchronised with the local store
// The emulator only uses local files. Everything below moves copies between the device and the account's private Cloud space, with progress, hash checks and no loss of local data on any error.
let lastPushed = 0;
const autoCloud = () => { try { return localStorage.getItem("dslink.autocloud") === "1"; } catch { return false; } };
const toast = (m) => { if (cloudUi) cloudUi.toast(m); };
const pctText = (p) => ({ hash: "Preparo il file…", upload: "Caricamento…", verify: "Verifico l'integrità…", download: "Scaricamento…", done: "Completato" }[p.phase] || "") + (p.phase === "upload" || p.phase === "download" ? " " + p.pct + "%" : "");
async function withXfer(title, name, fn) {
  $("xferTitle").textContent = title; $("xferName").textContent = name || ""; $("xferBar").value = 0; $("xferPct").textContent = ""; $("xferErr").textContent = ""; $("btnXferClose").hidden = true; $("xfer").hidden = false;
  const r = await fn((p) => { $("xferBar").value = p.pct; $("xferPct").textContent = pctText(p) + (p.total ? " · " + fmtSize(p.loaded) + " / " + fmtSize(p.total) : ""); }).catch((e) => ({ ok: false, error: e && e.name === "QuotaExceededError" ? "local_quota" : "network" }));
  if (r.ok) { $("xferBar").value = 100; $("xferPct").textContent = "Completato"; $("xferTitle").dataset.done = "1"; setTimeout(() => { $("xfer").hidden = true; delete $("xferTitle").dataset.done; }, 700); }
  else { $("xferErr").textContent = errMsg(r); $("btnXferClose").hidden = false; }
  return r;
}
$("btnXferClose").onclick = () => { $("xfer").hidden = true; };

async function uploadGameUi(g) {
  const gid = gameIdOf(g); if (!gid || !cfiles.ready) return { ok: false };
  const buf = await store.get(`library/${g.id}/rom.nds`); if (!buf) return { ok: false };
  const r = await withXfer("Caricamento nel tuo Cloud", g.title, (cb) => cfiles.upload("game", gid, buf, { title: g.title, onProgress: cb }));
  if (r.ok) { syncLibrary(); await cloud.loadLibrary(); cfiles.syncSave(g.id, gid).catch(() => {}); } renderLibrary(); updateUsage(); return r;
}
async function uploadSystemUi(s) {
  const buf = await store.get("system/" + s.file); if (!buf || !s.sizes.includes(buf.byteLength)) return { ok: false };
  const r = await withXfer("Salvo nel tuo Cloud", s.title, (cb) => cfiles.upload("system", s.file, buf, { onProgress: cb })); renderLibrary(); updateUsage(); return r;
}
async function recoverSystemUi(s) {
  const r = await withXfer("Recupero dal tuo Cloud", s.title, (cb) => cfiles.download("system", s.file, { onProgress: cb }));
  if (r.ok) { try { await store.put("system/" + s.file, r.buf); } catch { toast(errMsg("local_quota")); } await refresh(); }
  return r;
}
async function removeFromCloud(gid, title) {
  if (!confirm(`Rimuovere "${title || gid}" dal tuo Cloud? Il file nel Cloud viene eliminato (le copie sui dispositivi restano). I salvataggi nel Cloud restano.`)) return;
  const r = await cfiles.removeGame(gid); toast(r.ok ? "Rimosso dal Cloud" : errMsg(r)); renderLibrary(); updateUsage();
}
async function removeSystemFromCloud(s) {
  if (!confirm(`Rimuovere ${s.file} dal tuo Cloud? La copia su questo dispositivo resta.`)) return;
  const r = await cfiles.removeSystem(s.file); toast(r.ok ? "Rimosso dal Cloud" : errMsg(r)); renderLibrary(); updateUsage();
}
/** Cloud -> this device: download, verify, store locally, then the game is an ordinary local game. Resolves the local id or null. */
async function downloadInstall(gid) {
  if (!cfiles.ready || !store) return null;
  const f = cfiles.games.get(gid); if (!f) return null;
  const e = cloud.library.find((x) => x.gameId === gid), title = (e && e.title) || f.title || gid;
  const r = await withXfer("Scarico dal tuo Cloud", title, (cb) => cfiles.download("game", gid, { onProgress: cb }));
  if (!r.ok) return null;
  const info = romInfo(r.buf);
  if (!info || gameIdOf({ code: info.code }) !== gid) { $("xferErr").textContent = errMsg("invalid_file"); $("btnXferClose").hidden = false; $("xfer").hidden = false; return null; }
  const id = await romId(r.buf);
  try {
    await store.put(`library/${id}/rom.nds`, r.buf);
    await store.put(`library/${id}/meta.json`, new TextEncoder().encode(JSON.stringify({ id, title, code: info.code, size: r.buf.byteLength, added: Date.now() })).buffer);
  } catch (err) {                                           // browser storage full: remove the partial copy, report, the Cloud copy is untouched
    for (const n of ["rom.nds", "meta.json"]) await store.del(`library/${id}/${n}`).catch(() => {});
    $("xferErr").textContent = errMsg("local_quota"); $("btnXferClose").hidden = false; $("xfer").hidden = false; return null;
  }
  await refresh();
  await cfiles.syncSave(id, gid).catch(() => {});           // the latest save of the account arrives together with the game
  renderLibrary(); updateUsage(); return id;
}
async function playCloudOnly(gid) { const id = await downloadInstall(gid); if (id) await playGame(id); }

async function cloudStart() {                                // after login / session restore
  if (!cfiles) return;
  await cfiles.refresh();
  const got = await cfiles.pullSystem(SYS);                  // BIOS / firmware from the account's Cloud, if this device lacks them
  if (got.length) await refresh();
  renderLibrary(); updateUsage();
  await syncEverything(false);
}
let syncing = false;
async function syncEverything(manual) {
  if (!cfiles || !cfiles.ready || syncing) return; syncing = true; $("syncNote").textContent = "Sincronizzo…";
  try {
    const out = await cfiles.syncAll(games, gameIdOf);
    const got = await cfiles.pullSystem(SYS); if (got.length) await refresh();
    const bad = out.find((x) => x.action === "offline" || x.action === "error");
    $("syncNote").textContent = bad ? "Sincronizzazione non riuscita: riprovo appena possibile." : "Sincronizzato " + new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    const c = [...cfiles.conflicts.values()][0]; if (c && !current) askConflict(c);
    if (manual && !bad && !c) toast("Tutto sincronizzato");
  } finally { syncing = false; renderLibrary(); updateUsage(); }
}
function afterGame(localId) {                                // leaving a game: the save is on disk, now the Cloud copy
  const g = games.find((x) => x.id === localId); if (!g || !cfiles || !cfiles.ready) return;
  const gid = gameIdOf(g); if (!gid || !(cfiles.inCloud(gid) || cfiles.heads.has(gid))) return;
  cfiles.syncSave(localId, gid).then((r) => { if (r.action === "conflict") askConflict(r.conflict); renderLibrary(); updateUsage(); }).catch(() => {});
}
function pushCurrent() {                                     // periodic, while playing: uploads the save the emulator already wrote locally (never touches the emulator)
  const g = games.find((x) => x.id === current); if (!g) return; const gid = gameIdOf(g); if (!gid || !(cfiles.inCloud(gid) || cfiles.heads.has(gid))) return;
  lastPushed = savesWritten; cfiles.syncSave(current, gid).catch(() => {});
}

// two different saves: the user chooses; until then nothing is overwritten
function askConflict(c) {
  if (!c) return Promise.resolve("none");
  return new Promise((resolve) => {
    const fmt = (t) => (t ? new Date(t).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "data sconosciuta");
    const g = games.find((x) => x.id === c.localId);
    $("cfTitle").textContent = g ? g.title : c.gameId;
    $("cfLocalDev").textContent = c.local.deviceName + " (questo dispositivo)"; $("cfLocalTime").textContent = fmt(c.local.time);
    $("cfCloudDev").textContent = c.head.deviceName || "Altro dispositivo"; $("cfCloudTime").textContent = fmt(c.head.updatedAt);
    const close = (v) => { $("conflictBox").hidden = true; resolve(v); };
    const choose = async (which) => { $("conflictBox").hidden = true; const r = await cfiles.resolve(c.localId, c.gameId, which); toast(r.action === "pulled" || r.action === "pushed" ? "Salvataggio scelto" : errMsg(r)); renderLibrary(); resolve(which); };
    $("btnCfLocal").onclick = () => choose("local"); $("btnCfCloud").onclick = () => choose("cloud"); $("btnCfLater").onclick = () => close("later");
    $("conflictBox").hidden = false;
  });
}
async function openHistory(g, gid) {
  $("histTitle").textContent = g.title; const ul = $("histList"); ul.innerHTML = ""; $("histBox").hidden = false;
  const hist = await cfiles.history(gid);
  if (!hist.length) { const li = document.createElement("li"); li.textContent = "Nessun salvataggio nel Cloud ancora."; ul.append(li); }
  hist.forEach((h, i) => {
    const li = document.createElement("li"); li.dataset.rev = h.revision;
    const t = document.createElement("span"); t.className = "t"; t.textContent = `v${h.revision}${i === 0 ? " (attuale)" : ""} · ${h.deviceName || "dispositivo"}`;
    const sm = document.createElement("small"); sm.textContent = new Date(h.updatedAt).toLocaleString("it-IT", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + " · " + fmtSize(h.size) + (h.note ? " · ripristino" : ""); t.append(sm); li.append(t);
    if (i > 0) { const b = document.createElement("button"); b.className = "mini"; b.textContent = "RIPRISTINA"; b.onclick = async () => { const r = await cfiles.restore(g.id, gid, h.revision); toast(r.action === "pulled" ? "Versione ripristinata" : errMsg(r)); openHistory(g, gid); }; li.append(b); }
    ul.append(li);
  });
  const sync = document.createElement("li"); const sb = document.createElement("button"); sb.className = "mini primary"; sb.textContent = "SINCRONIZZA ORA"; sb.onclick = async () => { const r = await cfiles.syncSave(g.id, gid); if (r.action === "conflict") { $("histBox").hidden = true; askConflict(r.conflict); } else { toast(r.action === "offline" ? errMsg("network") : "Sincronizzato"); openHistory(g, gid); } renderLibrary(); };
  sync.append(sb); ul.append(sync);
}
$("btnHistClose").onclick = () => { $("histBox").hidden = true; };

async function updateUsage() {
  const bar = $("cloudBar"); if (!bar) return; bar.hidden = !(cfiles && cfiles.ready); if (bar.hidden) return;
  let local = games.reduce((n, g) => n + (g.size || 0), 0) + Object.values(sysInfo).reduce((n, x) => n + (x ? x.size : 0), 0);
  const est = await estimate(); if (est && est.usage) local = est.usage;
  $("usageBox").textContent = `Spazio locale utilizzato: ${fmtSize(local)} · Spazio Cloud utilizzato: ${fmtSize(cfiles.usage.usedBytes || 0)} di ${fmtSize(cfiles.usage.quotaBytes || 0)}`;
}
function bindCloudUi() {
  $("optAutoCloud").checked = autoCloud(); $("optAutoCloud").onchange = () => { try { localStorage.setItem("dslink.autocloud", $("optAutoCloud").checked ? "1" : "0"); } catch { /* none */ } };
  $("btnSyncNow").onclick = () => syncEverything(true);
  $("devName").value = cfiles.deviceName(); $("devName").onchange = () => { cfiles.setDeviceName($("devName").value.trim() || cfiles.deviceName()); };
}

// ---------------------------------------------------------------- app updates: a new version never replaces the code under a running game
let waitingSW = null, userUpdate = false;
function watchUpdate(reg) {
  if (!reg) return;
  const check = () => { if (reg.waiting && navigator.serviceWorker.controller) { waitingSW = reg.waiting; showUpdateBar(); } };
  reg.addEventListener("updatefound", () => { const w = reg.installing; if (w) w.addEventListener("statechange", () => { if (w.state === "installed") check(); }); });
  check();
  const poll = () => reg.update().catch(() => {});
  setInterval(poll, 30 * 60_000); document.addEventListener("visibilitychange", () => { if (!document.hidden) poll(); });
  navigator.serviceWorker.addEventListener("controllerchange", () => { if (userUpdate) location.reload(); });
  $("btnUpdate").onclick = () => { userUpdate = true; if (waitingSW) waitingSW.postMessage({ t: "skip" }); };
}
function showUpdateBar() { $("updateBar").hidden = !(waitingSW && !current); }     // only from the menus: never while a game runs

// ---------------------------------------------------------------- development overlay (this device only, never sent anywhere)
function devTick() {
  if (!player) { $("devOverlay").textContent = `DSLink dev · ${store ? store.kind : "-"} · ${Object.entries(caps || {}).filter(([, v]) => v === true).map(([k]) => k).join(" ")}`; return; }
  const s = player.stats, a = s.audio, f = (n, d = 1) => (n || 0).toFixed(d);
  $("devOverlay").textContent = [
    `EMU    ${f(s.emuFps)} fps  frame ${f(s.frameMsAvg, 2)}/${f(s.frameMsMax)} ms  late ${f(s.tickLateAvgMs, 2)}/${f(s.tickLateMaxMs)} ms`,
    `VIDEO  submit ${s.submitted}  recv ${s.received}  drawn ${s.rendered}  drop(src ${s.droppedAtSource} / render ${s.droppedRender})  q ${s.queued}`,
    `RENDER ${f(s.renderFps)} fps (${s.video})  upload ${f(s.uploadMsAvg, 2)}/${f(s.uploadMsMax)} ms  draw ${f(s.drawMsAvg, 2)}/${f(s.drawMsMax)} ms  main ${f(s.mainFrameMsAvg, 2)}/${f(s.mainFrameMsMax)} ms`,
    `AUDIO  ${a.backend}  buf ${f(a.fillMs, 0)}/${f(a.targetMs, 0)} ms  queue ${a.queueFrames || 0} fr  rate ${Math.round(a.srcRate || 0)}>${Math.round(a.ctxRate || 0)} Hz  lat ${f(a.baseLatencyMs, 0)}+${f(a.outputLatencyMs, 0)} ms`,
    `       underruns ${a.underEvents || 0} ev / ${a.underSamples || 0} smp  last10s ${a.under10s || 0}  overrun ${a.overruns || 0}  health ${a.state || "-"}/${a.ctxState}  late ${a.lateQuanta || 0}  gap ${f(a.msgGapMaxMs, 0)} ms`,
    ...radioLines(s),
    `WASM   ${f(s.wasmMB, 0)} MB   main stalls ${s.stalls} (long ${s.longTasks})   ${s.lifecycle.paused ? "PAUSED " + s.lifecycle.reason : "running"}   store ${store.kind}`].join("\n");
}

function radioLines(s) {
  const r = s.radio; if (!r) return [];
  const p = r.peer, f = (n, d = 1) => (n || 0).toFixed(d), c = r.core || {};
  const dl = s.dl, dc = dl && dl.dl_counters;
  const dlLine = dl ? [`DL     ${dl.dl_state}  data tx/rx ${dc.data_tx}/${dc.data_rx}  bytes ${dc.data_bytes_tx}/${dc.data_bytes_rx}  cmd/reply ${dc.cmd}/${dc.reply}  beacons ${dc.nin_beacons_tx}/${dc.nin_beacons_rx}`] : [];
  return [...dlLine, `RADIO  ${p.role} ${p.state} ${r.mode}  ordered ${p.radio ? p.radio.ordered : "-"} retx ${p.radio ? p.radio.maxRetransmits : "-"}  core in/out ${c.in || 0}/${c.out || 0}  active ${c.active || 0}`,
    `       RTT ${f(p.rtt.last)}/${f(p.rtt.avg)}/${f(p.rtt.max)} ms (~1way ${f(p.rtt.avg / 2)})  jitter ${f(p.jitter)} ms  sent ${p.sent} recv ${p.recv} lost ${p.lost} ooo ${p.reordered} late ${p.lateDropped}`,
    `       drop soft/hard/closed ${p.droppedSoft}/${p.droppedHard}/${p.droppedClosed}  q ${p.queueDepth}/${p.queueMax}  buffered ${p.bufferedAmount}/${p.bufferedMax}  holdMax ${f(p.rxHoldMsMax)} ms  lag ${f(c.lagAvg)}/${f(c.lagMax)} ms  ring drop ${r.ringDropped} fill ${r.ringFill} B  tx->page ${f(r.txLagAvg, 2)}/${f(r.txLagMax)} ms`];
}

// ---------------------------------------------------------------- test/diagnostic surface (read-only state of THIS page)
function api() {
  return { get player() { return player; }, get friends() { return friends; }, get cloud() { return cloud; }, get cfiles() { return cfiles; }, get games() { return games; }, askConflict, syncEverything, get cloudUi() { return cloudUi; }, get assist() { return assist; }, get session() { return friends && friends.session; }, get controls() { return controls; }, get store() { return store; }, get caps() { return caps; }, get games() { return games; }, get savesWritten() { return savesWritten; },
    stats: () => (player ? player.stats : null), grab: () => player && player.grab(), isPlaying: () => !!current && !!player && player.running, whenSaved: () => saveChain };
}
boot();
