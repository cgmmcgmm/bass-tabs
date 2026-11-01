// Tab playback synth, metronome click, demo audio generation, WAV encoding.

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Play one plucked voice. `glides` = [{ at (s after `when`), midi }] for slides /
 * legato: the pitch moves into each new note over `glideTime` with no new attack.
 */
export function pluck(ctx, dest, when, midi, dur, vel = 0.8, glides = [], glideTime = 0.06) {
  const f = mtof(midi);
  const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
  o1.type = 'sawtooth'; o2.type = 'sine';
  o1.frequency.setValueAtTime(f, when); o2.frequency.setValueAtTime(f, when);
  let prevMidi = midi, prevT = when;
  for (const gl of glides) {
    const t1 = when + gl.at;
    const t0 = Math.max(prevT + 0.005, t1 - glideTime);
    if (t1 <= t0) continue;
    for (const o of [o1, o2]) {
      o.frequency.setValueAtTime(mtof(prevMidi), t0);
      o.frequency.exponentialRampToValueAtTime(mtof(gl.midi), t1);
    }
    prevMidi = gl.midi; prevT = t1;
  }
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.Q.value = 2;
  lp.frequency.setValueAtTime(Math.min(4000, f * 14), when);
  lp.frequency.exponentialRampToValueAtTime(Math.max(120, f * 2.5), when + 0.25);
  const g = ctx.createGain();
  const peak = 0.18 + 0.25 * vel;
  const d = Math.max(0.06, dur);
  const end = when + d;
  // attack -> decay -> sustain -> release, all strictly in time order
  const atk = when + 0.006;
  const decayEnd = Math.min(when + 0.3, Math.max(atk + 0.01, end - 0.03));
  const sustain = peak * Math.pow(0.45, (decayEnd - when) / 0.3); // where the decay curve is at decayEnd
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, atk);
  g.gain.exponentialRampToValueAtTime(sustain, decayEnd);
  g.gain.setValueAtTime(sustain, Math.max(decayEnd, end - 0.03));
  g.gain.exponentialRampToValueAtTime(0.0001, end + 0.03);
  const sub = ctx.createGain(); sub.gain.value = 0.6;
  o1.connect(lp); o2.connect(sub); sub.connect(lp); lp.connect(g); g.connect(dest);
  o1.start(when); o2.start(when); o1.stop(end + 0.05); o2.stop(end + 0.05);
}

export function click(ctx, dest, when, accent) {
  const o = ctx.createOscillator();
  o.frequency.value = accent ? 1800 : 1200;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, when + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  o.connect(g); g.connect(dest);
  o.start(when); o.stop(when + 0.06);
}

/** Karplus-Strong bass riff (original line) for trying the app without a file. */
export function makeDemo(sr = 44100) {
  const bpm = 104;
  const s16 = 60 / bpm / 4;
  // [midi, length in 16ths]; null = rest
  const riff = [
    [28, 2], [28, 2], [40, 2], [28, 2], [31, 2], [33, 2], [35, 2], [28, 2],
    [33, 2], [33, 2], [45, 2], [33, 2], [36, 1], [35, 1], [33, 2], [31, 4],
    [26, 2], [26, 2], [38, 2], [26, 2], [29, 2], [31, 2], [33, 2], [38, 2],
    [35, 3], [35, 1], [null, 2], [35, 2], [36, 2], [38, 2], [39, 4],
  ];
  const seq = [...riff, ...riff.slice(0, 24), [40, 8], [28, 8]];
  const total = seq.reduce((s, [, l]) => s + l, 0) * s16 + 1.5;
  const out = new Float32Array(Math.ceil(total * sr));
  let t = 0.25;
  for (const [m, len] of seq) {
    const dur = len * s16;
    if (m !== null) {
      const f = mtof(m);
      const N = Math.max(2, Math.round(sr / f - 0.5));
      const buf = new Float32Array(N);
      let prev = 0;
      for (let i = 0; i < N; i++) { const r = Math.random() * 2 - 1; prev = 0.5 * prev + 0.5 * r; buf[i] = prev; }
      const start = Math.floor(t * sr);
      const ring = Math.floor((dur * 0.92) * sr);
      const len2 = ring + Math.floor(0.03 * sr);
      let idx = 0;
      for (let i = 0; i < len2 && start + i < out.length; i++) {
        const a = buf[idx], b = buf[(idx + 1) % N];
        const damp = i > ring ? 0.9 : 0.998;
        buf[idx] = damp * 0.5 * (a + b);
        out[start + i] += a * 0.6;
        idx = (idx + 1) % N;
      }
    }
    t += dur;
  }
  // slight normalization
  let mx = 0;
  for (const v of out) mx = Math.max(mx, Math.abs(v));
  for (let i = 0; i < out.length; i++) out[i] = (out[i] / (mx || 1)) * 0.8;
  return { samples: out, drums: makeDrums(out.length, sr, bpm, 0.25), sr, bpm };
}

export function encodeWav(samples, sr) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Simple synthetic drum stem (kick, snare, hi-hat) to go with the demo. */
function makeDrums(len, sr, bpm, start) {
  const out = new Float32Array(len);
  const beat = 60 / bpm;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const add = (t, fn, dur) => {
    const s0 = Math.floor(t * sr), n = Math.floor(dur * sr);
    for (let i = 0; i < n && s0 + i < len; i++) out[s0 + i] += fn(i / sr);
  };
  const kick = (t) => Math.sin(2 * Math.PI * (45 * t + 40 * (1 - Math.exp(-t * 30)))) * Math.exp(-t * 9) * 0.9;
  const snare = (t) => (rnd() * 0.6 + Math.sin(2 * Math.PI * 185 * t) * 0.4) * Math.exp(-t * 18) * 0.6;
  let prev = 0;
  const hat = (t) => { const x = rnd(); const y = x - prev; prev = x; return y * Math.exp(-t * 60) * 0.18; };
  const bars = Math.floor((len / sr - start) / (4 * beat));
  for (let b = 0; b < bars; b++) {
    const t0 = start + b * 4 * beat;
    add(t0, kick, 0.5); add(t0 + 2 * beat, kick, 0.5); add(t0 + 2.5 * beat, kick, 0.5);
    add(t0 + beat, snare, 0.3); add(t0 + 3 * beat, snare, 0.3);
    for (let e = 0; e < 8; e++) add(t0 + e * beat / 2, hat, 0.08);
  }
  let mx = 0;
  for (const v of out) mx = Math.max(mx, Math.abs(v));
  for (let i = 0; i < len; i++) out[i] = (out[i] / (mx || 1)) * 0.8;
  return out;
}
