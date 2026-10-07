// Draws the DS picture (256x384 RGBA: top screen over bottom screen) into a canvas. WebGL2 first (Chrome Android, Safari iOS 15+), WebGL1, then Canvas 2D.
// The canvas is the element the frozen touch-controls layout positions; the backing store follows its CSS size so the picture is scaled once, by the GPU.
export function createRenderer(canvas) {
  let gl = null, mode = "2d", ctx2d = null, tex = null, prog = null, w = 256, h = 384, frames = 0, seq = 0, imageData = null;
  const dpr = () => Math.min(2, self.devicePixelRatio || 1);
  const fit = () => {
    const cw = Math.max(1, Math.round(canvas.clientWidth * dpr())), ch = Math.max(1, Math.round(canvas.clientHeight * dpr()));
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; if (gl) gl.viewport(0, 0, cw, ch); }
  };
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fit) : null;
  if (ro) ro.observe(canvas);

  function initGL() {
    const opts = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: "high-performance" };
    gl = canvas.getContext("webgl2", opts); mode = "webgl2";
    if (!gl) { gl = canvas.getContext("webgl", opts) || canvas.getContext("experimental-webgl", opts); mode = "webgl1"; }
    if (!gl) return false;
    const v = "attribute vec2 p;varying vec2 t;void main(){t=vec2((p.x+1.)*.5,1.-(p.y+1.)*.5);gl_Position=vec4(p,0.,1.);}";
    const f = "precision mediump float;varying vec2 t;uniform sampler2D s;void main(){gl_FragColor=texture2D(s,t);}";
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
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.uniform1i(gl.getUniformLocation(prog, "s"), 0);
    return true;
  }
  let ok = false; try { ok = initGL(); } catch { ok = false; gl = null; }
  if (!ok) { gl = null; mode = "2d"; ctx2d = canvas.getContext("2d", { alpha: false }); canvas.width = 256; canvas.height = 384; }
  fit();

  return {
    get mode() { return mode; }, get frames() { return frames; },
    /** @param {ArrayBuffer} buf RGBA bytes, fw x fh */
    draw(buf, fw, fh) {
      frames++;
      if (gl) {
        fit();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        if (fw !== w || fh !== h) { w = fw; h = fh; gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(buf)); }
        else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(buf));
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      } else if (ctx2d) {
        if (!imageData || imageData.width !== fw || imageData.height !== fh) { canvas.width = fw; canvas.height = fh; imageData = ctx2d.createImageData(fw, fh); }
        imageData.data.set(new Uint8ClampedArray(buf)); ctx2d.putImageData(imageData, 0, 0);
      }
    },
    destroy() { if (ro) ro.disconnect(); if (gl) { const e = gl.getExtension("WEBGL_lose_context"); if (e) e.loseContext(); } },
  };
}
