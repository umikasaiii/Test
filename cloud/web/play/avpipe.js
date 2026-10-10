// Worker side of the audio / video hand-off to the page, shared by the emulator workers of the cores that came after the DS one (the DS worker keeps its own copy: it is frozen).
// Video leaves through a small pool of reused buffers (nothing is allocated per frame once warm), audio goes straight to the AudioWorklet: into a SharedArrayBuffer ring when the
// page is cross-origin isolated, else through a MessagePort with recycled buffers. The emulation never waits for the page.
export function createAvPipe({ post, getM }) {
  const VPOOL = 4;
  const s = { vfree: [], vlen: 0, vsubmitted: 0, vdropped: 0, seqSent: 0, vPort: null, aPort: null, aFree: [], aSab: null, aCtrl: null, aCap: 0, aWrite: 0, audioFrames: 0, audioDropped: 0, audioMode: "none" };
  return {
    s,
    audioPort(port) { s.aPort = port; s.audioMode = "msg"; port.onmessage = (ev) => { const f = ev.data; if (Array.isArray(f)) for (const b of f) if (s.aFree.length < 16) s.aFree.push(b); }; },
    videoPort(port) { s.vPort = port; port.onmessage = (ev) => { const b = ev.data && ev.data.recycle; if (b && b.byteLength === s.vlen && s.vfree.length < VPOOL) s.vfree.push(b); }; },
    audioSab(m) { s.aSab = new Int16Array(m.data); s.aCtrl = new Int32Array(m.ctrl); s.aCap = m.cap; s.aWrite = Atomics.load(s.aCtrl, 0); s.audioMode = "sab"; },
    recycle(buf) { if (buf && buf.byteLength === s.vlen && s.vfree.length < VPOOL) s.vfree.push(buf); },
    sendAudio() {
      const M = getM();
      const n = M._dsl_audio_frames(); if (n <= 0) { M._dsl_audio_clear(); return; }
      const src = new Int16Array(M.HEAP16.buffer, M._dsl_audio_ptr(), n * 2);
      if (s.aSab) {
        const free = s.aCap - ((s.aWrite - Atomics.load(s.aCtrl, 1)) | 0);
        if (n > free) s.audioDropped += n; else {
          const cm = s.aCap - 1;
          for (let i = 0; i < n; i++) { const k = ((s.aWrite + i) & cm) * 2; s.aSab[k] = src[2 * i]; s.aSab[k + 1] = src[2 * i + 1]; }
          s.aWrite = (s.aWrite + n) | 0; Atomics.store(s.aCtrl, 0, s.aWrite); s.audioFrames += n;
        }
      } else if (s.aPort) {
        let b = s.aFree.pop(); if (!b || b.byteLength < n * 4) b = new ArrayBuffer(Math.max(8192, n * 4));
        new Int16Array(b, 0, n * 2).set(src);
        s.aPort.postMessage({ b, n }, [b]); s.audioFrames += n;
      }
      M._dsl_audio_clear();
    },
    sendVideo() {
      const M = getM();
      const seq = M._dsl_video_seq(); if (seq === s.seqSent) return; s.seqSent = seq;
      const w = M._dsl_video_w(), h = M._dsl_video_h(), len = w * h * 4;
      if (len === 0) return;
      if (len !== s.vlen) { s.vlen = len; s.vfree = []; for (let i = 0; i < VPOOL; i++) s.vfree.push(new ArrayBuffer(len)); }
      const buf = s.vfree.pop();
      if (!buf) { s.vdropped++; return; }                          // the page is behind: skip this picture
      new Uint8Array(buf).set(new Uint8Array(M.HEAPU8.buffer, M._dsl_video_ptr(), len));
      s.vsubmitted++;
      if (s.vPort) s.vPort.postMessage({ buf, w, h, seq: s.vsubmitted }, [buf]); else post({ t: "frame", buf, w, h, seq: s.vsubmitted }, [buf]);
    },
  };
}
