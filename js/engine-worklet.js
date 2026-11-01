// Multi-track playback engine (AudioWorklet).
// Mixes all stems sample-accurately and time-stretches the mix with WSOLA,
// so speed changes keep pitch and tracks can never drift apart.

const N = 2048;          // grain length
const HS = 512;          // synthesis hop (75% overlap)
const TOL = 384;         // WSOLA search range (+/- samples)
const CMP = 512;         // samples compared when searching
const WIN = new Float32Array(N);
for (let i = 0; i < N; i++) WIN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
const OLA_GAIN = HS / (N / 2); // periodic Hann at 75% overlap sums to 2

class Engine extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tracks = new Map();   // id -> { L, R, len, gain }
    this.list = [];
    this.refBuf = new Float32Array(CMP / 8);
    this.len = 0;
    this.pos = 0;              // source position (samples)
    this.rate = 1;
    this.playing = false;
    this.fade = 0;
    this.tick = 0;
    this.loopA = -1; this.loopB = -1;
    this.resetStretch();
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  resetStretch() {
    this.accL = new Float32Array(N); this.accR = new Float32Array(N);
    this.fifoL = new Float32Array(HS); this.fifoR = new Float32Array(HS);
    this.fifoN = 0; this.fifoRead = 0;
    this.prev = -1;            // previous grain start
  }

  onMsg(m) {
    switch (m.type) {
      case 'add':
        this.tracks.set(m.id, { L: m.L, R: m.R || m.L, len: m.L.length, gain: m.gain ?? 1 });
        this.updateLen(); break;
      case 'remove': this.tracks.delete(m.id); this.updateLen(); break;
      case 'gain': { const t = this.tracks.get(m.id); if (t) t.gain = m.gain; break; }
      case 'seek':
        this.pos = Math.max(0, m.pos * sampleRate); this.fade = 0; this.resetStretch(); this.report(); break;
      case 'rate':
        if ((this.rate === 1) !== (m.rate === 1)) this.resetStretch();
        this.rate = m.rate; break;
      case 'play': this.playing = true; if (this.pos >= this.len) this.pos = 0; break;
      case 'pause': this.playing = false; break;
      case 'loop': this.loopA = m.a == null ? -1 : m.a * sampleRate; this.loopB = m.b == null ? -1 : m.b * sampleRate; break;
    }
  }
  updateLen() {
    this.list = [...this.tracks.values()];
    this.len = 0; for (const t of this.list) this.len = Math.max(this.len, t.len);
  }
  report() { this.port.postMessage({ type: 'pos', pos: this.pos / sampleRate, at: currentTime, playing: this.playing }); }

  // Mono mix sample (for WSOLA alignment).
  mono(i) {
    let s = 0;
    for (const t of this.list) if (i >= 0 && i < t.len && t.gain) s += (t.L[i] + t.R[i]) * t.gain;
    return s;
  }
  mixInto(i, outL, outR, k, w) {
    let l = 0, r = 0;
    if (i >= 0) for (const t of this.list) {
      if (i < t.len && t.gain) { l += t.L[i] * t.gain; r += t.R[i] * t.gain; }
    }
    outL[k] += l * w; outR[k] += r * w;
  }

  // Produce one hop of time-stretched output into the FIFO.
  grain() {
    const target = Math.round(this.pos);
    let start = target;
    if (this.prev >= 0) {
      // natural continuation of the previous grain
      const ref = this.prev + HS;
      const rb = this.refBuf;
      for (let j = 0; j < CMP; j += 8) rb[j >> 3] = this.mono(ref + j);
      const score = (c) => {
        let v = 0;
        for (let j = 0; j < CMP; j += 8) v += rb[j >> 3] * this.mono(c + j);
        return v;
      };
      let best = -Infinity;
      for (let d = -TOL; d <= TOL; d += 4) {
        const v = score(target + d);
        if (v > best) { best = v; start = target + d; }
      }
      const coarse = start;
      for (let c = coarse - 3; c <= coarse + 3; c++) {
        if (c === coarse) continue;
        const v = score(c);
        if (v > best) { best = v; start = c; }
      }
    }
    const { accL, accR } = this;
    for (let k = 0; k < N; k++) this.mixInto(start + k, accL, accR, k, WIN[k] * OLA_GAIN);
    this.fifoL.set(accL.subarray(0, HS)); this.fifoR.set(accR.subarray(0, HS));
    accL.copyWithin(0, HS); accR.copyWithin(0, HS);
    accL.fill(0, N - HS); accR.fill(0, N - HS);
    this.fifoN = HS; this.fifoRead = 0;
    this.prev = start;
    this.pos += HS * this.rate;
    if (this.loopB > 0 && this.pos >= this.loopB) { this.pos = this.loopA + (this.pos - this.loopB); this.prev = -1; }
  }

  process(_in, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    if (!this.playing && this.fade <= 0) { this.tick = 0; return true; }
    const fadeStep = 1 / 240;
    for (let k = 0; k < n; k++) {
      const target = this.playing ? 1 : 0;
      this.fade += target > this.fade ? fadeStep : -fadeStep;
      this.fade = Math.min(1, Math.max(0, this.fade));
      L[k] = 0; R[k] = 0;
      if (this.rate === 1) {
        const i = Math.floor(this.pos);
        this.mixInto(i, L, R, k, this.fade);
        this.pos += 1;
        if (this.loopB > 0 && this.pos >= this.loopB) this.pos = this.loopA;
      } else {
        if (this.fifoRead >= this.fifoN) this.grain();
        L[k] = this.fifoL[this.fifoRead] * this.fade;
        R[k] = this.fifoR[this.fifoRead] * this.fade;
        this.fifoRead++;
      }
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
