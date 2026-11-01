// Turns frame features into notes, estimates tempo, quantizes and maps to frets.

export const TUNINGS = {
  std4: { name: 'Standard 4-string (E A D G)', strings: [28, 33, 38, 43] },
  drop4: { name: 'Drop D (D A D G)', strings: [26, 33, 38, 43] },
  eb4: { name: 'Half-step down (Eb Ab Db Gb)', strings: [27, 32, 37, 42] },
  d4: { name: 'Whole-step down (D G C F)', strings: [26, 31, 36, 41] },
  std5: { name: '5-string (B E A D G)', strings: [23, 28, 33, 38, 43] },
  std6: { name: '6-string (B E A D G C)', strings: [23, 28, 33, 38, 43, 48] },
};

const NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
export const noteName = (m, octave = true) =>
  NAMES[((m % 12) + 12) % 12] + (octave ? Math.floor(m / 12) - 1 : '');

function percentile(arr, p) {
  const a = Float32Array.from(arr).sort();
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))))] || 0;
}

function median(vals) {
  const a = vals.slice().sort((x, y) => x - y);
  const n = a.length;
  return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
}

/** Normalized onset envelope from spectral flux. */
function onsetEnvelope(flux) {
  const ref = percentile(flux, 0.97) || 1;
  const env = new Float32Array(flux.length);
  for (let i = 0; i < flux.length; i++) env[i] = Math.min(2, flux[i] / ref);
  return env;
}

function detectOnsets(env, hopTime, sensitivity) {
  const w = Math.round(0.15 / hopTime);
  // default (0.55) -> 0.30; 0 -> only very strong attacks; 1 -> very eager
  const delta = sensitivity >= 0.55
    ? 0.3 - ((sensitivity - 0.55) / 0.45) * 0.15
    : 0.3 + ((0.55 - sensitivity) / 0.55) * 0.6;
  const minGap = Math.round(0.075 / hopTime);
  const out = [];
  let last = -Infinity;
  // running mean via prefix sums
  const pre = new Float64Array(env.length + 1);
  for (let i = 0; i < env.length; i++) pre[i + 1] = pre[i] + env[i];
  for (let i = 1; i < env.length - 1; i++) {
    const v = env[i];
    if (v < delta) continue;
    let isMax = true;
    for (let j = Math.max(0, i - 3); j <= Math.min(env.length - 1, i + 3); j++) {
      if (env[j] > v) { isMax = false; break; }
    }
    if (!isMax) continue;
    const a = Math.max(0, i - w), b = Math.min(env.length, i + w + 1);
    const mean = (pre[b] - pre[a]) / (b - a);
    if (v >= mean + delta && i - last >= minGap) { out.push(i); last = i; }
  }
  return out;
}

/**
 * Segment features into notes.
 * opts: { sensitivity 0..1, minNoteMs, minConf 0..1, gateDb (negative) }
 */
