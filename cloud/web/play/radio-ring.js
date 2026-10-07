// Receive side of the DS radio inside the emulator worker.
//
// The melonDS core waits for the other console's answers by SPINNING inside the emulation call (net/mp.cpp NextPacketBlock, up to 25 ms, calling the bridge's poll() in a tight loop).
// A worker cannot receive a message while it spins, so frames that arrive from the network must already be readable without the event loop:
//   - SharedArrayBuffer ring (page is cross-origin isolated): the page (producer) writes, the worker (consumer) reads synchronously - this is the path real multiplayer games need.
//   - message queue (no SAB): frames are queued when the worker's event loop runs, i.e. between frames. Enough for plain radio traffic (the homebrew test), NOT for games whose
//     protocol waits for replies inside a frame; the page tells the user.
// Record layout in the ring: [u32 length of what follows][f64 enqueue time ms (epoch)][u16 dest][u16 src][payload]. The pop() contract is the one webrtc_link.cpp expects:
// it fills dst with [dest u16][src u16][payload] and returns that length.

export const epochMs = () => performance.timeOrigin + performance.now();   // one absolute clock for every thread (lag measurements across main thread and worker)
export const RING_BYTES = 1 << 18;               // 256 KiB: ~250 ms of the busiest DS traffic
const HDR = 4 + 8;                               // length + timestamp ahead of dest/src/payload

export function createSharedRadio() {
  const ctrl = new SharedArrayBuffer(32), data = new SharedArrayBuffer(RING_BYTES);   // ctrl: [w, r, dropped, state, bytesIn, framesIn, reserved...] as Int32
  return { ctrl, data };
}

/** producer: the page (main thread) */
export class RadioRxProducer {
  constructor(shared) { this.c = new Int32Array(shared.ctrl); this.d = new Uint8Array(shared.data); this.mask = RING_BYTES - 1; this.dv = new DataView(shared.data); this.tmp = new Uint8Array(8); }
  /** drop everything not yet read (after a pause: stale radio frames are never replayed). Only called while the consumer is not running. */
  flush() { Atomics.store(this.c, 1, Atomics.load(this.c, 0)); }
  setState(s) { Atomics.store(this.c, 3, s); }                       // 0 connecting, 1 open, 2 closed
  get dropped() { return Atomics.load(this.c, 2); }
  get fillBytes() { return (Atomics.load(this.c, 0) - Atomics.load(this.c, 1)) | 0; }
  push(dest, src, payload /* Uint8Array */, atMs) {
    const need = HDR + 4 + payload.length, w = Atomics.load(this.c, 0), r = Atomics.load(this.c, 1);
    if (RING_BYTES - ((w - r) | 0) < need + 8) { Atomics.add(this.c, 2, 1); return false; }   // the consumer is far behind: this (old) frame is dropped
    const d = this.d, m = this.mask; let p = w;
    const put8 = (v) => { d[p & m] = v; p++; };
    const len = 8 + 4 + payload.length;                               // timestamp + dest/src + payload
    put8(len & 255); put8((len >> 8) & 255); put8((len >> 16) & 255); put8((len >>> 24) & 255);
    new DataView(this.tmp.buffer).setFloat64(0, atMs, true); for (let i = 0; i < 8; i++) put8(this.tmp[i]);
    put8(dest & 255); put8((dest >> 8) & 255); put8(src & 255); put8((src >> 8) & 255);
    for (let i = 0; i < payload.length; i++) { d[p & m] = payload[i]; p++; }
    Atomics.store(this.c, 0, p | 0);                                  // publish
    Atomics.add(this.c, 5, 1);
    return true;
  }
}

/** consumer: the emulator worker. Exposes the three hooks webrtc_link.cpp calls. */
export function workerRadioFromShared(shared, postTx, lagStats) {
  const c = new Int32Array(shared.ctrl), d = new Uint8Array(shared.data), m = RING_BYTES - 1, dv = new DataView(new ArrayBuffer(8)), t8 = new Uint8Array(dv.buffer);
  return {
    mode: "sab",
    state: () => Atomics.load(c, 3),
    tx: (dest, src, ptr, n, heap) => postTx(dest, src, heap.slice(ptr, ptr + n)),
    pop(dst, cap, heap) {
      const w = Atomics.load(c, 0); let r = Atomics.load(c, 1);
      if (r === w) return 0;
      const len = d[r & m] | d[(r + 1) & m] << 8 | d[(r + 2) & m] << 16 | d[(r + 3) & m] << 24;
      let p = r + 4;
      for (let i = 0; i < 8; i++) t8[i] = d[(p + i) & m]; p += 8;
      const out = len - 8;
      if (out > cap) { Atomics.store(c, 1, (p + out) | 0); return 0; }  // cannot fit: skip it
      for (let i = 0; i < out; i++) heap[dst + i] = d[(p + i) & m];
      Atomics.store(c, 1, (p + out) | 0);
      if (lagStats) lagStats(epochMs() - dv.getFloat64(0, true));
      return out;
    },
  };
}

/** consumer without SharedArrayBuffer: the page posts frames, the worker queues them when its event loop runs */
export function workerRadioFromMessages(postTx, lagStats) {
  const q = []; let state = 0;
  return {
    mode: "msg",
    onMessage(m) { if (m.t === "radioRx") q.push({ buf: new Uint8Array(m.buf), at: m.at }); else if (m.t === "radioState") state = m.state; else if (m.t === "radioFlush") q.length = 0; },
    state: () => state,
    tx: (dest, src, ptr, n, heap) => postTx(dest, src, heap.slice(ptr, ptr + n)),
    pop(dst, cap, heap) {
      const f = q.shift(); if (!f) return 0;
      if (f.buf.length > cap) return 0;
      heap.set(f.buf, dst); if (lagStats) lagStats(epochMs() - f.at);
      return f.buf.length;
    },
  };
}
