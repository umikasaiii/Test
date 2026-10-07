// DSLink emulator worker: runs the WebAssembly Runtime (melonDS DS core) off the main thread. It owns the clock (DS frame rate) and never waits for the page:
// video goes out through a small pool of reused buffers, audio goes straight to the AudioWorklet (SharedArrayBuffer ring when the page is cross-origin isolated, otherwise a
// MessagePort with recycled buffers). Single thread build: no WASM threads are required (they are not available on every Safari/iOS setup). No network of any kind is used here.
import createDslink from "./core/dslink_wasm.js";

const CORE_OPTIONS = [
  'melonds_console_mode = "ds"', 'melonds_boot_mode = "direct"', 'melonds_mac_address_mode = "from-username"',
  'melonds_number_of_screen_layouts = "1"', 'melonds_screen_layout1 = "top-bottom"', 'melonds_show_cursor = "disabled"',
].join("\n") + "\n";

let M = null, paused = true, timer = 0, started = false;
let frameMs = 1000 / 59.8261, next = 0, frames = 0, romId = "", sramFile = "", lastSram = null, sampleRate = 32768;
// video: a fixed pool, nothing is allocated per frame once it is warm
const VPOOL = 4; let vfree = [], vlen = 0, vsubmitted = 0, vdropped = 0, seqSent = 0, vPort = null;   // vPort: pictures go straight to the render worker (OffscreenCanvas path)
// audio
let aPort = null, aFree = [], aSab = null, aCtrl = null, aCap = 0, aWrite = 0, audioFrames = 0, audioDropped = 0, audioMode = "none";
// stats
let statT = 0, statFrames = 0, statEmuMs = 0, statMax = 0, lateSum = 0, lateMax = 0;
const post = (m, tr) => self.postMessage(m, tr || []);
const cstr = (s) => { const n = M.lengthBytesUTF8(s) + 1, p = M._malloc(n); M.stringToUTF8(s, p, n); return p; };

async function init() {
  M = await createDslink();
  if (!M._dsl_init(cstr("/system"), cstr("/saves"))) throw new Error("core init failed: " + M.UTF8ToString(M._dsl_error()));
  post({ t: "ready" });
}
function mkdirs(path) { try { M.FS.mkdirTree(path); } catch { /* exists */ } }

function startGame(msg) {
  mkdirs("/system/melonDS DS"); mkdirs("/saves/melonDS DS"); mkdirs("/rom");
  for (const [name, buf] of Object.entries(msg.system || {})) if (buf) M.FS.writeFile(`/system/melonDS DS/${name}`, new Uint8Array(buf));
  romId = msg.id; sramFile = `/saves/melonDS DS/${romId}.srm`;
  if (msg.sram) { M.FS.writeFile(sramFile, new Uint8Array(msg.sram)); lastSram = new Uint8Array(msg.sram); } else { try { M.FS.unlink(sramFile); } catch { /* none */ } lastSram = null; }
  const rom = new Uint8Array(msg.rom), ptr = M._dsl_alloc(rom.byteLength);
  M.HEAPU8.set(rom, ptr);                                   // the core reads the cartridge in place, nothing else holds a copy
  if (!M._dsl_start(cstr(CORE_OPTIONS), cstr("/system"), cstr("/saves"), cstr(romId + ".nds"), ptr, rom.byteLength)) { post({ t: "error", msg: "Avvio non riuscito: " + M.UTF8ToString(M._dsl_error()) }); return; }
  sampleRate = M._dsl_sample_rate() || 32768; frameMs = 1000 / (M._dsl_fps() || 59.8261);
  started = true; paused = false; next = performance.now(); frames = 0; statT = next; resetStats();
  post({ t: "started", sampleRate, fps: 1000 / frameMs, w: M._dsl_video_w(), h: M._dsl_video_h(), audio: audioMode });
  schedule();
}
function resetStats() { statFrames = 0; statEmuMs = 0; statMax = 0; lateSum = 0; lateMax = 0; }

function takeSram(force) {
  if (!started) return;
  M._dsl_save_sram();
  let data = null; try { data = M.FS.readFile(sramFile); } catch { return; }
  if (!force && lastSram && lastSram.byteLength === data.byteLength && lastSram.every((v, i) => v === data[i])) return;   // unchanged: nothing to persist
  lastSram = data.slice(); const buf = data.slice().buffer;
  post({ t: "sram", id: romId, data: buf }, [buf]);
}

