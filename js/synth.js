// Tab playback synth, metronome click, demo audio generation, WAV encoding.

export const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

/**
 * Tab synth sound presets.
 * osc: [waveform, level, detune cents]; lp: low-pass start/end (multiples of the note
 * frequency), sweep time, resonance; decay: seconds to reach `sustain` (fraction of peak);
 * noise: level of a short attack click (pick / slap).
 */
export const SYNTH_PRESETS = {
  finger: { label: 'Finger (warm)', gm: 33, osc: [['sawtooth', 1, 0], ['sine', 0.6, 0]],
    lp: [14, 2.5, 0.25, 2], max: 4000, decay: 0.3, sustain: 0.45, noise: 0 },
  pick: { label: 'Pick (bright)', gm: 34, osc: [['sawtooth', 1, 0], ['square', 0.25, 0], ['sine', 0.5, 0]],
    lp: [30, 6, 0.2, 1.5], max: 7000, decay: 0.25, sustain: 0.4, noise: 0.25 },
  slap: { label: 'Slap (punchy)', gm: 37, osc: [['sawtooth', 1, 0], ['sawtooth', 0.6, 7], ['sine', 0.7, 0]],
    lp: [45, 4, 0.1, 4], max: 9000, decay: 0.12, sustain: 0.3, noise: 0.45 },
  synth: { label: 'Synth bass', gm: 39, osc: [['square', 0.8, 0], ['sawtooth', 0.6, -8], ['sine', 0.8, -1200]],
    lp: [20, 3, 0.35, 9], max: 5000, decay: 0.4, sustain: 0.7, noise: 0 },
  muted: { label: 'Muted (palm mute)', gm: 33, osc: [['triangle', 1, 0], ['sine', 0.8, 0]],
    lp: [5, 1.6, 0.08, 1], max: 1500, decay: 0.12, sustain: 0.08, noise: 0.05 },
  sub: { label: 'Sub (pure)', gm: 33, osc: [['sine', 1, 0], ['triangle', 0.25, 0]],
    lp: [8, 8, 0.1, 0.7], max: 3000, decay: 0.5, sustain: 0.8, noise: 0 },
};

let noiseBuf = null;
function noise(ctx) {
  if (!noiseBuf || noiseBuf.sampleRate !== ctx.sampleRate) {
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.05), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * 0.008));
  }
  return noiseBuf;
}

/**
 * Play one plucked voice. `glides` = [{ at (s after `when`), midi }] for slides /
 * legato: the pitch moves into each new note over `glideTime` with no new attack.
 */
export function pluck(ctx, dest, when, midi, dur, vel = 0.8, glides = [], glideTime = 0.06, preset = 'finger') {
  const P = SYNTH_PRESETS[preset] || SYNTH_PRESETS.finger;
  const f = mtof(midi);
  const d = Math.max(0.06, dur);
  const end = when + d;

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass'; lp.Q.value = P.lp[3];
  lp.frequency.setValueAtTime(Math.min(P.max, f * P.lp[0]), when);
  lp.frequency.exponentialRampToValueAtTime(Math.max(80, Math.min(P.max, f * P.lp[1])), when + P.lp[2]);

  const oscs = P.osc.map(([type, level, cents]) => {
    const o = ctx.createOscillator();
    o.type = type; o.detune.value = cents;
    o.frequency.setValueAtTime(f, when);
    const g = ctx.createGain(); g.gain.value = level / P.osc.length * 1.6;
    o.connect(g); g.connect(lp);
    return o;
  });
  let prevMidi = midi, prevT = when;
  for (const gl of glides) {
    const t1 = when + gl.at;
    const t0 = Math.max(prevT + 0.005, t1 - glideTime);
    if (t1 <= t0) continue;
    for (const o of oscs) {
      o.frequency.setValueAtTime(mtof(prevMidi), t0);
      o.frequency.exponentialRampToValueAtTime(mtof(gl.midi), t1);
    }
    prevMidi = gl.midi; prevT = t1;
  }

  const g = ctx.createGain();
  const peak = 0.18 + 0.25 * vel;
  // attack -> decay -> sustain -> release, all strictly in time order
  const atk = when + 0.006;
  const decayEnd = Math.min(when + P.decay, Math.max(atk + 0.01, end - 0.03));
  const sustain = peak * Math.pow(P.sustain, (decayEnd - when) / P.decay); // where the decay curve is at decayEnd
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, atk);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, sustain), decayEnd);
  g.gain.setValueAtTime(Math.max(0.0002, sustain), Math.max(decayEnd, end - 0.03));
  g.gain.exponentialRampToValueAtTime(0.0001, end + 0.03);
  lp.connect(g); g.connect(dest);

  if (P.noise > 0) { // attack click (pick / slap)
    const n = ctx.createBufferSource(); n.buffer = noise(ctx);
    const hp = ctx.createBiquadFilter(); hp.type = 'bandpass'; hp.frequency.value = 2500; hp.Q.value = 0.8;
    const ng = ctx.createGain(); ng.gain.value = P.noise * (0.5 + vel);
    n.connect(hp); hp.connect(ng); ng.connect(dest);
    n.start(when);
  }
  for (const o of oscs) { o.start(when); o.stop(end + 0.05); }
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

/** 16-bit PCM WAV from one Float32Array (mono) or an array of channels. */
export function encodeWav(samples, sr) {
  const ch = Array.isArray(samples) ? samples : [samples];
  const nc = ch.length, len = ch[0].length;
  const buf = new ArrayBuffer(44 + len * nc * 2);
  const v = new DataView(buf);
  const w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + len * nc * 2, true); w(8, 'WAVE');
  w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nc, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nc * 2, true); v.setUint16(32, nc * 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, len * nc * 2, true);
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nc; c++) {
      const x = Math.max(-1, Math.min(1, ch[c][i]));
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true); o += 2;
    }
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