export function segmentNotes(feat, opts) {
  const { f0, conf, rms, flux, hopTime } = feat;
  const n = f0.length;
  const ref = percentile(rms, 0.99) || 1e-9;
  const gate = ref * Math.pow(10, opts.gateDb / 20);

  let midi = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    midi[i] = f0[i] > 20 && conf[i] >= opts.minConf && rms[i] >= gate
      ? 69 + 12 * Math.log2(f0[i] / 440) : NaN;
  }

  // Global tuning deviation (instrument not tuned to A440).
  const hist = new Float64Array(100);
  for (let i = 0; i < n; i++) {
    const m = midi[i];
    if (Number.isNaN(m)) continue;
    const dev = m - Math.round(m);
    hist[Math.min(99, Math.floor((dev + 0.5) * 100))] += rms[i];
  }
  let bestBin = 50, bestVal = -1;
  for (let b = 0; b < 100; b++) {
    let s = 0;
    for (let k = -5; k <= 5; k++) s += hist[(b + k + 100) % 100];
    if (s > bestVal) { bestVal = s; bestBin = b; }
  }
  const tuningShift = (bestBin + 0.5) / 100 - 0.5;
  if (Math.abs(tuningShift) > 0.04) for (let i = 0; i < n; i++) midi[i] -= tuningShift;

  // NaN-aware median filter (5 frames).
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(midi[i])) { sm[i] = NaN; continue; }
    const w = [];
    for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < n && !Number.isNaN(midi[j])) w.push(midi[j]);
    sm[i] = median(w);
  }
  midi = sm;

  // Voiced regions (close tiny gaps).
  const gapFrames = Math.max(1, Math.round(0.03 / hopTime));
  const minFrames = Math.max(2, Math.round(0.04 / hopTime));
  const regions = [];
  let rs = -1, lastV = -1;
  for (let i = 0; i <= n; i++) {
    const v = i < n && !Number.isNaN(midi[i]);
    if (v) {
      if (rs < 0) rs = i;
      else if (i - lastV > gapFrames) {
        if (lastV + 1 - rs >= minFrames) regions.push([rs, lastV + 1]);
        rs = i;
      }
      lastV = i;
    }
  }
  if (rs >= 0 && lastV + 1 - rs >= minFrames) regions.push([rs, lastV + 1]);

  const env = onsetEnvelope(flux);
  const onsets = detectOnsets(env, hopTime, opts.sensitivity);

  const near = Math.round(0.08 / hopTime);
  const settle = Math.round(0.05 / hopTime);
  const lagMax = 0.15 / hopTime;
  const minRun = Math.max(2, Math.round(0.07 / hopTime)); // min length of a pitch change without a new attack
  const notes = [];

  const process = (s, e, fromOnset) => {
    let idx = [];
    for (let j = s + settle; j < e; j++) if (!Number.isNaN(midi[j])) idx.push(j);
    if (idx.length < 2) {
      idx = [];
      for (let j = s; j < e; j++) if (!Number.isNaN(midi[j])) idx.push(j);
    }
    if (!idx.length) return;
    // Runs of constant rounded pitch -> legato splits.
    let runs = [];
    for (const j of idx) {
      const p = Math.round(midi[j]);
      const r = runs[runs.length - 1];
      if (r && r.p === p) { r.to = j + 1; r.vals.push(midi[j]); }
      else runs.push({ p, from: j, to: j + 1, vals: [midi[j]] });
    }
    const len = (r) => r.vals.length;
    // absorb short runs
    let changed = true;
    while (changed && runs.length > 1) {
      changed = false;
      for (let k = 0; k < runs.length; k++) {
        if (len(runs[k]) >= minRun) continue;
        const tgt = k > 0 ? k - 1 : k + 1;
        const a = runs[Math.min(k, tgt)], b = runs[Math.max(k, tgt)];
        const merged = { p: len(a) >= len(b) ? a.p : b.p, from: a.from, to: b.to, vals: a.vals.concat(b.vals) };
        runs.splice(Math.min(k, tgt), 2, merged);
        changed = true;
        break;
      }
      // merge equal neighbours
      for (let k = runs.length - 1; k > 0; k--) {
        if (runs[k].p === runs[k - 1].p) {
          runs[k - 1].to = runs[k].to;
          runs[k - 1].vals = runs[k - 1].vals.concat(runs[k].vals);
          runs.splice(k, 1);
        }
      }
    }
    // Pitch tracker lag: a short first run that still holds the previous note's pitch.
    const prevMidi = notes.length && notes[notes.length - 1].end >= s * hopTime - 0.05 ? notes[notes.length - 1].midi : null;
    if (runs.length > 1 && runs[0].to - runs[0].from < lagMax &&
        (runs[0].p === prevMidi || Math.abs(runs[0].p - runs[1].p) === 12)) {
      runs[1].from = runs[0].from;
      runs.shift();
    }
    // Octave errors: adjacent runs exactly 12 apart -> keep the longer one's pitch.
    for (let k = runs.length - 1; k > 0; k--) {
      const a = runs[k - 1], b = runs[k];
      if (Math.abs(a.p - b.p) % 12 === 0) {
        const keep = len(a) >= len(b) ? a : b;
        const vals = keep.vals.concat((keep === a ? b : a).vals.map((v) => v + (keep.p - (keep === a ? b : a).p)));
        runs.splice(k - 1, 2, { p: keep.p, from: a.from, to: b.to, vals });
      }
    }
    let vel = 0;
    for (let j = s; j < Math.min(e, s + 6); j++) vel = Math.max(vel, rms[j]);
    runs.forEach((r, k) => {
      const start = (k === 0 ? s : r.from) * hopTime;
      const end = (k === runs.length - 1 ? e : runs[k + 1].from) * hopTime;
      notes.push({
        start, end,
        midi: Math.round(median(r.vals)),
        legato: k > 0,
        fromOnset: k === 0 && fromOnset,
        strength: env[s] || 0,
        vel: Math.min(1, vel / ref),
      });
    });
  };

  for (const [vs, ve] of regions) {
    const bs = onsets.filter((o) => o > vs - 2 * near && o < ve - minFrames);
    const synthetic = !bs.length || bs[0] > vs + near;
    if (synthetic) bs.unshift(vs);
    for (let k = 0; k < bs.length; k++) {
      process(bs[k], k + 1 < bs.length ? bs[k + 1] : ve, !(synthetic && k === 0));
    }
  }

  // Merge false splits: same pitch, (nearly) contiguous, and no real re-attack.
  // ~60 ms smoothed level (the raw short-window RMS ripples on low notes)
  const lvl = new Float32Array(n);
  { const w = Math.max(1, Math.round(0.03 / hopTime));
    for (let i = 0; i < n; i++) { let m = 0, c = 0; for (let j = Math.max(0, i - w); j <= Math.min(n - 1, i + w); j++) { m += rms[j]; c++; } lvl[i] = m / c; } }
  const mean = (t0, t1) => {
    let m = 0, c = 0;
    for (let j = Math.max(0, Math.round(t0 / hopTime)); j <= Math.min(n - 1, Math.round(t1 / hopTime)); j++) { m += lvl[j]; c++; }
    return c ? m / c : 0;
  };
  // strictness: 0 at default sensitivity and above, 1 at sensitivity 0
  const strict = Math.min(1, Math.max(0, (0.55 - opts.sensitivity) / 0.55));
  const riseNeeded = 1.08 + 0.4 * strict;
  const dipNeeded = 0.95 - 0.25 * strict;
  const strongNeeded = strict >= 0.95 ? Infinity : 0.8 + 1.2 * strict;
  const trough = (t0, t1) => {
    let m = Infinity;
    for (let j = Math.max(0, Math.round(t0 / hopTime)); j <= Math.min(n - 1, Math.round(t1 / hopTime)); j++) m = Math.min(m, lvl[j]);
    return m === Infinity ? 0 : m;
  };
  for (let k = notes.length - 1; k > 0; k--) {
    const p = notes[k - 1], c = notes[k];
    if (p.midi !== c.midi) continue;
    const gap = c.start - p.end;
    if (gap > (c.fromOnset ? 0.06 : 0.15)) continue;
    // A re-pluck leaves the string louder than it was just before; a buzz or click doesn't.
    const rise = mean(c.start + 0.05, c.start + 0.12) / (mean(c.start - 0.08, c.start - 0.02) + 1e-9);
    // ...or it is briefly muted as the finger/pick touches it again.
    const dip = trough(c.start - 0.06, c.start + 0.01) / (mean(c.start - 0.16, c.start - 0.07) + 1e-9);
    if (!c.fromOnset || (rise < riseNeeded && dip > dipNeeded && c.strength < strongNeeded)) {
      p.end = c.end;
      notes.splice(k, 1);
    }
  }

  const minDur = opts.minNoteMs / 1000;
  const out = notes.filter((nt) => nt.end - nt.start >= minDur);
  out.forEach((nt, i) => (nt.id = i));
  return { notes: out, tuningShift, onsets: onsets.map((o) => o * hopTime) };
}

