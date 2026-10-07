// DSLink PWA player (Foundation 1): the Nintendo DS runs INSIDE this page (WebAssembly), on this device. Library, BIOS/firmware and saves are stored in the browser only.
// No account, no server round trip for emulation: after the page is loaded the player works offline.
import { mountControls } from "../controls/controls.js";
import { openStore, requestPersistence, estimate } from "./storage.js";
import { sha256Hex } from "./sha256.js";
import { Player, detectCaps } from "./player.js";

const $ = (id) => document.getElementById(id);
const DEV = new URLSearchParams(location.search).has("dev") || (() => { try { return localStorage.getItem("dslink.dev") === "1"; } catch { return false; } })();
const SYS = [
  { key: "bios7", file: "bios7.bin", title: "BIOS ARM7", sizes: [16384] },
  { key: "bios9", file: "bios9.bin", title: "BIOS ARM9", sizes: [4096] },
  { key: "firmware", file: "firmware.bin", title: "Firmware", sizes: [131072, 262144, 524288] },
];
let store = null, caps = null, games = [], sysInfo = {}, player = null, controls = null, current = null, guard = false, saveChain = Promise.resolve(), savesWritten = 0;

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
  renderDiag();
  await refresh();
  show("library");
  if (DEV) { $("devOverlay").hidden = false; setInterval(devTick, 500); }
  if ("serviceWorker" in navigator && self.isSecureContext && !new URLSearchParams(location.search).has("nosw")) navigator.serviceWorker.register("./sw.js", { scope: "./" }).catch(() => {});
  window.dslinkPlay = api();
}

function renderDiag() {
  const yn = (v) => (v ? "sì" : "NO");
  const lines = [`WebAssembly: ${yn(caps.wasm)}`, `Web Worker (module): ${yn(caps.moduleWorker)}`, `WebGL2: ${yn(caps.webgl2)}  WebGL: ${yn(caps.webgl)}`, `AudioWorklet: ${yn(caps.audioWorklet)}  AudioContext: ${yn(caps.audioContext)}`,
    `Archivio: ${store ? (store.kind === "opfs" ? "OPFS" : "IndexedDB" + (caps.opfs ? " (OPFS presente ma non scrivibile qui)" : " (OPFS assente)")) : "nessuno"}`, `IndexedDB: ${yn(caps.indexedDB)}`,
    `Contesto sicuro (https): ${yn(caps.secure)}`, `App installata (standalone): ${yn(caps.standalone)}`, `Touch: ${yn(caps.touch)}`, `Service worker: ${yn(caps.serviceWorker)}`,
    `Thread WASM possibili (SharedArrayBuffer + isolamento): ${yn(caps.sab && caps.crossOriginIsolated)} (non necessari)`];
  $("diagText").textContent = lines.join("\n");
}
async function refresh() {
  games = [];
  if (store) {
    for (const p of await store.list("library/")) {
      if (!p.endsWith("/meta.json")) continue;
      try { games.push(JSON.parse(new TextDecoder().decode(await store.get(p)))); } catch { /* damaged entry: ignore */ }
    }
    for (const s of SYS) { const b = await store.get("system/" + s.file); sysInfo[s.key] = b ? { size: b.byteLength, ok: s.sizes.includes(b.byteLength) } : null; }
  }
  games.sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  renderLibrary();
}

function renderLibrary() {
  const ul = $("gameList"); ul.innerHTML = "";
  if (!games.length) { const li = document.createElement("li"); li.textContent = "Nessun gioco. Aggiungine uno."; ul.append(li); }
  for (const g of games) {
    const li = document.createElement("li"); li.className = "game"; li.dataset.id = g.id;
    const t = document.createElement("span"); t.className = "t"; t.textContent = g.title || g.id; const sm = document.createElement("small"); sm.textContent = (g.code || "") + " · " + fmtSize(g.size); t.append(sm);
    const play = document.createElement("button"); play.className = "cta primary play"; play.textContent = "GIOCA"; play.onclick = () => playGame(g.id);
    const del = document.createElement("button"); del.className = "del"; del.setAttribute("aria-label", "Rimuovi"); del.textContent = "✕"; del.onclick = () => removeGame(g);
    li.append(t, play, del); ul.append(li);
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
    li.append(t, lab); sl.append(li);
  }
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
  } catch (err) { $("libErr").textContent = "Non riesco a salvare il gioco: " + (err && err.message || err); }
};
async function importSystem(s, inp) {
  const f = inp.files[0]; inp.value = ""; if (!f || !store) return;
  const buf = await f.arrayBuffer();
  if (!s.sizes.includes(buf.byteLength)) { sysInfo[s.key] = { size: buf.byteLength, ok: false }; renderLibrary(); return; }   // wrong file: not stored
  await store.put("system/" + s.file, buf); await refresh();
}
async function removeGame(g) {
  if (!store || !confirm(`Rimuovere "${g.title}" e il suo salvataggio da questo dispositivo?`)) return;
  for (const n of ["rom.nds", "meta.json", "save"]) await store.del(`library/${g.id}/${n}`);
  await refresh();
}

