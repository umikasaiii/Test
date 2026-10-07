// Download Play assistant (PWA): drives the host's game menus (Mario Party DS: Multiplayer -> Single-Card Play) and the guest's firmware menu (DS menu -> Download Play -> pick the game),
// so two people do not have to navigate the DS menus themselves. It is the JavaScript port of the assistant the native product already uses (cloud/gateway/mpdriver.go):
// it "looks" at the console like the user does (the page's own picture, compared as a 16x16 average-hash with reference screens) and "touches" it through the same input path as the touch controls.
//
// The reference screens (refs.json: only hashes of screens, derived from the user's own firmware/game) are used by the HOST device only and never leave it. The GUEST needs no references at all:
// it is driven by the DS state machine (what the radio is doing) plus the fixed touch points of the DS firmware menu, so it needs only BIOS and firmware, not the game.
// Nothing here logs pictures, hashes or payload: the timeline carries step names, DS state names, counters and times.
//
// The DS states come from the core's passive Download Play diagnostics (runtime/src/dlplay_diag.cpp, classification of the wireless frames: counters and timings only).
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** the same 16x16 average-hash as the native driver: rows y0+6..y0+192 step 12, columns 8..256 step 16, '1' when above the mean */
export function hashScreens(px, w = 256) {
  const one = (y0) => {
    const g = []; let sum = 0;
    for (let y = y0 + 6; y < y0 + 192; y += 12) for (let x = 8; x < 256; x += 16) { const i = (y * w + x) * 4, v = Math.floor((px[i] + px[i + 1] + px[i + 2]) / 3); g.push(v); sum += v; }
    const avg = sum / g.length; let s = ""; for (const v of g) s += v > avg ? "1" : "0"; return s;
  };
  return { top: one(0), bot: one(192) };
}
export const hdist = (a, b) => { let n = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++; return n; };

/** refs.json: {name: {top, bot}} of 256-char 0/1 strings. Returns {ok, error?, names?}; never echoes content. */
export function validateRefs(text, need = []) {
  let o; try { o = JSON.parse(String(text).replace(/^﻿/, "").trim()); } catch { return { ok: false, error: "refs.json non è un JSON valido" }; }
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: false, error: "refs.json non ha il formato atteso" };
  for (const [k, v] of Object.entries(o)) if (!v || typeof v.top !== "string" || typeof v.bot !== "string" || !/^[01]{256}$/.test(v.top) || !/^[01]{256}$/.test(v.bot)) return { ok: false, error: `refs.json: voce non valida (${k})` };
  const missing = need.filter((n) => !(n in o));
  if (missing.length) return { ok: false, error: "refs.json: mancano schermate (" + missing.join(", ") + ")" };
  return { ok: true, names: Object.keys(o) };
}
export const HOST_REFS = ["host_select_data", "host_main_menu", "host_find_players", "host_p2_joined", "host_you_are_p1", "host_select_mode"];

export class DlAssist {
  /** @param {{role:'host'|'guest', player:object, refs:object, scale?:number, onStep?:(s:string)=>void}} o */
  constructor(o) {
    this.role = o.role; this.player = o.player; this.refs = o.refs; this.scale = o.scale || 1; this.onStep = o.onStep || (() => {});
    this.timeline = []; this.t0 = performance.now(); this.stopped = false; this.step = ""; this.lastDist = {}; this.done = false; this.failed = "";
    this.seen = new Set(); this.dlBytes = { start: 0, last: 0 };
  }
  stop() { this.stopped = true; }
  mark(name, extra) { const t = Math.round(performance.now() - this.t0); this.timeline.push({ t, name, ...(extra || {}) }); }
  markOnce(name, extra) { if (!this.seen.has(name)) { this.seen.add(name); this.mark(name, extra); } }
  setStep(s) { this.step = s; this.onStep(s); }
  get dl() { const s = this.player.stats; return (s && s.dl) || {}; }
  get state() { return this.dl.dl_state || "IDLE"; }
  /** how much slower than a real DS this console runs (the DS menus advance per emulated frame): 1 at 60 fps, more on a slow phone or with a distant peer (each radio reply is waited for inside the frame) */
  get K() { const f = (this.player.stats && this.player.stats.emuFps) || 60; return Math.min(6, Math.max(1, 60 / Math.max(10, f))); }
  async esleep(ms) { return this.sleep(ms * this.K); }                   // an emulated-time wait
  async sleep(ms) { const end = performance.now() + ms; while (performance.now() < end) { if (this.stopped) throw new Error("stopped"); await sleepMs(Math.min(100, end - performance.now())); } }
  async hold() { while (this.player.paused) { if (this.stopped) throw new Error("stopped"); await sleepMs(250); } }   // a console in the background is not driven

  async tap(x, y, hold = 400, wait = 1500) { await this.hold(); this.player.touch(x, y, true); await this.esleep(hold); this.player.touch(x, y, false); await this.esleep(wait); }
  async press(b, hold = 250, wait = 1000) { await this.hold(); this.player.btn(b, true); await this.esleep(hold); this.player.btn(b, false); await this.esleep(wait); }

