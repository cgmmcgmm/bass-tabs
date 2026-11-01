// Multi-track playback engine (AudioWorklet).
// Mixes all stems sample-accurately. Speed changes keep pitch (WSOLA time-stretch);
// transpose = time-stretch + resample, so speed and key are independent.
// Tracks marked "protected" are never transposed (two separate processing paths).

const N = 2048;          // grain length
const HS = 512;          // synthesis hop (75% overlap)
const TOL = 384;         // WSOLA search range (+/- samples)
const CMP = 512;         // samples compared when searching
const WIN = new Float32Array(N);
for (let i = 0; i < N; i++) WIN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
const OLA_GAIN = HS / (N / 2); // periodic Hann at 75% overlap sums to 2

/** One processing path (a group of tracks) with its own WSOLA + resampler state. */
class Path {
  constructor(eng, prot) {
    this.eng = eng; this.prot = prot;
    this.refBuf = new Float32Array(CMP / 8);
    this.accL = new Float32Array(N); this.accR = new Float32Array(N);
    this.fifoL = new Float32Array(HS); this.fifoR = new Float32Array(HS);
    this.seek(0);
  }
  get list() { return this.prot ? this.eng.protList : this.eng.normList; }
  seek(pos) {
    this.apos = pos;
    this.accL.fill(0); this.accR.fill(0);
    this.fifoN = 0; this.fifoRead = 0; this.prev = -1;
    this.frac = 0; this.primed = false;
    this.s0L = this.s0R = this.s1L = this.s1R = 0;
  }
  mono(i) {
    let s = 0;
    if (i >= 0) for (const t of this.list) if (i < t.len && t.gain) s += (t.L[i] + t.R[i]) * t.gain;
    return s;
  }
  mixInto(i, outL, outR, k, w) {
    let l = 0, r = 0;
    if (i >= 0) for (const t of this.list) {
      if (i < t.len && t.gain) { l += t.L[i] * t.gain; r += t.R[i] * t.gain; }
    }
    outL[k] += l * w; outR[k] += r * w;
  }
  grain(hop) {
    const target = Math.round(this.apos);
    let start = target;
    if (this.prev >= 0) {
      const ref = this.prev + HS, rb = this.refBuf;
      for (let j = 0; j < CMP; j += 8) rb[j >> 3] = this.mono(ref + j);
      const score = (c) => { let v = 0; for (let j = 0; j < CMP; j += 8) v += rb[j >> 3] * this.mono(c + j); return v; };
      let best = -Infinity;
      for (let d = -TOL; d <= TOL; d += 4) { const v = score(target + d); if (v > best) { best = v; start = target + d; } }
      const coarse = start;
      for (let c = coarse - 3; c <= coarse + 3; c++) { if (c !== coarse) { const v = score(c); if (v > best) { best = v; start = c; } } }
    }
    const { accL, accR } = this;
    for (let k = 0; k < N; k++) this.mixInto(start + k, accL, accR, k, WIN[k] * OLA_GAIN);
    this.fifoL.set(accL.subarray(0, HS)); this.fifoR.set(accR.subarray(0, HS));
    accL.copyWithin(0, HS); accR.copyWithin(0, HS);
    accL.fill(0, N - HS); accR.fill(0, N - HS);
    this.fifoN = HS; this.fifoRead = 0;
    this.prev = start;
    this.apos += HS * hop;
  }
  pull(hop) {
    if (this.fifoRead >= this.fifoN) this.grain(hop);
    this.oL = this.fifoL[this.fifoRead]; this.oR = this.fifoR[this.fifoRead]; this.fifoRead++;
  }
  /** Add one output sample at index k. rate = speed, p = pitch factor. */
  next(L, R, k, fade, rate, p) {
    if (!this.list.length) { this.apos += rate; return; }
    if (rate === 1 && p === 1) {               // untouched: plain copy
      this.mixInto(Math.floor(this.apos), L, R, k, fade);
      this.apos += 1;
      return;
    }
    const hop = rate / p;                       // stretch so that resampling by p restores the tempo
    if (p === 1) { this.pull(hop); L[k] += this.oL * fade; R[k] += this.oR * fade; return; }
    if (!this.primed) {
      this.pull(hop); this.s0L = this.oL; this.s0R = this.oR;
      this.pull(hop); this.s1L = this.oL; this.s1R = this.oR;
      this.primed = true;
    }
    while (this.frac >= 1) {
      this.frac -= 1;
      this.s0L = this.s1L; this.s0R = this.s1R;
      this.pull(hop); this.s1L = this.oL; this.s1R = this.oR;
    }
    const f = this.frac;
    L[k] += (this.s0L + (this.s1L - this.s0L) * f) * fade;
    R[k] += (this.s0R + (this.s1R - this.s0R) * f) * fade;
    this.frac += p;
  }
}