/** Estimate BPM + first downbeat offset (seconds). */
export function estimateTempo(feat, notes, beatsPerBar = 4) {
  const { flux, hopTime } = feat;
  if (!notes.length) return { bpm: 120, offset: 0 };
  const env = onsetEnvelope(flux);
  // remove local mean
  const n = env.length;
  const w = Math.round(0.5 / hopTime);
  const pre = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + env[i];
  const o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n, i + w + 1);
    o[i] = Math.max(0, env[i] - (pre[b] - pre[a]) / (b - a));
  }
  const maxLag = Math.min(n - 1, Math.ceil((4 * 60) / (50 * hopTime)));
  const acf = new Float64Array(maxLag + 2);
  for (let L = 1; L <= maxLag; L++) {
    let s = 0;
    for (let i = 0; i + L < n; i++) s += o[i] * o[i + L];
    acf[L] = s / (n - L);
  }
  const at = (lag) => {
    if (lag >= maxLag) return 0;
    const i = Math.floor(lag), f = lag - i;
    return acf[i] * (1 - f) + acf[i + 1] * f;
  };
  let best = 120, bestScore = -Infinity;
  for (let bpm = 55; bpm <= 200; bpm += 0.25) {
    const L = 60 / bpm / hopTime;
    const s = at(L) + 0.5 * at(2 * L) + 0.25 * at(4 * L) + 0.25 * at(L / 2);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.8, 2));
    if (s * prior > bestScore) { bestScore = s * prior; best = bpm; }
  }

  // Refine with 16th-grid phase coherence of note onsets.
  const coherence = (bpm, div) => {
    const P = 60 / bpm / div;
    let cs = 0, sn = 0, tw = 0;
    for (const nt of notes) {
      const th = (2 * Math.PI * nt.start) / P;
      const wgt = 0.3 + nt.vel;
      cs += wgt * Math.cos(th); sn += wgt * Math.sin(th); tw += wgt;
    }
    return { R: Math.hypot(cs, sn) / tw, phase: ((Math.atan2(sn, cs) / (2 * Math.PI)) * P + P) % P };
  };
  let refined = best, rBest = -1;
  for (let bpm = best - 2; bpm <= best + 2; bpm += 0.02) {
    const { R } = coherence(bpm, 4);
    if (R > rBest) { rBest = R; refined = bpm; }
  }
  const rounded = Math.round(refined);
  const bpm = coherence(rounded, 4).R >= 0.95 * rBest ? rounded : Math.round(refined * 10) / 10;

  // Beat phase: pick the 16th phase that puts the most weight on beats.
  const P16 = 60 / bpm / 4, P = 60 / bpm;
  const ph16 = coherence(bpm, 4).phase;
  let beatPhase = ph16, bp = -Infinity;
  for (let k = 0; k < 4; k++) {
    const ph = ph16 + k * P16;
    let s = 0;
    for (const nt of notes) {
      const q = Math.round((nt.start - ph) / P16);
      if (((q % 4) + 4) % 4 === 0) s += 0.3 + nt.vel;
    }
    // tie-break: prefer the phase that puts the first note on a beat
    if (((Math.round((notes[0].start - ph) / P16) % 4) + 4) % 4 === 0) s += 0.5;
    if (s > bp) { bp = s; beatPhase = ph % P; }
  }
  // Downbeat: which beat in the bar gets the most (loud) notes.
  let down = 0, dBest = -Infinity;
  for (let k = 0; k < beatsPerBar; k++) {
    let s = 0;
    for (const nt of notes) {
      const q = Math.round((nt.start - beatPhase) / P16);
      if (((q % (4 * beatsPerBar)) + 4 * beatsPerBar) % (4 * beatsPerBar) === 4 * k) s += 0.3 + nt.vel;
    }
    // mild preference for the first note landing on beat 1
    const q0 = Math.round((notes[0].start - beatPhase) / P16);
    if (((q0 % (4 * beatsPerBar)) + 4 * beatsPerBar) % (4 * beatsPerBar) === 4 * k) s *= 1.3;
    if (s > dBest) { dBest = s; down = k; }
  }
  let offset = beatPhase + down * P;
  const bar = beatsPerBar * P;
  const first = notes[0].start;
  while (offset > first + P16 / 2) offset -= bar;
  while (offset + bar <= first - P16 / 2) offset += bar;
  return { bpm, offset: Math.round(offset * 1000) / 1000 };
}

