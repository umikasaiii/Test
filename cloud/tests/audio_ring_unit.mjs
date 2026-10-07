// Unit test of the audio ring/resampler/adaptive buffer (the logic the AudioWorklet and the ScriptProcessor fallback share). Deterministic: a fake clock, a fake 48 kHz sink and a fake DS producer.
import { AudioRing } from '../web/play/audio-worklet.js';
const results = []; const check = (n, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -> ' + d : ''}`); };
const OUT = 48000, Q = 128, SRC = 32768;

// sim: producer sends `fpsHz` frames per second (546.13 stereo samples each, a 440 Hz tone) with optional stalls; consumer pulls 128-sample quanta.
function sim({ seconds, fpsHz = 59.8261, stalls = [], outRate = OUT, startMs, burst = null }) {
  let t = 0; const ring = new AudioRing({ srcRate: SRC, outRate, now: () => t, startMs });
  const L = new Float32Array(Q), R = new Float32Array(Q); const perFrame = SRC / 59.8261; let acc = 0, phase = 0, nextFrame = 0, maxJump = 0, last = 0, played = 0, minFill = 1e9;
  const buf = new Int16Array(2048); const inStall = (x) => stalls.some(([a, b]) => x >= a && x < b);
  const dt = Q / outRate;
  while (t < seconds) {
    while (nextFrame <= t) {                                       // the producer's frames due by now (held back during a stall, then delivered together)
      if (inStall(nextFrame)) { nextFrame = stalls.find(([a, b]) => nextFrame >= a && nextFrame < b)[1]; break; }
      acc += perFrame; const n = acc | 0; acc -= n;
      for (let i = 0; i < n; i++) { const v = Math.round(Math.sin(phase) * 12000); phase += 2 * Math.PI * 440 / SRC; buf[2 * i] = v; buf[2 * i + 1] = v; }
      ring.push(buf, n); nextFrame += 1 / fpsHz;
    }
    if (burst && t >= burst.at && !burst.done) { burst.done = true; for (let k = 0; k < burst.frames; k++) { for (let i = 0; i < 546; i++) { buf[2 * i] = 0; buf[2 * i + 1] = 0; } ring.push(buf, 546); } }
    ring.render(L, R, Q); t += dt;
    for (let i = 0; i < Q; i++) { const d = Math.abs(L[i] - last); const sec = ring.metrics().secondsSinceUnderrun; if (ring.metrics().state === 'run' && (sec < 0 || sec > 0.1) && t > 2) maxJump = Math.max(maxJump, d); last = L[i]; }
    played += Q; if (t > 5) minFill = Math.min(minFill, ring.metrics().fillMs);
  }
  return { ring, m: ring.metrics(), maxJump, minFill };
}

let r = sim({ seconds: 120 });
check('steady state (emulator 59.83 fps vs 48 kHz sink), 120 s: no underrun, no overrun', r.m.underEvents === 0 && r.m.overruns === 0, JSON.stringify({ ev: r.m.underEvents, over: r.m.overruns }));
check('the buffer settles near its target (100 ms start, may shrink slowly to 70 ms)', r.m.fillMs > 40 && r.m.fillMs < 140, `fill ${r.m.fillMs.toFixed(0)} ms, target ${r.m.targetMs.toFixed(0)} ms`);
check('no clicks: sample-to-sample steps of the 440 Hz tone stay small (a 440 Hz tone at 12000/32768 steps at most 0.034)', r.maxJump < 0.045, `max step ${r.maxJump.toFixed(4)}`);
check('the buffer never runs close to empty in steady state', r.minFill > 25, `lowest fill ${r.minFill.toFixed(0)} ms`);
r = sim({ seconds: 120, fpsHz: 59.8261 * 1.003 });
check('emulator 0.3 % FAST (clock drift): the controller absorbs it (no underrun, no overrun, bounded fill)', r.m.underEvents === 0 && r.m.overruns === 0 && r.m.fillMs < 200, `fill ${r.m.fillMs.toFixed(0)} ms, rate adj ${r.m.rateAdjPpm.toFixed(0)} ppm`);
r = sim({ seconds: 120, fpsHz: 59.8261 * 0.997 });
check('emulator 0.3 % SLOW: no underrun after the start, bounded fill', r.m.underEvents === 0 && r.m.fillMs > 20, `fill ${r.m.fillMs.toFixed(0)} ms, rate adj ${r.m.rateAdjPpm.toFixed(0)} ppm`);
r = sim({ seconds: 120, outRate: 44100 });
check('44.1 kHz device: same stability', r.m.underEvents === 0 && r.m.overruns === 0);

r = sim({ seconds: 60, stalls: [[10, 10.3]] });
check('a 300 ms stall bigger than the buffer: exactly ONE dropout event (not hundreds of samples counted as events)', r.m.underEvents === 1 && r.m.underSamples > 0, `events ${r.m.underEvents}, silent samples ${r.m.underSamples}`);
check('after the dropout the target grew (adaptive), and the stream recovered', r.m.state === 'run', `target now ${r.m.targetMs.toFixed(0)} ms, state ${r.m.state}`);
const grown = sim({ seconds: 11, stalls: [[10, 10.3]] }).m.targetMs;
check('adaptive target grows after an underrun (x1.35)', grown > 120, `${grown.toFixed(0)} ms`);
r = sim({ seconds: 140, stalls: [[10, 10.3]] });
check('...and shrinks back gradually while stable (towards 70 ms)', r.m.targetMs < grown - 10 && r.m.targetMs >= 70, `${grown.toFixed(0)} -> ${r.m.targetMs.toFixed(0)} ms after 130 s of stability`);
r = sim({ seconds: 14, stalls: [[10, 10.3]] });
check('under10s counts the recent dropout and forgets it after 10 s', r.m.under10s === 1 && sim({ seconds: 25, stalls: [[10, 10.3]] }).m.under10s === 0, `at 14 s: ${r.m.under10s}`);
r = sim({ seconds: 6, stalls: [[3, 3.08]] });
check('a short 80 ms hiccup is hidden by the 100 ms buffer (no event)', r.m.underEvents === 0, `events ${r.m.underEvents}`);

r = sim({ seconds: 20, burst: { at: 5, frames: 120 } });
check('a flood (2 s of audio at once): bounded by the overrun guard, counted once, stream stays up', r.m.overruns >= 1 && r.m.underEvents === 0 && r.m.fillMs < 400, `overruns ${r.m.overruns}, dropped ${r.m.overDropped} frames, fill ${r.m.fillMs.toFixed(0)} ms`);
// reset (resume from background): refills before playing, no events counted as underruns
{ let t = 0; const ring = new AudioRing({ srcRate: SRC, outRate: OUT, now: () => t }); const L = new Float32Array(Q), R = new Float32Array(Q), b = new Int16Array(2048);
  for (let i = 0; i < 80; i++) { ring.push(b, 546); ring.render(L, R, Q); t += Q / OUT; }
  ring.reset(); for (let i = 0; i < 20; i++) { ring.render(L, R, Q); t += Q / OUT; }
  check('flush (resume from background): silence while the buffer refills is NOT an underrun', ring.metrics().underEvents === 0 && ring.metrics().state === 'prime'); }
const ok = results.filter(Boolean).length; console.log(`${ok}/${results.length} checks passed`); process.exit(ok === results.length ? 0 : 1);