// ---------------------------------------------------------------- play
const KEYS = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right", z: "b", x: "a", a: "y", s: "x", q: "l", w: "r", Enter: "start", Shift: "select" };
const onKey = (d) => (e) => { const k = KEYS[e.key]; if (k && player) { player.btn(k, d); e.preventDefault(); } };
const kd = onKey(true), ku = onKey(false);

async function playGame(id) {
  if (current || !store) return;
  const g = games.find((x) => x.id === id); if (!g) return;
  current = id;
  player = new Player({
    canvas: document.createElement("canvas"),
    onSram: (gid, data) => { saveChain = saveChain.then(() => store.put(`library/${gid}/save`, data)).then(() => { savesWritten++; }).catch(() => { $("libErr").textContent = "Salvataggio non riuscito"; }); },
    onError: (msg) => fail(msg),
    onShutdown: () => leave(true),
  });
  player.prepare();                       // the tap's gesture creates the AudioContext
  $("loadingNote").textContent = "Carico " + (g.title || "il gioco") + "…"; show("loading");
  try {
    const rom = await store.get(`library/${id}/rom.nds`); if (!rom) throw new Error("Gioco non trovato nell'archivio");
    const system = {}; for (const s of SYS) { const b = await store.get("system/" + s.file); if (b && s.sizes.includes(b.byteLength)) system[s.file] = b; }
    const sram = await store.get(`library/${id}/save`);
    buildGame();
    await player.start({ id, rom, system, sram });
    show("game"); $("game").hidden = false; $("app").style.display = "none";
    if (!guard) { history.pushState({ game: true }, ""); guard = true; }
    addEventListener("keydown", kd); addEventListener("keyup", ku);
    if (player.audioBlocked()) $("resumeHint").hidden = false;
  } catch (e) { fail(e && e.message || String(e)); }
}

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
  removeEventListener("keydown", kd); removeEventListener("keyup", ku);
  if (!fromCore && player) { await player.save(true); }
  const p = player; player = null; if (p) await p.stop();
  await saveChain;                                         // the last save is on disk before the library shows again
  if (controls) { controls.destroy(); controls = null; }
  $("game").hidden = true; $("game").innerHTML = ""; $("app").style.display = ""; $("resumeHint").hidden = true;
  current = null; show("library");
}
function fail(msg) {
  const p = player; player = null; if (p) p.stop().catch(() => {});
  if (controls) { controls.destroy(); controls = null; }
  $("game").hidden = true; $("game").innerHTML = ""; $("app").style.display = ""; current = null;
  $("errorNote").textContent = msg; show("error");
}
$("btnErrBack").onclick = () => show("library");
$("btnResume").onclick = async () => { if (player) { await player.unlockAudio(); await player.resume(); } $("resumeHint").hidden = true; };
document.addEventListener("visibilitychange", () => { if (!document.hidden) setTimeout(() => { if (player && player.audioBlocked()) $("resumeHint").hidden = false; }, 600); });   // after the player's own resume had a chance (iOS may need a tap)
addEventListener("popstate", () => { if (current) { history.pushState({ game: true }, ""); askLeave(); } else guard = false; });

// ---------------------------------------------------------------- development overlay (this device only, never sent anywhere)
function devTick() {
  if (!player) { $("devOverlay").textContent = `DSLink dev · ${store ? store.kind : "-"} · ${Object.entries(caps || {}).filter(([, v]) => v === true).map(([k]) => k).join(" ")}`; return; }
  const s = player.stats;
  $("devOverlay").textContent = [`emu ${s.emuFps.toFixed(1)} fps   render ${s.renderFps.toFixed(1)} fps (${s.video})`, `frame ${s.frameMsAvg.toFixed(2)} ms avg / ${s.frameMsMax.toFixed(1)} ms max   dropped ${s.drops}`,
    `audio ${s.audio}  underruns ${s.underruns}  buf ${s.audioFillMs.toFixed(0)} ms`, `wasm ${s.wasmMB.toFixed(0)} MB   main stalls ${s.stalls}`, `store ${store.kind}`].join("\n");
}

// ---------------------------------------------------------------- test/diagnostic surface (read-only state of THIS page)
function api() {
  return { get player() { return player; }, get controls() { return controls; }, get store() { return store; }, get caps() { return caps; }, get games() { return games; }, get savesWritten() { return savesWritten; },
    stats: () => (player ? { ...player.stats, samples: player.samples } : null), grab: () => player && player.grab(), isPlaying: () => !!current && !!player && player.running, whenSaved: () => saveChain };
}
boot();