  async look() { const px = await this.player.grab(); return hashScreens(px); }
  async screenIs(name, which = "both", tol = 40) {
    const ref = this.refs[name]; if (!ref) throw new Error("missing reference screen " + name);
    const h = await this.look(), dt = hdist(h.top, ref.top), db = hdist(h.bot, ref.bot); this.lastDist[name] = { top: dt, bot: db };
    return which === "top" ? dt <= tol : which === "bot" ? db <= tol : dt <= tol && db <= tol;
  }
  async waitScreen(name, secs, which = "both", tol = 40) {
    const end = performance.now() + secs * 1000 * this.scale * this.K;
    while (performance.now() < end) { await this.hold(); if (await this.screenIs(name, which, tol)) return true; await this.sleep(1000); }
    return false;
  }
  async waitState(states, secs) {
    const end = performance.now() + secs * 1000 * this.scale * this.K;   // a console that runs slower (slow phone, distant peer) needs proportionally longer
    while (performance.now() < end) { this.observe(); if (states.includes(this.state)) return true; await this.sleep(250); }
    return false;
  }
  /** milestones from the DS state machine (names of the Mario Download Play diagnostics) */
  observe() {
    const st = this.state, c = this.dl.dl_counters || {};
    if (st === "HOST_ADVERTISING") this.markOnce("HOST_ADVERTISING");
    if (st === "GAME_DISCOVERED") this.markOnce("GUEST_DISCOVERED");
    if (["DOWNLOAD_HANDSHAKE", "DOWNLOAD_TRANSFER"].includes(st)) { if (!this.seen.has("DOWNLOAD_BEGIN")) this.dlBytes.start = c.data_bytes_rx || c.data_bytes_tx || 0; this.markOnce("DOWNLOAD_BEGIN"); }
    if (st === "DOWNLOAD_TRANSFER") { const b = (c.data_bytes_rx || 0) + (c.data_bytes_tx || 0); if (b - this.dlBytes.last > 65536) { this.dlBytes.last = b; this.mark("DOWNLOAD_PROGRESS", { bytes: b }); } }
    if (st === "DOWNLOAD_VERIFY") { this.markOnce("DOWNLOAD_COMPLETE", { bytes: (c.data_bytes_rx || 0) + (c.data_bytes_tx || 0) }); }
    if (st === "CLIENT_GAME_BOOT") this.markOnce("GUEST_BOOT");
    if (st === "GAME_HANDSHAKE") this.markOnce("GAME_HANDSHAKE");
    if (st === "LOBBY") { this.markOnce("GAME_HANDSHAKE"); }
    if (st === "IN_GAME") this.markOnce("GAMEPLAY");
  }
  async goTo(name, which, tol, tries, waitS, action) {
    for (let i = 0; i < tries; i++) { if (await this.screenIs(name, which, tol)) return true; await action(); await this.sleep(waitS * 1000); }
    return this.screenIs(name, which, tol);
  }
  async ifScreen(name, which, tol, fn) { if (await this.screenIs(name, which, tol)) await fn(); }
  fail(why) { this.failed = why; throw new Error(why); }

  async run() {
    try { if (this.role === "host") await this.runHost(); else await this.runGuest(); this.done = true; }
    catch (e) { if (!this.failed && !this.stopped) this.failed = String(e && e.message || e); }
    return { ok: this.done, failed: this.failed, step: this.step, timeline: this.timeline };
  }