class Engine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tracks = new Map();   // id -> { L, R, len, gain, prot }
    this.normList = []; this.protList = [];
    this.len = 0;
    this.pos = 0;              // heard position (source samples)
    this.rate = 1; this.pitch = 1;
    this.playing = false;
    this.fade = 0;
    this.tick = 0;
    this.loopA = -1; this.loopB = -1;
    this.paths = [new Path(this, false), new Path(this, true)];
    this.port.onmessage = (e) => this.onMsg(e.data);
  }
  reseed() { for (const p of this.paths) p.seek(this.pos); }
  onMsg(m) {
    switch (m.type) {
      case 'add':
        this.tracks.set(m.id, { L: m.L, R: m.R || m.L, len: m.L.length, gain: m.gain ?? 1, prot: !!m.prot });
        this.updateLists(); break;
      case 'remove': this.tracks.delete(m.id); this.updateLists(); break;
      case 'gain': { const t = this.tracks.get(m.id); if (t) t.gain = m.gain; break; }
      case 'protect': { const t = this.tracks.get(m.id); if (t) { t.prot = !!m.on; this.updateLists(); this.reseed(); } break; }
      case 'seek':
        this.pos = Math.max(0, m.pos * sampleRate); this.fade = 0; this.reseed(); this.report(); break;
      case 'rate': this.rate = m.rate; this.reseed(); break;
      case 'pitch': this.pitch = m.pitch; this.reseed(); break;
      case 'play': this.playing = true; if (this.pos >= this.len) { this.pos = 0; this.reseed(); } break;
      case 'pause': this.playing = false; break;
      case 'loop': this.loopA = m.a == null ? -1 : m.a * sampleRate; this.loopB = m.b == null ? -1 : m.b * sampleRate; break;
    }
  }
  updateLists() {
    const all = [...this.tracks.values()];
    this.normList = all.filter((t) => !t.prot);
    this.protList = all.filter((t) => t.prot);
    this.len = 0; for (const t of all) this.len = Math.max(this.len, t.len);
  }
  report() { this.port.postMessage({ type: 'pos', pos: this.pos / sampleRate, at: currentTime, playing: this.playing }); }

  process(_in, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    if (!this.playing && this.fade <= 0) { this.tick = 0; return true; }
    const fadeStep = 1 / 240;
    const [norm, prot] = this.paths;
    for (let k = 0; k < n; k++) {
      this.fade += (this.playing ? 1 : 0) > this.fade ? fadeStep : -fadeStep;
      this.fade = Math.min(1, Math.max(0, this.fade));
      L[k] = 0; R[k] = 0;
      norm.next(L, R, k, this.fade, this.rate, this.pitch);
      prot.next(L, R, k, this.fade, this.rate, 1);
      this.pos += this.rate;
      if (this.loopB > 0 && this.pos >= this.loopB) { this.pos = this.loopA; this.reseed(); }
    }
    if (this.playing && this.pos >= this.len && this.len > 0) {
      this.playing = false;
      this.port.postMessage({ type: 'ended' });
    }
    if ((this.tick++ & 3) === 0) this.report();
    return true;
  }
}
registerProcessor('bass-tabs-engine', Engine);