// ---- audio out
function sendAudio() {
  const n = M._dsl_audio_frames(); if (n <= 0) { M._dsl_audio_clear(); return; }
  const src = new Int16Array(M.HEAP16.buffer, M._dsl_audio_ptr(), n * 2);   // view only (a small header object), no copy of the samples
  if (aSab) {                                                // SharedArrayBuffer ring: write in place, publish the new write index
    const free = aCap - ((aWrite - Atomics.load(aCtrl, 1)) | 0);
    if (n > free) audioDropped += n; else {
      const cm = aCap - 1;
      for (let i = 0; i < n; i++) { const k = ((aWrite + i) & cm) * 2; aSab[k] = src[2 * i]; aSab[k + 1] = src[2 * i + 1]; }
      aWrite = (aWrite + n) | 0; Atomics.store(aCtrl, 0, aWrite); audioFrames += n;
    }
  } else if (aPort) {                                        // MessagePort: a recycled buffer per frame, transferred
    let b = aFree.pop(); if (!b || b.byteLength < n * 4) b = new ArrayBuffer(Math.max(8192, n * 4));
    new Int16Array(b, 0, n * 2).set(src);
    aPort.postMessage({ b, n }, [b]); audioFrames += n;
  }
  M._dsl_audio_clear();
}

// ---- video out
function sendVideo() {
  const seq = M._dsl_video_seq(); if (seq === seqSent) return; seqSent = seq;
  const w = M._dsl_video_w(), h = M._dsl_video_h(), len = w * h * 4;
  if (len !== vlen) { vlen = len; vfree = []; for (let i = 0; i < VPOOL; i++) vfree.push(new ArrayBuffer(len)); }
  const buf = vfree.pop();
  if (!buf) { vdropped++; return; }                          // the page has not given any buffer back: it is behind, skip this picture (the emulation never waits)
  new Uint8Array(buf).set(new Uint8Array(M.HEAPU8.buffer, M._dsl_video_ptr(), len));
  vsubmitted++;
  if (vPort) vPort.postMessage({ buf, w, h, seq: vsubmitted }, [buf]); else post({ t: "frame", buf, w, h, seq: vsubmitted }, [buf]);
}

function runOne() {
  const t0 = performance.now(), alive = M._dsl_run_frame(), dt = performance.now() - t0;
  statEmuMs += dt; if (dt > statMax) statMax = dt; statFrames++; frames++;
  sendAudio(); sendVideo();
  return alive;
}
function tick() {
  timer = 0; if (!started || paused) return;
  let now = performance.now(), ran = 0;
  const late = now - next; if (late > 0) { lateSum += late; if (late > lateMax) lateMax = late; }
  if (late > 200) next = now;                                // fell far behind (the OS throttled the worker): resync instead of fast-forwarding
  while (now >= next && ran < 3) { if (!runOne()) { post({ t: "shutdown" }); started = false; return; } next += frameMs; ran++; now = performance.now(); }
  if (now - statT >= 1000) {
    const sec = (now - statT) / 1000;
    post({ t: "stats", emuFps: statFrames / sec, frameMsAvg: statFrames ? statEmuMs / statFrames : 0, frameMsMax: statMax, tickLateAvgMs: statFrames ? lateSum / statFrames : 0, tickLateMaxMs: lateMax,
      submitted: vsubmitted, droppedAtSource: vdropped, audioFrames, audioDropped, wasmBytes: M.HEAPU8.byteLength, frames });
    statT = now; resetStats();
  }
  schedule();
}
function schedule() { if (!timer && started && !paused) timer = setTimeout(tick, Math.max(0, next - performance.now() - 1)); }

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.t) {
      case "init": await init(); break;
      case "audioPort": aPort = m.port; audioMode = "msg"; aPort.onmessage = (ev) => { const f = ev.data; if (Array.isArray(f)) for (const b of f) if (aFree.length < 16) aFree.push(b); }; break;   // the worklet hands used buffers back
      case "videoPort": vPort = m.port; vPort.onmessage = (ev) => { const b = ev.data && ev.data.recycle; if (b && b.byteLength === vlen && vfree.length < VPOOL) vfree.push(b); }; break;
      case "audioSab": aSab = new Int16Array(m.data); aCtrl = new Int32Array(m.ctrl); aCap = m.cap; aWrite = Atomics.load(aCtrl, 0); audioMode = "sab"; break;
      case "start": startGame(m); break;
      case "buttons": if (started) M._dsl_set_buttons(m.mask); break;
      case "touch": if (started) M._dsl_set_touch(m.d ? 1 : 0, m.x, m.y); break;
      case "recycle": if (m.buf && m.buf.byteLength === vlen && vfree.length < VPOOL) vfree.push(m.buf); break;
      case "pause": paused = true; clearTimeout(timer); timer = 0; takeSram(false); break;
      case "resume": if (started && paused) { paused = false; next = performance.now(); statT = next; resetStats(); schedule(); } break;
      case "save": takeSram(!!m.force); post({ t: "saved", token: m.token }); break;
      case "ping": post({ t: "pong", token: m.token }); break;
      case "stop": paused = true; clearTimeout(timer); timer = 0; takeSram(true); M._dsl_stop(); started = false; post({ t: "stopped" }); break;
      case "log": post({ t: "log", text: M.UTF8ToString(M._dsl_log()) }); M._dsl_log_clear(); break;
    }
  } catch (err) { post({ t: "error", msg: String(err && err.message || err) }); }
};