  // ---------------------------------------------------------------- HOST: Mario Party DS menus -> Multiplayer -> Single-Card Play -> (a guest downloads) -> OK -> lobby
  async runHost() {
    this.setStep("Avvio del gioco…"); this.mark("HOST_BOOT");
    await this.esleep(14000);
    if (!await this.goTo("host_select_data", "both", 40, 8, 3, () => this.tap(0.5, 0.9, 300, 3000))) this.fail("host: schermata del salvataggio");
    this.mark("HOST_SELECT_DATA");
    if (!await this.goTo("host_main_menu", "bot", 40, 6, 3, () => this.ifScreen("host_select_data", "both", 40, async () => { await this.tap(0.5, 0.66, 400, 1500); await this.tap(0.88, 0.97, 400, 3000); }))) this.fail("host: menu principale");
    if (!await this.goTo("host_find_players", "top", 40, 6, 3, () => this.ifScreen("host_main_menu", "bot", 40, async () => { await this.tap(0.5, 0.80, 400, 1500); await this.tap(0.88, 0.97, 400, 3000); }))) this.fail("host: menu multigiocatore");
    this.mark("HOST_MULTIPLAYER_MENU"); this.setStep("Ricerca partita…");
    if (!await this.waitState(["DOWNLOAD_HANDSHAKE", "DOWNLOAD_TRANSFER", "DOWNLOAD_VERIFY"], 240)) this.fail("host: l'altro DS non ha chiesto il gioco");
    this.setStep("Download Play…");
    if (!await this.waitState(["DOWNLOAD_VERIFY"], 400)) this.fail("host: trasferimento non completato");
    await this.esleep(12000);                                          // let the other console finish verifying what it received: starting before that leaves it waiting forever
    if (!await this.waitScreen("host_p2_joined", 40, "bot", 40)) this.fail("host: i giocatori non sono elencati");
    this.setStep("Avvio partita…");
    let started = false;
    for (let t = 0; t < 10 && !started; t++) {                         // OK -> start; the OK button sits at the edge of the touch screen: vary the touch point, and use A as the same "OK"
      if (t > 0 && await this.screenIs("host_you_are_p1", "bot", 40)) break;
      if (t % 3 === 0) await this.tap(0.88, 0.97, 400, 1500); else if (t % 3 === 1) await this.tap(0.85, 0.94, 500, 1500); else await this.press("a", 300, 1500);
      started = await this.waitState(["CLIENT_GAME_BOOT", "GAME_HANDSHAKE", "LOBBY"], 6);
    }
    if (!started) started = await this.waitState(["CLIENT_GAME_BOOT", "GAME_HANDSHAKE", "LOBBY"], 60);   // the host already shows "You are P1": give the other console time to reboot into the game
    if (!started) this.fail("host: la partita non è partita dopo OK");
    if (!await this.waitState(["GAME_HANDSHAKE", "LOBBY"], 100)) this.fail("host: handshake del gioco non completato");
    await this.waitScreen("host_you_are_p1", 60, "bot", 40);
    for (let i = 0; i < 14; i++) {                                         // "You are P1" -> OK -> Select Mode; the lobby is confirmed by the screen, the DS state is only the fallback of the last tries
      if (await this.screenIs("host_select_mode", "bot", 60)) { this.markOnce("MARIO_LOBBY"); return; }
      if (i >= 12 && (this.state === "LOBBY" || this.state === "IN_GAME")) { this.markOnce("MARIO_LOBBY"); return; }
      await this.ifScreen("host_you_are_p1", "bot", 40, () => this.tap(0.5, 0.79, 400, 1000));
      await this.esleep(3000);
    }
    this.fail("host: lobby non raggiunta");
  }

  // ---------------------------------------------------------------- GUEST: firmware (no cartridge) -> DS menu -> Download Play -> pick the game -> download -> boot -> lobby. No reference screens: state-driven.
  async runGuest() {
    this.setStep("Avvio del Nintendo DS…"); this.mark("GUEST_FIRMWARE_BOOT");
    await this.esleep(14000);
    const scanning = ["CLIENT_SCANNING", "GAME_DISCOVERED", "DOWNLOAD_HANDSHAKE", "DOWNLOAD_TRANSFER", "DOWNLOAD_VERIFY"];
    for (let i = 0; i < 10 && !scanning.includes(this.state); i++) {       // DS menu tile, then the Download Play entry; the radio starting to scan is the proof it opened
      if (i < 2) { await this.tap(0.5, 0.75, 400, 1500); if (i === 0) this.mark("GUEST_DS_MENU"); }
      await this.tap(0.68, 0.72, 300, 2000); await this.sleep(2000);
    }
    this.mark("DISCOVERY_START"); this.setStep("Ricerca partita…");
    if (!await this.waitState(["GAME_DISCOVERED", "DOWNLOAD_HANDSHAKE", "DOWNLOAD_TRANSFER", "DOWNLOAD_VERIFY"], 300)) this.fail("guest: nessuna partita trovata");
    await this.sleep(3000);
    for (let i = 0; i < 12; i++) {
      if (["DOWNLOAD_HANDSHAKE", "DOWNLOAD_TRANSFER", "DOWNLOAD_VERIFY"].includes(this.state)) break;
      await this.tap(0.5, 0.67, 300, 2000); await this.press("a", 250, 3000);
    }
    this.setStep("Download Play…"); this.mark("DOWNLOAD_REQUESTED");
    if (!await this.waitState(["DOWNLOAD_VERIFY", "CLIENT_GAME_BOOT", "GAME_HANDSHAKE", "LOBBY"], 500)) this.fail("guest: download non completato");
    this.setStep("Avvio partita…");
    if (!await this.waitState(["CLIENT_GAME_BOOT", "GAME_HANDSHAKE", "LOBBY"], 400) || !await this.waitState(["GAME_HANDSHAKE", "LOBBY"], 400)) this.fail("guest: il gioco non è partito");
    await this.esleep(8000);
    for (let i = 0; i < 6; i++) {                                          // "You are P2" -> OK (a tap on the OK area), a few times: an ignored tap is repeated; the host confirms its own side
      await this.tap(0.5, 0.79, 400, 4000);
      await this.esleep(2000);
    }
    if (["GAME_HANDSHAKE", "LOBBY", "IN_GAME"].includes(this.state)) { this.markOnce("MARIO_LOBBY"); return; }
    this.fail("guest: lobby non raggiunta");
  }
}