/** Viterbi over (string, fret) candidates. */
function assignFrets(items, tuning, maxFret) {
  const strings = tuning.strings;
  const candsFor = (it) => {
    const nt = it.note;
    let m = nt.midi;
    const lo = strings[0], hi = strings[strings.length - 1] + maxFret;
    nt.outOfRange = m < lo || m > hi;
    while (m < lo) m += 12;
    while (m > hi) m -= 12;
    const out = [];
    strings.forEach((open, s) => {
      const f = m - open;
      if (f >= 0 && f <= maxFret) out.push({ s, f });
    });
    if (nt.pinned) {
      const p = out.find((c) => c.s === nt.pinned.s && c.f === nt.pinned.f);
      if (p) return [p];
    }
    return out;
  };
  const local = (c) => c.f * 0.05 + (c.f > 12 ? (c.f - 12) * 0.15 : 0) + (c.f === 0 ? -0.05 : 0);
  // Approximate Viterbi that also tracks the fretting-hand position (last fretted note).
  const trans = (a, hand, b, dt) => {
    let cost = 0.1 * Math.abs(a.s - b.s);
    if (b.f > 0 && hand != null) {
      const d = Math.abs(b.f - hand);
      cost += 0.2 * d + (d > 4 ? (d - 4) * 0.8 : 0);
    }
    return dt > 1.5 ? cost * 0.3 : cost;
  };
  if (!items.length) return;
  const cands = items.map(candsFor);
  let cost = cands[0].map(local);
  let hands = cands[0].map((c) => (c.f > 0 ? c.f : null));
  const back = [cands[0].map(() => -1)];
  for (let i = 1; i < items.length; i++) {
    const dt = items[i].note.start - items[i - 1].note.end;
    const nc = [], nb = [], nh = [];
    cands[i].forEach((c) => {
      let bv = Infinity, bi = 0;
      cands[i - 1].forEach((p, j) => {
        const v = cost[j] + trans(p, hands[j], c, dt);
        if (v < bv) { bv = v; bi = j; }
      });
      nc.push(bv + local(c)); nb.push(bi); nh.push(c.f > 0 ? c.f : hands[bi]);
    });
    cost = nc; back.push(nb); hands = nh;
  }
  let k = cost.indexOf(Math.min(...cost));
  for (let i = items.length - 1; i >= 0; i--) {
    const c = cands[i][k];
    items[i].note.string = c.s;
    items[i].note.fret = c.f;
    k = back[i][k];
  }
}

