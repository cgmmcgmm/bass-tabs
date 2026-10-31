// Audio feature extraction (runs in a Web Worker).
// Input: mono Float32Array at a low sample rate (~11025 Hz).
// Output per frame: f0 (YIN), confidence, RMS, spectral flux (onset strength).

function makeFFT(size) {
  const levels = Math.log2(size) | 0;
  const rev = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(size / 2), sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size);
    sin[i] = Math.sin((2 * Math.PI * i) / size);
  }
  // In-place complex FFT. inverse=true computes unscaled inverse.
  return function fft(re, im, inverse = false) {
    for (let i = 0; i < size; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    const sgn = inverse ? 1 : -1;
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1, step = size / len;
      for (let i = 0; i < size; i += len) {
        for (let j = 0; j < half; j++) {
          const k = j * step;
          const wr = cos[k], wi = sgn * sin[k];
          const a = i + j, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}

function goertzel(x, win, fNorm) {
  const w = 2 * Math.PI * fNorm, c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < x.length; i++) {
    const s0 = x[i] * win[i] + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

function analyze(x, sr, hop, onProgress) {
  const W = 1024;                       // YIN window (~93 ms @ 11025 Hz)
  const tauMax = Math.floor(sr / 28);   // lowest pitch ~28 Hz (below low B)
  const tauMin = Math.floor(sr / 520);  // highest pitch ~520 Hz
  const N = W - tauMax;                 // integration length
  const M = 2048;
  const fft = makeFFT(M);
  const FW = 512;                       // flux window
  const fftF = makeFFT(FW);
  const hann = new Float64Array(FW);
  for (let i = 0; i < FW; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FW);

  const hannW = new Float64Array(W);
  for (let i = 0; i < W; i++) hannW[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / W);
  const nFrames = Math.floor(x.length / hop) + 1;
  const f0 = new Float32Array(nFrames);
  const conf = new Float32Array(nFrames);
  const rms = new Float32Array(nFrames);
  const flux = new Float32Array(nFrames);

  const frame = new Float64Array(W);
  const pre = new Float64Array(W + 1);
  const aRe = new Float64Array(M), aIm = new Float64Array(M);
  const bRe = new Float64Array(M), bIm = new Float64Array(M);
  const dn = new Float64Array(tauMax + 1);
  const fRe = new Float64Array(FW), fIm = new Float64Array(FW);
  const prevMag = new Float64Array(FW / 2);
  const nBins = Math.min(FW / 2, Math.floor((2500 / sr) * FW)); // flux up to 2.5 kHz

  for (let i = 0; i < nFrames; i++) {
    const c = i * hop;
    const start = c - W / 2;
    for (let j = 0; j < W; j++) {
      const k = start + j;
      frame[j] = k >= 0 && k < x.length ? x[k] : 0;
    }
    pre[0] = 0;
    for (let j = 0; j < W; j++) pre[j + 1] = pre[j] + frame[j] * frame[j];

    // short-window RMS (central 256 samples)
    let e = 0;
    for (let j = W / 2 - 128; j < W / 2 + 128; j++) e += frame[j] * frame[j];
    rms[i] = Math.sqrt(e / 256);

    // --- YIN via FFT cross-correlation ---
    aRe.fill(0); aIm.fill(0); bRe.fill(0); bIm.fill(0);
    for (let j = 0; j < N; j++) aRe[j] = frame[j];
    for (let j = 0; j < W; j++) bRe[j] = frame[j];
    fft(aRe, aIm); fft(bRe, bIm);
    for (let k = 0; k < M; k++) {
      // conj(A) * B
      const r = aRe[k] * bRe[k] + aIm[k] * bIm[k];
      const im = aRe[k] * bIm[k] - aIm[k] * bRe[k];
      aRe[k] = r; aIm[k] = im;
    }
    fft(aRe, aIm, true);
    const e0 = pre[N];
    if (e0 < 1e-10) { f0[i] = 0; conf[i] = 0; }
    else {
      // McLeod Pitch Method: normalized square difference function.
      for (let tau = 0; tau <= tauMax; tau++) {
        const r = aRe[tau] / M;
        const et = pre[tau + N] - pre[tau];
        dn[tau] = (2 * r) / (e0 + et + 1e-12);
      }
      // collect key maxima (one per positive lobe, skipping the lobe at tau=0)
      let tau0 = 1;
      while (tau0 < tauMax && dn[tau0] > 0) tau0++;
      if (tau0 < tauMin) tau0 = tauMin;
      const peaks = [];
      let pk = -1;
      for (let tau = tau0; tau < tauMax; tau++) {
        if (dn[tau] > 0) {
          if (pk < 0 || dn[tau] > dn[pk]) pk = tau;
        } else if (pk >= 0) { peaks.push(pk); pk = -1; }
      }
      if (pk >= 0 && pk < tauMax - 1) peaks.push(pk);
      let best = -1, hi = 0;
      for (const q of peaks) hi = Math.max(hi, dn[q]);
      for (const q of peaks) if (dn[q] >= 0.88 * hi) { best = q; break; }
      let tau = best;
      if (best > 0 && best < tauMax) {
        const s0 = dn[tau - 1], s1 = dn[tau], s2 = dn[tau + 1];
        const den = s0 + s2 - 2 * s1;
        if (Math.abs(den) > 1e-12) tau = tau + (s0 - s2) / (2 * den);
      }
      // Sub-octave check: if odd harmonics of f are missing, the real pitch is 2f.
      if (tau > 0) {
        const f = sr / tau;
        let odd = 0, even = 0;
        for (let h = 1; h <= 6 && h * f < sr / 2; h++) {
          const g = goertzel(frame, hannW, (h * f) / sr);
          if (h % 2) odd += g; else even += g;
        }
        const h2 = Math.round(tau / 2);
        let nh = -1;
        for (let j = h2 - 2; j <= h2 + 2; j++) if (j >= 1 && j <= tauMax) nh = Math.max(nh, dn[j]);
        if (odd < 0.12 * even && nh > 0.5 && h2 >= tauMin) tau /= 2;
      }
      f0[i] = tau > 0 ? sr / tau : 0;
      conf[i] = best > 0 ? Math.max(0, Math.min(1, dn[best])) : 0;
    }

    // --- spectral flux ---
    for (let j = 0; j < FW; j++) {
      const k = c - FW / 2 + j;
      fRe[j] = (k >= 0 && k < x.length ? x[k] : 0) * hann[j];
      fIm[j] = 0;
    }
    fftF(fRe, fIm);
    let fl = 0;
    for (let k = 1; k < nBins; k++) {
      const m = Math.log1p(1000 * Math.hypot(fRe[k], fIm[k]));
      const diff = m - prevMag[k];
      if (diff > 0) fl += diff;
      prevMag[k] = m;
    }
    flux[i] = fl;

    if (i % 500 === 0) onProgress(i / nFrames);
  }
  return { f0, conf, rms, flux, hopTime: hop / sr };
}

self.onmessage = (e) => {
  const { samples, sr, hop } = e.data;
  const res = analyze(samples, sr, hop, (p) => self.postMessage({ type: 'progress', p }));
  self.postMessage(
    { type: 'done', ...res },
    [res.f0.buffer, res.conf.buffer, res.rms.buffer, res.flux.buffer]
  );
};
