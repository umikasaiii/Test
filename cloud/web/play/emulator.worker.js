// DSLink emulator worker: runs the WebAssembly Runtime (melonDS DS core) off the main thread. It owns the clock (DS frame rate), turns frames into RGBA buffers for the page and
// samples into an audio port that goes straight to the AudioWorklet (so a busy main thread never starves the sound). No network of any kind is used here.
// Single-thread build: no SharedArrayBuffer / WASM threads are required (they are not available on every Safari/iOS setup).
import createDslink from "./core/dslink_wasm.js";

const CORE_OPTIONS = [
  'melonds_console_mode = "ds"', 'melonds_boot_mode = "direct"', 'melonds_mac_address_mode = "from-username"',
  'melonds_number_of_screen_layouts = "1"', 'melonds_screen_layout1 = "top-bottom"', 'melonds_show_cursor = "disabled"',
].join("\n") + "\n";

let M = null, running = false, paused = true, timer = 0, audioPort = null, started = false;
let frameMs = 1000 / 59.8261, next = 0, frames = 0, romId = "", sramFile = "", lastSram = null;
let inflight = 0, pool = [], seqSent = 0, drops = 0, sampleRate = 32768;
let statT = 0, statFrames = 0, statEmuMs = 0, statMax = 0;
const post = (m, tr) => self.postMessage(m, tr || []);
const cstr = (s) => { const n = M.lengthBytesUTF8(s) + 1, p = M._malloc(n); M.stringToUTF8(s, p, n); return p; };
const ccall = (name, ...a) => M["_" + name](...a);

async function init() {
  M = await createDslink();
  const ok = M._dsl_init(...[cstr("/system"), cstr("/saves")]);
  if (!ok) throw new Error("core init failed: " + M.UTF8ToString(M._dsl_error()));
  post({ t: "ready" });
}

function mkdirs(path) { try { M.FS.mkdirTree(path); } catch { /* exists */ } }

function startGame(msg) {
  mkdirs("/system/melonDS DS"); mkdirs("/saves/melonDS DS"); mkdirs("/rom");
  for (const [name, buf] of Object.entries(msg.system || {})) if (buf) M.FS.writeFile(`/system/melonDS DS/${name}`, new Uint8Array(buf));
  romId = msg.id;
  sramFile = `/saves/melonDS DS/${romId}.srm`;
  if (msg.sram) { M.FS.writeFile(sramFile, new Uint8Array(msg.sram)); lastSram = new Uint8Array(msg.sram); } else { try { M.FS.unlink(sramFile); } catch { /* none */ } lastSram = null; }
  const rom = new Uint8Array(msg.rom);
  const ptr = M._dsl_alloc(rom.byteLength);
  M.HEAPU8.set(rom, ptr);          // the core reads the cartridge in place, nothing else holds a copy
  const ok = M._dsl_start(cstr(CORE_OPTIONS), cstr("/system"), cstr("/saves"), cstr(romId + ".nds"), ptr, rom.byteLength);
  if (!ok) { post({ t: "error", msg: "Avvio non riuscito: " + M.UTF8ToString(M._dsl_error()) }); return; }
  sampleRate = M._dsl_sample_rate() || 32768;
  const fps = M._dsl_fps() || 59.8261; frameMs = 1000 / fps;
  started = true; paused = false; next = performance.now(); frames = 0; statT = performance.now();
  post({ t: "started", sampleRate, fps, w: M._dsl_video_w(), h: M._dsl_video_h() });
  schedule();
}

function takeSram(force) {
  if (!started) return;
  M._dsl_save_sram();
  let data = null;
  try { data = M.FS.readFile(sramFile); } catch { return; }
  if (!force && lastSram && lastSram.byteLength === data.byteLength && lastSram.every((v, i) => v === data[i])) return;   // unchanged: nothing to persist
  lastSram = data.slice();
  const buf = data.slice().buffer;
  post({ t: "sram", id: romId, data: buf }, [buf]);
}

function runOne() {
  const t0 = performance.now();
  const alive = M._dsl_run_frame();
  const dt = performance.now() - t0;
  statEmuMs += dt; if (dt > statMax) statMax = dt; statFrames++; frames++;
  // audio: straight to the worklet
  const n = M._dsl_audio_frames();
  if (n > 0 && audioPort) {
    const src = new Int16Array(M.HEAP16.buffer, M._dsl_audio_ptr(), n * 2);
    const copy = src.slice(); audioPort.postMessage(copy.buffer, [copy.buffer]);
  }
  M._dsl_audio_clear();
  // video: a recycled RGBA buffer, dropped when the page is behind
  const seq = M._dsl_video_seq();
  if (seq !== seqSent) {
    seqSent = seq;
    if (inflight < 3) {
      const w = M._dsl_video_w(), h = M._dsl_video_h(), len = w * h * 4;
      let buf = pool.pop(); if (!buf || buf.byteLength !== len) buf = new ArrayBuffer(len);
      new Uint8Array(buf).set(new Uint8Array(M.HEAPU8.buffer, M._dsl_video_ptr(), len));
      inflight++; post({ t: "frame", buf, w, h, seq }, [buf]);
    } else drops++;
  }
  return alive;
}

function tick() {
  timer = 0;
  if (!started || paused) return;
  let now = performance.now(), ran = 0;
  if (now - next > 200) next = now;                       // fell far behind (tab was throttled): resync instead of fast-forwarding
  while (now >= next && ran < 3) { if (!runOne()) { post({ t: "shutdown" }); started = false; return; } next += frameMs; ran++; now = performance.now(); }
  if (now - statT >= 1000) {
    post({ t: "stats", emuFps: statFrames * 1000 / (now - statT), frameMsAvg: statFrames ? statEmuMs / statFrames : 0, frameMsMax: statMax, drops, wasmBytes: M.HEAPU8.byteLength, frames });
    statT = now; statFrames = 0; statEmuMs = 0; statMax = 0; drops = 0;
  }
  schedule();
}
function schedule() { if (!timer && started && !paused) timer = setTimeout(tick, Math.max(0, next - performance.now() - 1)); }

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.t) {
      case "init": await init(); break;
      case "audioPort": audioPort = m.port; break;
      case "start": startGame(m); break;
      case "buttons": if (started) M._dsl_set_buttons(m.mask); break;
      case "touch": if (started) M._dsl_set_touch(m.d ? 1 : 0, m.x, m.y); break;
      case "recycle": inflight = Math.max(0, inflight - 1); if (m.buf && pool.length < 4) pool.push(m.buf); break;
      case "pause": paused = true; clearTimeout(timer); timer = 0; takeSram(false); break;
      case "resume": if (started && paused) { paused = false; next = performance.now(); statT = next; schedule(); } break;
      case "save": takeSram(!!m.force); post({ t: "saved", token: m.token }); break;
      case "stop": paused = true; clearTimeout(timer); timer = 0; takeSram(true); M._dsl_stop(); started = false; post({ t: "stopped" }); break;
      case "log": post({ t: "log", text: M.UTF8ToString(M._dsl_log()) }); M._dsl_log_clear(); break;
    }
  } catch (err) { post({ t: "error", msg: String(err && err.message || err) }); }
};