/** All playable positions for a midi note. */
export function positionsFor(midi, tuning, maxFret) {
  return tuning.strings
    .map((open, s) => ({ s, f: midi - open }))
    .filter((c) => c.f >= 0 && c.f <= maxFret);
}

const DURS = [16, 12, 8, 6, 4, 3, 2, 1]; // in 16th units
const snapUnits = (u) => DURS.find((d) => d <= u) || 1;

/**
 * Quantize notes and lay them out in bars.
 * o: { bpm, offset, grid (slots per beat: 4 or 2), beatsPerBar, tuning, maxFret }
 */
export function arrange(notes, o) {
  const slotDur = 60 / o.bpm / o.grid;
  const spb = o.beatsPerBar * o.grid;
  const upS = 4 / o.grid; // 16th units per slot
  let offset = o.offset;
  const live = notes.filter((n) => !n.deleted).sort((a, b) => a.start - b.start);
  if (live.length) {
    const minq = Math.round((live[0].start - offset) / slotDur);
    if (minq < 0) offset -= Math.ceil(-minq / spb) * spb * slotDur;
  }
  // quantize + dedupe slots (monophonic)
  const bySlot = new Map();
  for (const nt of live) {
    const qs = Math.round((nt.start - offset) / slotDur);
    const prev = bySlot.get(qs);
    const score = nt.vel * (nt.end - nt.start);
    if (!prev || score > prev.score) bySlot.set(qs, { note: nt, qs, score });
  }
  const items = [...bySlot.values()].sort((a, b) => a.qs - b.qs);
  for (const nt of live) nt.hidden = true;
  items.forEach((it, i) => {
    it.note.hidden = false;
    const qe = Math.max(it.qs + 1, Math.round((it.note.end - offset) / slotDur));
    const next = i + 1 < items.length ? items[i + 1].qs : Infinity;
    it.dur = Math.max(1, Math.min(qe, next) - it.qs);
    it.note.qs = it.qs;
    it.note.qStart = offset + it.qs * slotDur;
    it.note.qEnd = offset + (it.qs + it.dur) * slotDur;
  });
  assignFrets(items, o.tuning, o.maxFret);
  items.forEach((it, i) => {
    const prev = items[i - 1];
    it.note.legatoDir = prev && it.note.midi < prev.note.midi ? -1 : 1;
  });

  const last = items[items.length - 1];
  const nBars = Math.max(1, last ? Math.ceil((last.qs + last.dur) / spb) : 1);
  const bars = Array.from({ length: nBars }, (_, i) => ({
    index: i, start: offset + i * spb * slotDur, end: offset + (i + 1) * spb * slotDur, events: [],
  }));
  for (const it of items) {
    const b = Math.floor(it.qs / spb);
    const slot = it.qs - b * spb;
    const d = Math.min(it.dur, spb - slot);
    const units = snapUnits(d * upS);
    bars[b].events.push({ type: 'note', slot, units, note: it.note, tieOut: it.dur > spb - slot });
  }
  // rests
  for (const bar of bars) {
    const ev = bar.events;
    const filled = [];
    let pos = 0;
    const addRest = (a, b) => {
      if (a === 0 && b === spb) { filled.push({ type: 'rest', slot: 0, units: 16, whole: true }); return; }
      let p = a;
      while (p < b) {
        const beatEnd = (Math.floor(p / o.grid) + 1) * o.grid;
        const segEnd = Math.min(b, beatEnd);
        // merge two full beats into a half rest when aligned
        if (p % o.grid === 0 && segEnd === beatEnd && o.beatsPerBar % 2 === 0 &&
            (p / o.grid) % 2 === 0 && p + 2 * o.grid <= b) {
          filled.push({ type: 'rest', slot: p, units: 8 });
          p += 2 * o.grid; continue;
        }
        let rem = segEnd - p;
        while (rem > 0) {
          const u = snapUnits(rem * upS);
          const cleaned = [4, 2, 1].find((x) => x <= u) || 1; // rests: no dotted
          filled.push({ type: 'rest', slot: p, units: cleaned });
          const s = cleaned / upS;
          p += s; rem -= s;
        }
      }
    };
    for (const e of ev) {
      if (e.slot > pos) addRest(pos, e.slot);
      filled.push(e);
      pos = e.slot + Math.max(1, Math.round(e.units / upS));
    }
    if (pos < spb) addRest(pos, spb);
    bar.events = filled;
  }
  return { bars, offset, slotDur, spb, grid: o.grid, bpm: o.bpm, beatsPerBar: o.beatsPerBar, tuning: o.tuning, notes: live };
}

