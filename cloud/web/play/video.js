// Draws the DS picture (256x384, top screen over bottom screen) into a canvas. WebGL2 first (Chrome Android, Safari iOS 15+), WebGL1, then Canvas 2D.
// The core delivers XRGB8888 (bytes B,G,R,X): it is uploaded as-is and the fragment shader swaps the channels, so neither the WebAssembly thread nor the page loops over pixels.
// The canvas is the element the frozen touch-controls layout positions; its backing store follows its CSS size (a ResizeObserver, never a per-frame layout read).
export function createRenderer(canvas, { observe = true, dpr: dprFixed = 0 } = {}) {   // observe=false: the owner calls resize() (OffscreenCanvas in a worker has no layout)
  let gl = null, mode = "2d", ctx2d = null, tex = null, prog = null, w = 256, h = 384, imageData = null, sized = false;
  const m = { frames: 0, uploadMsSum: 0, uploadMsMax: 0, drawMsSum: 0, drawMsMax: 0 };
  let cssW = 0, cssH = 0;
  let dprNow = dprFixed;
  const dpr = () => Math.min(2, dprNow || self.devicePixelRatio || 1);
  const fit = () => {
    const cw = Math.max(1, Math.round(cssW * dpr())), ch = Math.max(1, Math.round(cssH * dpr()));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; if (gl) gl.viewport(0, 0, cw, ch); }
    sized = true;
  };
  const ro = observe && typeof ResizeObserver !== "undefined" ? new ResizeObserver((es) => { const r = es[0].contentRect; cssW = r.width; cssH = r.height; fit(); }) : null;
  if (ro) ro.observe(canvas); else if (observe) { cssW = canvas.clientWidth; cssH = canvas.clientHeight; }

  function initGL() {
    const opts = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance" };
    gl = canvas.getContext("webgl2", opts); mode = "webgl2";
    if (!gl) { gl = canvas.getContext("webgl", opts) || canvas.getContext("experimental-webgl", opts); mode = "webgl1"; }
    if (!gl) return false;
    const v = "attribute vec2 p;varying vec2 t;void main(){t=vec2((p.x+1.)*.5,1.-(p.y+1.)*.5);gl_Position=vec4(p,0.,1.);}";
    const f = "precision mediump float;varying vec2 t;uniform sampler2D s;void main(){vec4 c=texture2D(s,t);gl_FragColor=vec4(c.b,c.g,c.r,1.);}";   // B,G,R,X -> R,G,B,1
    const sh = (type, src) => { const o = gl.createShader(type); gl.shaderSource(o, src); gl.compileShader(o); if (!gl.getShaderParameter(o, gl.COMPILE_STATUS)) throw new Error("shader"); return o; };
    prog = gl.createProgram(); gl.attachShader(prog, sh(gl.VERTEX_SHADER, v)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, f)); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error("link");
    gl.useProgram(prog);
    const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p"); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);   // storage once; every frame is a sub-image upload
    gl.uniform1i(gl.getUniformLocation(prog, "s"), 0);
    return true;
  }
  let ok = false; try { ok = initGL(); } catch { ok = false; gl = null; }
  if (!ok) { gl = null; mode = "2d"; ctx2d = canvas.getContext("2d", { alpha: false }); canvas.width = 256; canvas.height = 384; }
  else if (!ro && observe) fit();

  return {
    get mode() { return mode; }, metrics: m,
    resize(w, h, dpr) { cssW = w; cssH = h; if (dpr) dprNow = dpr; fit(); },
    /** @param {Uint8Array} px bytes B,G,R,X of a fw x fh picture */
    draw(px, fw, fh) {
      m.frames++;
      if (gl) {
        if (!sized) fit();
        const t0 = performance.now();
        if (fw !== w || fh !== h) { w = fw; h = fh; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, px); }
        else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const t1 = performance.now();
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        const t2 = performance.now(), up = t1 - t0, dr = t2 - t1;
        m.uploadMsSum += up; m.drawMsSum += dr; if (up > m.uploadMsMax) m.uploadMsMax = up; if (dr > m.drawMsMax) m.drawMsMax = dr;
      } else if (ctx2d) {
        const t0 = performance.now();
        if (!imageData || imageData.width !== fw || imageData.height !== fh) { canvas.width = fw; canvas.height = fh; imageData = ctx2d.createImageData(fw, fh); }
        const d = imageData.data; for (let i = 0; i < d.length; i += 4) { d[i] = px[i + 2]; d[i + 1] = px[i + 1]; d[i + 2] = px[i]; d[i + 3] = 255; }   // B,G,R,X -> R,G,B,A (fallback only)
        ctx2d.putImageData(imageData, 0, 0);
        const dt = performance.now() - t0; m.drawMsSum += dt; if (dt > m.drawMsMax) m.drawMsMax = dt;
      }
    },
    resetWindow() { m.uploadMsSum = m.drawMsSum = 0; m.uploadMsMax = m.drawMsMax = 0; m.frames = 0; },
    destroy() { if (ro) ro.disconnect(); if (gl) { const e = gl.getExtension("WEBGL_lose_context"); if (e) e.loseContext(); } },
  };
}
