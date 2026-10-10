// Developer probe: boots a PS1 disc in the PS1 WebAssembly module inside headless Chrome (no PWA) and prints what the program painted. usage: node ps1_probe.mjs <dir with game.cue/game.bin> [frames]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
const dir = process.argv[2], frames = +(process.argv[3] || 300);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../web/play");
const mime = { ".js": "text/javascript", ".wasm": "application/wasm", ".html": "text/html" };
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split("?")[0]);
  const f = process.env.PS1_CORE_DIR && u.startsWith("/core/ps1/") ? path.join(process.env.PS1_CORE_DIR, u.slice(10)) : u.startsWith("/disc/") ? path.join(dir, u.slice(6)) : path.join(root, u === "/" ? "index.html" : u);
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { "content-type": mime[path.extname(f)] || "application/octet-stream" }); r.end(d); } });
}).listen(0);
const port = srv.address().port;
const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined, headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage();
page.on("console", (m) => console.log("[page]", m.text()));
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://localhost:${port}/?${process.env.ANALOGTEST ? "analog" : ""}`).catch(() => {});
await page.addInitScript(() => { window.__ANALOGTEST = !!(typeof process === "undefined" && location.search.includes("analog")); });
const out = await page.evaluate(async ({ frames, files, analog }) => {
  const create = (await import("/core/ps1/playsphere_ps1.js")).default;
  const M = await create();
  const cstr = (s) => { const n = M.lengthBytesUTF8(s) + 1, p = M._malloc(n); M.stringToUTF8(s, p, n); return p; };
  M.FS.mkdir("/disc"); M.FS.mkdir("/system"); M.FS.mkdir("/saves");
  for (const f of files) M.FS.writeFile("/disc/" + f, new Uint8Array(await (await fetch("/disc/" + encodeURIComponent(f))).arrayBuffer()));
  if (!M._dsl_init(0, 0)) return { error: "init " + M.UTF8ToString(M._dsl_error()) };
  const opts = ['pcsx_rearmed_bios = "HLE"', 'pcsx_rearmed_memcard1 = "libretro"', 'pcsx_rearmed_region = "auto"', 'pcsx_rearmed_analog_combo = "l3+r3"'].join("\n") + "\n";
  const cue = files.find((f) => f.endsWith(".cue")) || files.find((f) => f.endsWith(".chd")) || files.find((f) => f.endsWith(".m3u"));
  const t0 = performance.now();
  if (!M._ps1_start(cstr(opts), cstr("/system"), cstr("/saves"), cstr("/disc/" + cue))) return { error: "start " + M.UTF8ToString(M._dsl_error()), log: M.UTF8ToString(M._dsl_log()) };
  const info = { probe: JSON.parse(M.UTF8ToString(M._ps1_probe(cstr("/disc/" + cue)))), fps: M._dsl_fps(), rate: M._dsl_sample_rate(), core: M.UTF8ToString(M._ps1_core_name()) + " " + M.UTF8ToString(M._ps1_core_version()), discs: M._ps1_disc_count(), sram: M._dsl_sram_size() };
  let audioMax = 0, audioN = 0;
  if (analog) {
    const run = (n) => { for (let i = 0; i < n; i++) M._dsl_run_frame(); };
    const type = () => { const w = M._dsl_video_w(), px = new Uint8Array(M.HEAPU8.buffer, M._dsl_video_ptr(), w * M._dsl_video_h() * 4); const o = (64 * w + 16) * 4; return [px[o + 2], px[o + 1], px[o]].join(','); };
    run(300); const out = { before: type() };
    M._ps1_set_device(0, ((1 + 1) << 8) | 5); run(100); out.afterDevice = type();
    for (let i = 0; i < 8; i++) { M._ps1_set_pad(0, (1 << 14) | (1 << 15), 0, 0, 0, 0); run(1); } M._ps1_set_pad(0, 0, 0, 0, 0, 0); run(100); out.afterCombo = type();
    M._ps1_set_pad(0, 0, 32767, -32768, 0, 0); run(30); const w = M._dsl_video_w(), px = new Uint8Array(M.HEAPU8.buffer, M._dsl_video_ptr(), w * M._dsl_video_h() * 4);
    let n = 0; for (let x = 8; x < 300; x++) { const o = (((98) * w) + x) * 4; if (px[o] > 200 && px[o + 1] < 60) n++; }
    out.lxBarish = n; return out;
  }
  for (let i = 0; i < frames; i++) {
    M._dsl_run_frame();
    const n = M._dsl_audio_frames(); if (n) { const a = new Int16Array(M.HEAP16.buffer, M._dsl_audio_ptr(), n * 2); for (let k = 0; k < a.length; k += 16) audioMax = Math.max(audioMax, Math.abs(a[k])); audioN += n; M._dsl_audio_clear(); }
  }
  const w = M._dsl_video_w(), h = M._dsl_video_h(), px = new Uint8Array(M.HEAPU8.buffer, M._dsl_video_ptr(), w * h * 4);
  const at = (x, y) => { const o = (y * w + x) * 4; return [px[o + 2], px[o + 1], px[o]]; };
  info.video = { w, h, seq: M._dsl_video_seq(), aspect: M._ps1_aspect() };
  info.emuMs = (performance.now() - t0) / frames;
  info.audio = { max: audioMax, frames: audioN };
  info.px = { bg: at(2, 100), header: at(2, 4), pad: at(16, 64), mc: at(16, 158), counter: [0, 1, 2, 3].map((i) => at(15 + i * 16, 177)), disc: [0, 1, 2].map((i) => at(15 + i * 16, 207)), discMark: at(207, 207), frameSq: at(304, 16), stages: [0,1,2,3,4,5,6,7].map((i) => at(12 + i * 12, 230)) };
  info.rowscan = [214,218,222,231,234].map((y) => { let n = 0; for (let x = 0; x < 320; x++) { const o = (y * w + x) * 4; if (!(px[o]==66 && px[o+1]==32 && px[o+2]==33)) n++; } return n; });
  info.log = M.UTF8ToString(M._dsl_log()).slice(-1200);
  return info;
}, { analog: !!process.env.ANALOGTEST, frames, files: fs.readdirSync(dir).filter((f) => /\.(cue|bin|chd|m3u)$/.test(f)) });
console.log(JSON.stringify(out, null, 1));
await browser.close(); srv.close();