/** Plain-text tab export. */
export function toAsciiTab(song, title = '') {
  const { bars, spb, tuning } = song;
  const strs = tuning.strings.map((m) => noteName(m, false));
  const width = Math.max(...strs.map((s) => s.length));
  const lines = [];
  if (title) lines.push(title, '');
  lines.push(`Tuning: ${strs.join(' ')}   Tempo: ${song.bpm} BPM`, '');
  const perRow = 4;
  for (let r = 0; r < bars.length; r += perRow) {
    const rowBars = bars.slice(r, r + perRow);
    const rows = tuning.strings.map(() => '');
    for (const bar of rowBars) {
      const cols = Array.from({ length: tuning.strings.length }, () => Array(spb).fill('--'));
      for (const e of bar.events) {
        if (e.type !== 'note') continue;
        const f = String(e.note.fret);
        cols[e.note.string][e.slot] = (e.note.legato ? '/' : '') + f;
      }
      cols.forEach((c, s) => {
        rows[s] += '|-' + c.map((x) => x.padEnd(3, '-')).join('');
      });
    }
    lines.push(`Bar ${r + 1}`);
    for (let s = tuning.strings.length - 1; s >= 0; s--) lines.push(strs[s].padEnd(width) + rows[s] + '|');
    lines.push('');
  }
  return lines.join('\n');
}
