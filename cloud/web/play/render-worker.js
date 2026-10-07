// DSLink render worker (OPTIONAL path): owns the game canvas through an OffscreenCanvas, receives the pictures straight from the emulator worker and draws them on its own clock,
// so the page's main thread (touch controls, layout, GC) is not on the video path at all. Used only when the browser offers OffscreenCanvas + WebGL in a worker, and it can
// always be switched off (the main-thread renderer is the default and the automatic fallback). No network.
import { createRenderer } from "./video.js";

let r = null, port = null, queue = [], raf = 0, paused = false, grabReq = false;
let rendered = 0, received = 0, droppedRender = 0, win = { t: performance.now(), frames: 0, msSum: 0, msMax: 0 }, fps = 0, avg = 0, max = 0;
const QUEUE_MAX = 3;
const post = (m, tr) => self.postMessage(m, tr || []);
const hasRaf = typeof requestAnimationFrame === "function";

function draw(f) {
  const t0 = performance.now(), px = new Uint8Array(f.buf);
  r.draw(px, f.w, f.h); rendered++; win.frames++;
  if (grabReq) { grabReq = false; const g = new Uint8Array(px.length); for (let i = 0; i < px.length; i += 4) { g[i] = px[i + 2]; g[i + 1] = px[i + 1]; g[i + 2] = px[i]; g[i + 3] = 255; } post({ t: "grab", data: g.buffer }, [g.buffer]); }
  port.postMessage({ recycle: f.buf }, [f.buf]);
  const ms = performance.now() - t0; win.msSum += ms; if (ms > win.msMax) win.msMax = ms;
}
function loop(t) {
  raf = 0;
  if (!paused && queue.length) draw(queue.shift());
  report(t || performance.now());
  if (hasRaf) raf = requestAnimationFrame(loop);
}
function report(t) {
  if (t - win.t < 1000) return;
  const m = r.metrics; fps = win.frames * 1000 / (t - win.t); avg = win.frames ? win.msSum / win.frames : 0; max = win.msMax;
  post({ t: "metrics", rendered, received, droppedRender, renderFps: fps, mainFrameMsAvg: avg, mainFrameMsMax: max, uploadMsAvg: m.frames ? m.uploadMsSum / m.frames : 0, uploadMsMax: m.uploadMsMax, drawMsAvg: m.frames ? m.drawMsSum / m.frames : 0, drawMsMax: m.drawMsMax, queued: queue.length, mode: r.mode, raf: hasRaf });
  r.resetWindow(); win = { t, frames: 0, msSum: 0, msMax: 0 };
}
function onFrame(f) {
  received++;
  if (paused) { port.postMessage({ recycle: f.buf }, [f.buf]); return; }
  queue.push(f);
  while (queue.length > QUEUE_MAX) { const d = queue.shift(); droppedRender++; port.postMessage({ recycle: d.buf }, [d.buf]); }
  if (!hasRaf && !raf) raf = setTimeout(() => loop(performance.now()), 0);     // no rAF in this worker: draw as pictures arrive (the browser presents them on its own vsync)
}

self.onmessage = (e) => {
  const m = e.data;
  switch (m.t) {
    case "probe": {                                           // the real renderer (WebGL + shaders + one upload and draw) on a throwaway canvas: only a worker that passes is given the game canvas
      let ok = false, why = "";
      try { const c = new OffscreenCanvas(256, 384), rr = createRenderer(c, { observe: false, dpr: 1 }); rr.resize(256, 384, 1); rr.draw(new Uint8Array(256 * 384 * 4), 256, 384); ok = rr.mode.startsWith("webgl"); if (!ok) why = "no WebGL in worker"; rr.destroy(); } catch (err) { why = String(err); }
      post({ t: "probe", ok, why, raf: hasRaf }); break;
    }
    case "init": {
      try { r = createRenderer(m.canvas, { observe: false, dpr: m.dpr }); r.resize(m.w, m.h, m.dpr); port = m.port; port.onmessage = (ev) => { if (ev.data && ev.data.buf) onFrame(ev.data); }; if (hasRaf) raf = requestAnimationFrame(loop); post({ t: "ready", mode: r.mode, raf: hasRaf }); }
      catch (err) { post({ t: "error", msg: String(err && err.message || err) }); }
      break;
    }
    case "size": if (r) r.resize(m.w, m.h, m.dpr); break;
    case "pause": paused = true; for (const f of queue) port.postMessage({ recycle: f.buf }, [f.buf]); queue.length = 0; break;
    case "resume": paused = false; break;
    case "grab": grabReq = true; break;
    case "stop": if (raf && !hasRaf) clearTimeout(raf); if (r) r.destroy(); r = null; post({ t: "stopped" }); break;
  }
};
