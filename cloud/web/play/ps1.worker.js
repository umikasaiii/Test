// PlaySphere PS1 emulator worker: runs the PlayStation WebAssembly runtime (PCSX-ReARMed) off the main thread. Same message protocol as the DS worker where the meaning is the same
// (init / start / pause / resume / save / stop / frame / stats ...); the PlayStation extras are the disc files (mounted lazily from File objects, never copied into memory), pads with
// analog sticks, disc swap, save states and rumble. The core is only downloaded when this worker starts: a user who never plays a PlayStation game never fetches it.
import { createAvPipe } from "./avpipe.js";

const CORE_API = 1;
const base = (p) => new URL(p, import.meta.url).href;
const post = (m, tr) => self.postMessage(m, tr || []);
let M = null;
const av = createAvPipe({ post, getM: () => M });                       // exists before the core is loaded: the page hands over its audio / video ports first
let paused = true, timer = 0, started = false, info = null;
let frameMs = 1000 / 59.94, next = 0, frames = 0, romId = "", sramFile = "", lastSram = null, sampleRate = 44100;
let statT = 0, statFrames = 0, statEmuMs = 0, statMax = 0, lateSum = 0, lateMax = 0, lastRumble = [0, 0];
let discPhase = null, mounted = false, comboAt = -1, pads = [{ m: 0, a: [0, 0, 0, 0] }, { m: 0, a: [0, 0, 0, 0] }];
const cstr = (s) => { const n = M.lengthBytesUTF8(s) + 1, p = M._malloc(n); M.stringToUTF8(s, p, n); return p; };
const mkdirs = (p) => { try { M.FS.mkdirTree(p); } catch { /* exists */ } };
const ANALOG_COMBO = (1 << 14) | (1 << 15);                                // L3 + R3: the option below makes the core toggle the DualShock between DIGITAL and ANALOG
const COMBO_DELAY = 45, COMBO_HOLD = 6;                                    // frames: let the pad change type (the core "replugs" it) before the toggle is pressed

const optionText = (o) => [
  `pcsx_rearmed_bios = "${o.bios === "hle" ? "HLE" : "auto"}"`, `pcsx_rearmed_region = "${o.region === "PAL" ? "PAL" : o.region === "NTSC" ? "NTSC" : "auto"}"`,
  'pcsx_rearmed_memcard1 = "libretro"', 'pcsx_rearmed_memcard2 = "none"', 'pcsx_rearmed_show_bios_bootlogo = "disabled"', 'pcsx_rearmed_frameskip_type = "disabled"',
  'pcsx_rearmed_analog_combo = "l3+r3"', 'pcsx_rearmed_vibration = "enabled"', 'pcsx_rearmed_multitap = "disabled"', 'pcsx_rearmed_rgb32_output = "disabled"',
  'pcsx_rearmed_drc = "disabled"', 'pcsx_rearmed_gpu_thread_rendering = "disabled"', 'pcsx_rearmed_display_internal_fps = "disabled"',
].join("\n") + "\n";

async function load(msg) {
  const infoUrl = msg.info || base("./core/ps1/build-info.json");
  try { info = await (await fetch(infoUrl, { cache: "no-cache" })).json(); } catch { info = null; }
  if (!info || info.api !== CORE_API) throw new Error("Il core PlayStation non corrisponde a questa versione di PlaySphere (riapri o aggiorna l'app).");
  const create = (await import(msg.js || base("./core/ps1/playsphere_ps1.js"))).default;
  M = await create();
  if (!M._dsl_init(0, 0)) throw new Error("core init failed: " + M.UTF8ToString(M._dsl_error()));
}
function mount(files) {
  if (mounted) { try { M.FS.unmount("/disc"); } catch { /* none */ } mounted = false; }
  mkdirs("/disc");
  M.FS.mount(M.FS.filesystems.WORKERFS, { blobs: files.map((f) => ({ name: f.name, data: f.blob })) }, "/disc"); mounted = true;
}
const stem = (p) => { const b = p.split("/").pop(); const i = b.lastIndexOf("."); return i > 0 ? b.slice(0, i) : b; };

