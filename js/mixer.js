// Main-thread side of the playback engine. Mimics the bits of HTMLMediaElement
// the app uses (currentTime, duration, play/pause, playbackRate, events).

let nextId = 1;

export class Mixer extends EventTarget {
  constructor() {
    super();
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} // iOS: ignore silent switch
    this.tracks = [];
    this._rate = 1;
    this._semis = 0;
    this._pos = 0; this._at = 0; this._playing = false;
    this.out = this.ctx.createGain();
    this.out.connect(this.ctx.destination);
    this.ready = this.ctx.audioWorklet.addModule(new URL('./engine-worklet.js', import.meta.url)).then(() => {
      this.node = new AudioWorkletNode(this.ctx, 'bass-tabs-engine', { numberOfInputs: 0, outputChannelCount: [2] });
      this.node.connect(this.out);
      this.node.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'pos') {
          this._pos = m.pos; this._at = m.at;
        } else if (m.type === 'ended') {
          this._playing = false;
          this.dispatchEvent(new Event('pause'));
          this.dispatchEvent(new Event('ended'));
        }
      };
    });
  }

  post(m, transfer) { this.node.port.postMessage(m, transfer || []); }

  /** Decode a File and add it as a track. Returns { track, buffer }. */
  async addFile(file, opts = {}) {
    await this.ready;
    const ab = await file.arrayBuffer();
    const buffer = await this.ctx.decodeAudioData(ab);
    const L = buffer.getChannelData(0).slice();
    const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1).slice() : null;
    const track = {
      id: nextId++, name: file.name, size: file.size, file, duration: buffer.duration,
      vol: opts.vol ?? 1, mute: !!opts.mute, solo: !!opts.solo, protect: !!opts.protect,
      ...(opts.remote ? { remote: opts.remote } : {}),
      ...(opts.label ? { label: opts.label } : {}), ...(opts.kind ? { kind: opts.kind } : {}),
    };
    this.tracks.push(track);
    this.post({ type: 'add', id: track.id, L, R, gain: 0, prot: track.protect }, R ? [L.buffer, R.buffer] : [L.buffer]);
    this.applyGains();
    this.dispatchEvent(new Event('tracks'));
    return { track, buffer };
  }

  removeTrack(id) {
    this.tracks = this.tracks.filter((t) => t.id !== id);
    this.post({ type: 'remove', id });
    this.applyGains();
    this.dispatchEvent(new Event('tracks'));
  }

  clear() { for (const t of [...this.tracks]) this.removeTrack(t.id); this.currentTime = 0; }

  applyGains() {
    const anySolo = this.tracks.some((t) => t.solo);
    for (const t of this.tracks) {
      const audible = anySolo ? t.solo : !t.mute;
      this.post({ type: 'gain', id: t.id, gain: audible ? t.vol * t.vol : 0 }); // squared = nicer fader curve
    }
  }
  update(id, patch) {
    const t = this.tracks.find((x) => x.id === id);
    if (!t) return;
    Object.assign(t, patch);
    if ('protect' in patch) this.post({ type: 'protect', id, on: t.protect });
    this.applyGains();
  }

  /** Transpose (semitones) all tracks except protected ones. Independent of speed. */
  get transpose() { return this._semis; }
  set transpose(semis) {
    this._pos = this.currentTime; this._at = this.ctx.currentTime;
    this._semis = semis;
    const pitch = Math.pow(2, semis / 12);
    if (this.node) this.post({ type: 'pitch', pitch });
    else this.ready.then(() => this.post({ type: 'pitch', pitch }));
  }

  /** Sample-accurate loop (seconds) or null. */
  setLoop(a, b) {
    this.loop = a == null ? null : { a, b };
    if (this.node) this.post({ type: 'loop', a: this.loop ? a : null, b: this.loop ? b : null });
    else this.ready.then(() => this.post({ type: 'loop', a: this.loop?.a ?? null, b: this.loop?.b ?? null }));
  }

  get duration() { return this.tracks.reduce((m, t) => Math.max(m, t.duration), 0); }
  get paused() { return !this._playing; }
  get currentTime() {
    if (!this._playing) return this._pos;
    let t = this._pos + Math.max(0, this.ctx.currentTime - this._at) * this._rate;
    if (this.loop && this._pos < this.loop.b && t >= this.loop.b) t = this.loop.a + (t - this.loop.b);
    return Math.min(this.duration, t);
  }
  set currentTime(t) {
    t = Math.max(0, Math.min(t, this.duration || 0));
    this._pos = t; this._at = this.ctx.currentTime;
    if (this.node) this.post({ type: 'seek', pos: t });
  }
  get playbackRate() { return this._rate; }
  set playbackRate(r) {
    this._pos = this.currentTime; this._at = this.ctx.currentTime;
    this._rate = r;
    if (this.node) this.post({ type: 'rate', rate: r });
  }
  async play() {
    await this.ready;
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (!this.tracks.length) return;
    if (this._pos >= this.duration) this.currentTime = 0;
    this._at = this.ctx.currentTime;
    this._playing = true;
    this.post({ type: 'play' });
    this.dispatchEvent(new Event('play'));
  }
  pause() {
    if (!this._playing) return;
    this._pos = this.currentTime; this._at = this.ctx.currentTime;
    this._playing = false;
    if (this.node) this.post({ type: 'pause' });
    this.dispatchEvent(new Event('pause'));
  }
}