function startGame(msg) {
  mkdirs("/system"); mkdirs("/saves/PCSX-ReARMed"); mkdirs("/m3u");
  for (const [name, buf] of Object.entries(msg.system || {})) if (buf) M.FS.writeFile(`/system/${name}`, new Uint8Array(buf));
  mount(msg.files);
  let content;
  if (msg.discs && msg.discs.length > 1) {                                          // several discs: an .m3u (absolute paths) and the core's own disc control does the rest
    content = `/m3u/${msg.id}.m3u`; M.FS.writeFile(content, new TextEncoder().encode(msg.discs.map((d) => `/disc/${d}`).join("\n") + "\n"));
  } else content = `/disc/${(msg.discs && msg.discs[0]) || msg.files[0].name}`;
  romId = msg.id; sramFile = `/saves/PCSX-ReARMed/${stem(content)}.srm`;
  if (msg.sram) { M.FS.writeFile(sramFile, new Uint8Array(msg.sram)); lastSram = new Uint8Array(msg.sram); } else { try { M.FS.unlink(sramFile); } catch { /* none */ } lastSram = null; }
  if (!M._ps1_start(cstr(optionText(msg.options || {})), cstr("/system"), cstr("/saves"), cstr(content))) {
    post({ t: "error", msg: "Avvio non riuscito: " + M.UTF8ToString(M._dsl_error()) + " " + coreLogTail().split("\n").slice(-3).join(" ") }); return;
  }
  for (let p = 0; p < 2; p++) M._ps1_set_device(p, (msg.options && msg.options.analog) ? ((1 + 1) << 8) | 5 : 1);
  sampleRate = M._dsl_sample_rate() || 44100; const fps = M._dsl_fps() || 59.94; frameMs = 1000 / fps;
  started = true; paused = false; next = performance.now(); frames = 0; statT = next; resetStats(); discPhase = null; lastRumble = [0, 0]; comboAt = -1; pads = [{ m: 0, a: [0, 0, 0, 0] }, { m: 0, a: [0, 0, 0, 0] }];
  post({ t: "started", sampleRate, fps, w: M._dsl_video_w(), h: M._dsl_video_h(), audio: av.s.audioMode, aspect: M._ps1_aspect(), discs: M._ps1_disc_count(), disc: M._ps1_disc_index(), stateSize: M._ps1_state_size(),
    core: { id: "pcsx-rearmed", name: M.UTF8ToString(M._ps1_core_name()), version: info.coreVersion, stateFormat: info.stateFormat }, srmPath: M.UTF8ToString(M._dsl_sram_path()), log: coreLogTail() });
  schedule();
}
function coreLogTail() { try { return M.UTF8ToString(M._dsl_log()).slice(-1500); } catch { return ""; } }
function resetStats() { statFrames = 0; statEmuMs = 0; statMax = 0; lateSum = 0; lateMax = 0; }

function takeSram(force) {
  if (!started) return;
  M._dsl_save_sram();
  let data = null; try { data = M.FS.readFile(sramFile); } catch { return; }
  if (!force && lastSram && lastSram.byteLength === data.byteLength && lastSram.every((v, i) => v === data[i])) return;
  lastSram = data.slice(); const buf = data.slice().buffer;
  post({ t: "sram", id: romId, data: buf }, [buf]);
}

function applyPads() { for (let p = 0; p < 2; p++) { const q = pads[p]; let m = q.m; if (p === 0 && comboAt >= 0 && frames >= comboAt && frames < comboAt + COMBO_HOLD) m |= ANALOG_COMBO; M._ps1_set_pad(p, m, q.a[0], q.a[1], q.a[2], q.a[3]); } }

function runOne() {
  applyPads();
  const t0 = performance.now(), alive = M._dsl_run_frame(), dt = performance.now() - t0;
  statEmuMs += dt; if (dt > statMax) statMax = dt; statFrames++; frames++;
  av.sendAudio(); av.sendVideo();
  const s = M._ps1_rumble(0, 0), w = M._ps1_rumble(0, 1); if (s !== lastRumble[0] || w !== lastRumble[1]) { lastRumble = [s, w]; post({ t: "rumble", strong: s, weak: w }); }
  if (discPhase) {                                                                  // disc swap: lid open for a moment, new disc in, lid closed
    if (--discPhase.wait <= 0) {
      if (discPhase.step === 0) { M._ps1_disc_set_index(discPhase.index); M._ps1_disc_set_eject(0); discPhase = { step: 1, wait: 90, index: discPhase.index }; }
      else { post({ t: "disc", index: M._ps1_disc_index(), count: M._ps1_disc_count(), ejected: !!M._ps1_disc_ejected() }); discPhase = null; }
    }
  }
  return alive;
}
function tick() {
  timer = 0; if (!started || paused) return;
  let now = performance.now(), ran = 0;
  const late = now - next; if (late > 0) { lateSum += late; if (late > lateMax) lateMax = late; }
  if (late > 200) next = now;
  while (now >= next && ran < 3) { if (!runOne()) { post({ t: "shutdown", log: coreLogTail(), dl: null }); started = false; return; } next += frameMs; ran++; now = performance.now(); }
  if (now - statT >= 1000) {
    const sec = (now - statT) / 1000, s = av.s;
    post({ t: "stats", emuFps: statFrames / sec, frameMsAvg: statFrames ? statEmuMs / statFrames : 0, frameMsMax: statMax, tickLateAvgMs: statFrames ? lateSum / statFrames : 0, tickLateMaxMs: lateMax,
      submitted: s.vsubmitted, droppedAtSource: s.vdropped, audioFrames: s.audioFrames, audioDropped: s.audioDropped, audioPeak: s.peak, wasmBytes: M.HEAPU8.byteLength, frames, dl: null, radio: null,
      ps1: { w: M._dsl_video_w(), h: M._dsl_video_h(), fps: 1000 / frameMs, disc: M._ps1_disc_index(), discs: M._ps1_disc_count(), ejected: !!M._ps1_disc_ejected() } });
    statT = now; resetStats(); s.peak = 0;
  }
  schedule();
}
function schedule() { if (!timer && started && !paused) timer = setTimeout(tick, Math.max(0, next - performance.now() - 1)); }

function stateSave(slot, token) {
  const n = M._ps1_state_size(); if (!n) { post({ t: "state", token, slot, error: "unsupported" }); return; }
  const p = M._dsl_alloc(n); const ok = M._ps1_state_save(p, n); let data = null;
  if (ok) data = M.HEAPU8.slice(p, p + n).buffer; M._dsl_free(p);
  if (!ok) post({ t: "state", token, slot, error: "save_failed" }); else post({ t: "state", token, slot, data, size: n, core: info.id, coreVersion: info.coreVersion, stateFormat: info.stateFormat }, [data]);
}
function stateLoad(buf, token) {
  const u = new Uint8Array(buf), p = M._dsl_alloc(u.byteLength); M.HEAPU8.set(u, p);
  const ok = M._ps1_state_load(p, u.byteLength); M._dsl_free(p);
  post({ t: "stateLoaded", token, ok: !!ok });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.t) {
      case "init": await load(m); post({ t: "ready", core: { id: info.id, version: info.coreVersion, stateFormat: info.stateFormat, api: info.api } }); break;
      case "probe": {                                                              // import: what is this disc? (no game starts)
        mount(m.files); const r = {};
        for (const f of m.probe) { try { r[f] = JSON.parse(M.UTF8ToString(M._ps1_probe(cstr("/disc/" + f)))); } catch (err) { r[f] = { ok: false, error: "probe_failed" }; } }
        post({ t: "probed", token: m.token, result: r }); break;
      }
      case "audioPort": av.audioPort(m.port); break;
      case "videoPort": av.videoPort(m.port); break;
      case "audioSab": av.audioSab(m); break;
      case "start": startGame(m); break;
      case "buttons": pads[0].m = m.mask; break;
      case "pad": { const q = pads[m.port | 0]; if (q) { q.m = m.mask; q.a = [m.lx | 0, m.ly | 0, m.rx | 0, m.ry | 0]; } break; }
      case "analogToggle": comboAt = frames + COMBO_DELAY; break;                                  // the core toggles the DualShock mode when it sees the combo
      case "device": if (started) M._ps1_set_device(m.port | 0, m.analog ? ((1 + 1) << 8) | 5 : 1); break;
      case "recycle": av.recycle(m.buf); break;
      case "pause": paused = true; clearTimeout(timer); timer = 0; takeSram(false); break;
      case "resume": if (started && paused) { paused = false; next = performance.now(); statT = next; resetStats(); schedule(); } break;
      case "save": takeSram(!!m.force); post({ t: "saved", token: m.token }); break;
      case "ping": post({ t: "pong", token: m.token }); break;
      case "disc": if (started && M._ps1_disc_supported() && !discPhase && m.index !== M._ps1_disc_index()) { M._ps1_disc_set_eject(1); discPhase = { step: 0, wait: 60, index: m.index }; } break;
      case "stateSave": if (started) stateSave(m.slot, m.token); break;
      case "stateLoad": if (started) stateLoad(m.data, m.token); break;
      case "stop": paused = true; clearTimeout(timer); timer = 0; takeSram(true); if (M) { M._dsl_stop(); if (mounted) { try { M.FS.unmount("/disc"); } catch { /* none */ } mounted = false; } } started = false; post({ t: "stopped" }); break;
      case "log": post({ t: "log", text: M.UTF8ToString(M._dsl_log()) }); M._dsl_log_clear(); break;
    }
  } catch (err) { post({ t: "error", msg: String(err && err.message || err) }); }
};
