import { TUNINGS, segmentNotes, estimateTempo, arrange, positionsFor, noteName, toAsciiTab } from './transcribe.js';
import { renderTab, cursorPos, timeAt, rangeRects } from './tab-render.js';
import { pluck, click, makeDemo, encodeWav } from './synth.js';

const $ = (id) => document.getElementById(id);
const audio = $('audio');
const ANALYSIS_SR = 11025;
const HOP = 128;

const state = {
  feat: null, seg: null, song: null, layout: null, title: '',
  selected: null, loop: null, loopOn: false, metro: false, countIn: false,
  speed: 1, playing: false, countingIn: false,
};

/* ---------- settings ---------- */
for (const [k, t] of Object.entries(TUNINGS)) {
  const o = document.createElement('option'); o.value = k; o.textContent = t.name; $('tuning').appendChild(o);
}
const fmt = { sens: (v) => v, 'min-note': (v) => v + ' ms', 'min-conf': (v) => v, gate: (v) => v + ' dB' };
for (const id of Object.keys(fmt)) {
  const upd = () => ($(id + '-out').textContent = fmt[id]($(id).value));
  $(id).addEventListener('input', upd); upd();
}
const segOpts = () => ({
  sensitivity: +$('sens').value, minNoteMs: +$('min-note').value, minConf: +$('min-conf').value, gateDb: +$('gate').value,
});
const arrOpts = () => ({
  bpm: Math.max(20, +$('bpm').value || 120), offset: +$('offset').value || 0,
  grid: +$('grid').value, beatsPerBar: +$('beats').value,
  tuning: TUNINGS[$('tuning').value], maxFret: Math.max(5, Math.min(30, +$('max-fret').value || 20)),
});

/* ---------- loading ---------- */
function showView(v) {
  $('empty').hidden = v !== 'empty';
  $('progress').hidden = v !== 'progress';
  $('song').hidden = v !== 'song';
}
function setProgress(label, p) {
  $('progress-label').textContent = label;
  $('progress-fill').style.width = Math.round(p * 100) + '%';
}

async function loadFile(file) {
  if (!file) return;
  try {
    showView('progress'); setProgress('Decoding audio…', 0.02);
    const buf = await file.arrayBuffer();
    await loadAudio(buf, file.name.replace(/\.[^.]+$/, ''), URL.createObjectURL(file));
  } catch (err) {
    console.error(err);
    alert(`Couldn't decode "${file.name}" as audio. Try WAV, MP3 or M4A.`);
    showView(state.song ? 'song' : 'empty');
  }
}

async function loadAudio(arrayBuffer, title, url) {
  stop();
  const tmp = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await tmp.decodeAudioData(arrayBuffer);
  tmp.close();
  setProgress('Resampling…', 0.05);
  const len = Math.ceil(decoded.duration * ANALYSIS_SR);
  const off = new OfflineAudioContext(1, len, ANALYSIS_SR);
  const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  const samples = rendered.getChannelData(0).slice();

  if (audio.src) URL.revokeObjectURL(audio.src);
  audio.src = url;
  state.title = title;
  state.feat = await analyze(samples);
  setProgress('Transcribing…', 1);
  state.loop = null; state.loopOn = false; state.selected = null;
  showView('song');
  retranscribe(true, true);
}

function analyze(samples) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./analysis-worker.js', import.meta.url));
    w.onmessage = (e) => {
      if (e.data.type === 'progress') setProgress('Detecting pitch & onsets…', 0.08 + 0.9 * e.data.p);
      else { w.terminate(); resolve(e.data); }
    };
    w.onerror = (e) => { w.terminate(); reject(new Error(e.message)); };
    w.postMessage({ samples, sr: ANALYSIS_SR, hop: HOP }, [samples.buffer]);
  });
}

/* ---------- pipeline ---------- */
function retranscribe(detectTempo, pickTuning) {
  if (!state.feat) return;
  state.seg = segmentNotes(state.feat, segOpts());
  if (pickTuning && state.seg.notes.length) {
    // choose a tuning that can reach the lowest (robust) note
    const lows = state.seg.notes.map((n) => n.midi).sort((a, b) => a - b);
    const low = lows[Math.min(lows.length - 1, Math.floor(lows.length * 0.02))];
    if ($('tuning').dataset.auto !== 'no') {
      $('tuning').value = low >= 28 ? 'std4' : low >= 27 ? 'eb4' : low >= 26 ? 'drop4' : 'std5';
    }
  }
  if (detectTempo) autoTempo();
  rearrange();
}
function autoTempo() {
  const { bpm, offset } = estimateTempo(state.feat, state.seg.notes, +$('beats').value);
  $('bpm').value = bpm; $('offset').value = offset;
}
function rearrange() {
  if (!state.seg) return;
  const o = arrOpts();
  state.song = arrange(state.seg.notes, o);
  $('offset').value = Math.round(state.song.offset * 1000) / 1000;
  const cents = Math.round(state.seg.tuningShift * 100);
  $('tuning-info').textContent = `Detected ${state.song.notes.length} notes. Recording is tuned ${
    Math.abs(cents) < 4 ? 'to A440' : (cents > 0 ? '+' : '') + cents + ' cents from A440'}.`;
  const t = o.tuning.strings.map((m) => noteName(m, false)).join(' ');
  $('song-title').textContent = state.title || 'Untitled';
  $('song-sub').textContent = `Electric Bass · ${t} · ${o.bpm} BPM · ${state.song.bars.length} bars`;
  render();
}

function render() {
  if (!state.song) return;
  const host = $('tab-host');
  state.layout = renderTab(host, state.song, { width: host.clientWidth });
  applyLoopHighlight();
  if (state.selected != null) selectNote(state.selected, false);
  updateCursor(true);
}

/* ---------- audio graph ---------- */
let ctx = null, origGain, synthGain, metroGain;
function ensureCtx() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaElementSource(audio);
    origGain = ctx.createGain(); synthGain = ctx.createGain(); metroGain = ctx.createGain();
    src.connect(origGain).connect(ctx.destination);
    synthGain.connect(ctx.destination); metroGain.connect(ctx.destination);
    metroGain.gain.value = 0.6;
    applyVolumes();
  }
  if (ctx.state === 'suspended') ctx.resume();
}
function applyVolumes() {
  if (!ctx) return;
  origGain.gain.value = +$('vol-orig').value;
  synthGain.gain.value = +$('vol-synth').value * 1.5;
}
$('vol-orig').addEventListener('input', applyVolumes);
$('vol-synth').addEventListener('input', applyVolumes);

/* ---------- transport ---------- */
const loopRange = () => {
  if (!state.loop || !state.song) return null;
  return [state.loop.a, state.loop.b];
};
// snap a time to the nearest grid slot (16th / 8th)
const snap = (t) => {
  const { offset, slotDur } = state.song;
  return offset + Math.round((t - offset) / slotDur) * slotDur;
};
const barAt = (t) => {
  const bars = state.song.bars;
  return bars.find((b) => t >= b.start - 1e-6 && t < b.end) || (t < bars[0].start ? bars[0] : bars[bars.length - 1]);
};

async function play() {
  if (!state.song || state.playing || state.countingIn) return;
  ensureCtx();
  audio.playbackRate = state.speed;
  audio.preservesPitch = true; audio.mozPreservesPitch = true; audio.webkitPreservesPitch = true;
  const lr = state.loopOn && loopRange();
  if (lr && (audio.currentTime < lr[0] - 0.01 || audio.currentTime >= lr[1])) audio.currentTime = Math.max(0, lr[0]);
  if (audio.currentTime < 0.01 && state.song.offset > 0 && !lr) {
    // start at first bar if there's leading silence
    audio.currentTime = Math.max(0, state.song.bars[0].start - 0.05);
  }
  if (state.countIn) {
    state.countingIn = true; setPlayIcon(true);
    const beat = 60 / state.song.bpm / state.speed;
    const now = ctx.currentTime + 0.05;
    for (let i = 0; i < state.song.beatsPerBar; i++) click(ctx, metroGain, now + i * beat, i === 0);
    await new Promise((r) => setTimeout(r, (0.05 + beat * state.song.beatsPerBar) * 1000 - 30));
    state.countingIn = false;
    if (!state.wantPlay) { setPlayIcon(false); return; }
  }
  try { await audio.play(); } catch (e) { console.warn(e); }
}
function pause() { state.wantPlay = false; audio.pause(); }
function stop() { pause(); if (audio.src) audio.currentTime = 0; }
function toggle() {
  if (state.playing || state.countingIn) pause(); else { state.wantPlay = true; play(); }
}
function setPlayIcon(on) { $('play').textContent = on ? '❚❚' : '▶'; $('play').setAttribute('aria-label', on ? 'Pause' : 'Play'); }
audio.addEventListener('play', () => { state.playing = true; setPlayIcon(true); resetSched(); });
audio.addEventListener('pause', () => { state.playing = false; if (!state.countingIn) setPlayIcon(false); clearActive(); });
audio.addEventListener('ended', () => { state.playing = false; setPlayIcon(false); });
audio.addEventListener('loadedmetadata', () => updateTime());

function setSpeed(s) {
  state.speed = Math.round(Math.max(0.25, Math.min(1.5, s)) * 100) / 100;
  audio.playbackRate = state.speed;
  $('speed').textContent = Math.round(state.speed * 100) + '%';
  resetSched();
}

function seek(t) {
  audio.currentTime = Math.max(0, Math.min(t, audio.duration || t));
  resetSched(); updateCursor(true);
}

/* ---------- scheduling & cursor ---------- */
let schedT = 0, lastT = 0;
function resetSched() { schedT = audio.currentTime; lastT = audio.currentTime; }

function tick() {
  requestAnimationFrame(tick);
  if (!state.song) return;
  let t = audio.currentTime;
  if (state.playing) {
    const lr = state.loopOn && loopRange();
    if (lr && t >= lr[1]) { audio.currentTime = lr[0]; t = lr[0]; resetSched(); }
    if (t < lastT - 0.02 || t - lastT > 0.5) resetSched();
    lastT = t;
    const horizon = t + 0.12 * state.speed;
    if (horizon > schedT) {
      const toCtx = (et) => ctx.currentTime + Math.max(0, (et - t) / state.speed);
      if (+$('vol-synth').value > 0) {
        for (const n of state.song.notes) {
          if (n.hidden || n.qStart < schedT || n.qStart >= horizon) continue;
          if (lr && n.qStart >= lr[1]) continue;
          pluck(ctx, synthGain, toCtx(n.qStart), n.midi, (n.qEnd - n.qStart) / state.speed * 0.95, n.vel);
        }
      }
      if (state.metro) {
        const P = 60 / state.song.bpm;
        const k0 = Math.ceil((schedT - state.song.offset) / P);
        for (let k = k0; state.song.offset + k * P < horizon; k++) {
          const bt = state.song.offset + k * P;
          if (bt < 0 || (lr && bt >= lr[1] - 1e-3)) continue;
          click(ctx, metroGain, toCtx(bt), ((k % state.song.beatsPerBar) + state.song.beatsPerBar) % state.song.beatsPerBar === 0);
        }
      }
      schedT = horizon;
    }
  }
  updateCursor(false);
  updateTime();
}

let lastBar = -1, lastRow = -1, activeIds = new Set();
function clearActive() {
  for (const id of activeIds) state.layout?.noteEls.get(id)?.g.classList.remove('active');
  activeIds.clear();
}
function updateCursor(force) {
  const L = state.layout, song = state.song;
  if (!L) return;
  const t = audio.currentTime;
  const p = cursorPos(L, song, t);
  if (!p) { L.cursor.style.display = 'none'; }
  else {
    L.cursor.style.display = '';
    L.cursor.setAttribute('x', p.x - 1);
    L.cursor.setAttribute('y', p.y - 12);
    if (p.bar !== lastBar || force) {
      L.bars.forEach((b) => b.bgEl.classList.toggle('cur', b.index === p.bar));
      lastBar = p.bar;
    }
    if (state.playing && p.B.row !== lastRow) {
      lastRow = p.B.row;
      const r = L.rows[p.B.row];
      const svgTop = L.svg.getBoundingClientRect().top + window.scrollY;
      const top = svgTop + r.y, bottom = top + r.h;
      const viewTop = window.scrollY + 70, viewBot = window.scrollY + window.innerHeight - 110;
      if (top < viewTop || bottom > viewBot) window.scrollTo({ top: top - 140, behavior: 'smooth' });
    }
  }
  if (state.playing) {
    const now = new Set();
    for (const n of song.notes) if (!n.hidden && t >= n.qStart && t < n.qEnd) now.add(n.id);
    for (const id of activeIds) if (!now.has(id)) L.noteEls.get(id)?.g.classList.remove('active');
    for (const id of now) L.noteEls.get(id)?.g.classList.add('active');
    activeIds = now;
  }
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
function updateTime() {
  $('time').textContent = `${mmss(audio.currentTime || 0)} / ${mmss(audio.duration || 0)}`;
}

/* ---------- loop selection & clicks ---------- */
function applyLoopHighlight() {
  $('loop').classList.toggle('on', state.loopOn);
  const lr = state.loop ? loopRange() : null;
  const fmtT = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  $('loop-range').textContent = lr ? `${fmtT(Math.max(0, lr[0]))} – ${fmtT(lr[1])}` : '';
  const L = state.layout;
  if (!L) return;
  L.loopLayer.innerHTML = '';
  if (!lr) return;
  for (const r of rangeRects(L, state.song, lr[0], lr[1])) {
    const e = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    for (const k in r) e.setAttribute(k, r[k]);
    e.setAttribute('class', 'loop-rect');
    L.loopLayer.appendChild(e);
  }
  const edge = (t, cls) => {
    const p = cursorPos(L, state.song, t - 1e-6) || cursorPos(L, state.song, t);
    if (!p) return;
    const e = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    Object.entries({ x: p.x - 1, y: p.y - 22, width: 2, height: L.staffH + 22 + 36, class: 'loop-edge ' + cls })
      .forEach(([k, v]) => e.setAttribute(k, v));
    L.loopLayer.appendChild(e);
  };
  edge(lr[0] + 1e-6, 'in'); edge(lr[1], 'out');
}
function setLoop(a, b) {
  if (!state.song) return;
  const min = state.song.slotDur;
  if (b - a < min) b = a + min;
  state.loop = { a, b };
  state.loopOn = true;
  applyLoopHighlight();
  resetSched();
}
function setLoopOn(on) {
  if (on && !state.loop && state.song) {
    const bar = barAt(audio.currentTime);
    setLoop(bar.start, bar.end);
    return;
  }
  state.loopOn = on && !!state.loop;
  if (!on) state.loop = null;
  applyLoopHighlight();
}
function setIn() {
  if (!state.song) return;
  const a = snap(audio.currentTime);
  const b = state.loop && state.loop.b > a ? state.loop.b : barAt(a).end;
  setLoop(a, b);
}
function setOut() {
  if (!state.song) return;
  const b = snap(audio.currentTime);
  const a = state.loop && state.loop.a < b ? state.loop.a : barAt(b - 1e-3).start;
  setLoop(a, b);
}

let drag = null;
const svgPoint = (e) => {
  const r = state.layout.svg.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
};
$('tab-host').addEventListener('pointerdown', (e) => {
  if (!state.layout || e.button !== 0) return;
  const [x, y] = svgPoint(e);
  const hit = timeAt(state.layout, state.song, x, y);
  const noteEl = e.target.closest('.note');
  drag = { x0: e.clientX, y0: e.clientY, t0: hit?.t, hit, noteId: noteEl ? +noteEl.dataset.id : null, moved: false };
});
window.addEventListener('pointermove', (e) => {
  if (!drag || drag.t0 == null) return;
  if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
  drag.moved = true;
  const [x, y] = svgPoint(e);
  const hit = timeAt(state.layout, state.song, x, y);
  if (hit) setLoop(snap(Math.min(drag.t0, hit.t)), snap(Math.max(drag.t0, hit.t)));
});
window.addEventListener('pointerup', () => {
  if (!drag) return;
  const d = drag; drag = null;
  if (d.moved) {
    if (state.loop) seek(state.loop.a);
    return;
  }
  if (d.noteId != null) {
    const n = state.song.notes.find((n) => n.id === d.noteId);
    selectNote(d.noteId, true);
    if (n) seek(n.qStart);
  } else {
    selectNote(null);
    if (d.hit) seek(d.hit.t);
  }
});

/* ---------- note editing ---------- */
function selectNote(id, show = true) {
  const L = state.layout;
  if (L) for (const [, v] of L.noteEls) v.g.classList.remove('selected');
  state.selected = id;
  const n = id != null && state.song?.notes.find((x) => x.id === id && !x.hidden);
  if (!n) { $('inspector').hidden = true; state.selected = null; return; }
  L?.noteEls.get(id)?.g.classList.add('selected');
  if (show) $('inspector').hidden = false;
  const tuning = state.song.tuning;
  const strName = (s) => noteName(tuning.strings[s], false);
  $('insp-title').textContent = `${noteName(n.midi)} — ${strName(n.string)} string, fret ${n.fret}` +
    (n.outOfRange ? ' (out of range)' : '');
  const chips = $('insp-pos'); chips.innerHTML = '';
  for (const c of positionsFor(n.midi, tuning, arrOpts().maxFret)) {
    const b = document.createElement('button');
    b.className = 'btn sm' + (c.s === n.string && c.f === n.fret ? ' on' : '');
    b.textContent = `${strName(c.s)} ${c.f}`;
    b.onclick = () => { n.pinned = c; rearrange(); };
    chips.appendChild(b);
  }
}
function editSelected(fn) {
  const n = state.song?.notes.find((x) => x.id === state.selected);
  if (!n) return;
  fn(n); rearrange();
}
const shiftPitch = (d) => editSelected((n) => { n.midi += d; n.pinned = null; });
const moveString = (d) => editSelected((n) => {
  const pos = positionsFor(n.midi, state.song.tuning, arrOpts().maxFret);
  const i = pos.findIndex((c) => c.s === n.string);
  const next = pos[i + d];
  if (next) n.pinned = next;
});
function stepNote(d) {
  const vis = state.song.notes.filter((n) => !n.hidden).sort((a, b) => a.qStart - b.qStart);
  const i = vis.findIndex((n) => n.id === state.selected);
  const n = vis[Math.max(0, Math.min(vis.length - 1, i < 0 ? 0 : i + d))];
  if (n) { selectNote(n.id); seek(n.qStart); }
}
$('insp-up').onclick = () => shiftPitch(1);
$('insp-down').onclick = () => shiftPitch(-1);
$('insp-oct-up').onclick = () => shiftPitch(12);
$('insp-oct-down').onclick = () => shiftPitch(-12);
$('insp-del').onclick = () => {
  const id = state.selected;
  editSelected((n) => { n.deleted = true; });
  if (state.selected === id) selectNote(null);
};
$('insp-close').onclick = () => selectNote(null);
function mergePrev() {
  const vis = state.song.notes.filter((n) => !n.hidden).sort((a, b) => a.qStart - b.qStart);
  const i = vis.findIndex((n) => n.id === state.selected);
  if (i < 1) return;
  const prev = vis[i - 1], cur = vis[i];
  prev.end = Math.max(prev.end, cur.end);
  cur.deleted = true;
  state.selected = prev.id;
  rearrange();
}
$('insp-merge').onclick = mergePrev;

/* ---------- export ---------- */
function asciiTab() { return state.song ? toAsciiTab(state.song, `${state.title} — Bass Tab`) : ''; }
$('export-txt').onclick = () => {
  if (!state.song) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([asciiTab()], { type: 'text/plain' }));
  a.download = (state.title || 'bass-tab') + '.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('copy-txt').onclick = async () => {
  try { await navigator.clipboard.writeText(asciiTab()); $('copy-txt').textContent = 'Copied!'; }
  catch { $('copy-txt').textContent = 'Copy failed'; }
  setTimeout(() => ($('copy-txt').textContent = 'Copy tab'), 1500);
};

/* ---------- wiring ---------- */
$('file').addEventListener('change', (e) => loadFile(e.target.files[0]));
$('file2').addEventListener('change', (e) => loadFile(e.target.files[0]));
const demo = async () => {
  showView('progress'); setProgress('Generating demo…', 0.01);
  await new Promise((r) => setTimeout(r, 20));
  const { samples, sr } = makeDemo();
  const blob = encodeWav(samples, sr);
  await loadAudio(await blob.arrayBuffer(), 'Demo Riff', URL.createObjectURL(blob));
};
$('demo').onclick = demo; $('demo2').onclick = demo;

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});

$('play').onclick = toggle;
$('rewind').onclick = () => seek(state.loopOn && loopRange() ? loopRange()[0] : 0);
$('slower').onclick = () => setSpeed(state.speed - 0.05);
$('faster').onclick = () => setSpeed(state.speed + 0.05);
$('loop').onclick = () => setLoopOn(!state.loopOn);
$('loop-in').onclick = setIn;
$('loop-out').onclick = setOut;
document.querySelectorAll('.help-btn').forEach((b) => {
  b.onclick = () => {
    const h = $(b.dataset.help);
    h.hidden = !h.hidden;
    b.setAttribute('aria-expanded', String(!h.hidden));
  };
});
$('metro').onclick = () => { state.metro = !state.metro; $('metro').classList.toggle('on', state.metro); resetSched(); };
$('countin').onclick = () => { state.countIn = !state.countIn; $('countin').classList.toggle('on', state.countIn); };

$('settings-btn').onclick = () => ($('settings').hidden = !$('settings').hidden);
$('settings-close').onclick = () => ($('settings').hidden = true);

const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const reSeg = debounce(() => retranscribe(false), 150);
for (const id of ['sens', 'min-note', 'min-conf', 'gate']) $(id).addEventListener('input', reSeg);
const reArr = debounce(rearrange, 150);
for (const id of ['bpm', 'offset']) $(id).addEventListener('input', reArr);
for (const id of ['tuning', 'max-fret', 'grid', 'beats']) $(id).addEventListener('change', rearrange);
$('tuning').addEventListener('change', () => ($('tuning').dataset.auto = 'no'));
$('tempo-auto').onclick = () => { if (state.seg) { autoTempo(); rearrange(); } };
$('bpm-half').onclick = () => { $('bpm').value = Math.round(+$('bpm').value * 5) / 10; rearrange(); };
$('bpm-double').onclick = () => { $('bpm').value = Math.round(+$('bpm').value * 20) / 10; rearrange(); };
const shiftBeat = (d) => { $('offset').value = (+$('offset').value + d * 60 / +$('bpm').value).toFixed(3); rearrange(); };
$('beat-prev').onclick = () => shiftBeat(-1);
$('beat-next').onclick = () => shiftBeat(1);

window.addEventListener('resize', debounce(render, 120));

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); toggle(); }
  else if (k === 'l' || k === 'L') setLoopOn(!state.loopOn);
  else if (k === 'i' || k === 'I') setIn();
  else if (k === 'o' || k === 'O') setOut();
  else if ((k === 'j' || k === 'J') && state.selected != null) mergePrev();
  else if (k === 'm' || k === 'M') $('metro').click();
  else if (k === '[') setSpeed(state.speed - 0.05);
  else if (k === ']') setSpeed(state.speed + 0.05);
  else if (k === 'Home') { e.preventDefault(); $('rewind').click(); }
  else if (k === 'Escape') { selectNote(null); $('settings').hidden = true; }
  else if (state.selected != null) {
    if (k === 'ArrowUp') { e.preventDefault(); moveString(1); }
    else if (k === 'ArrowDown') { e.preventDefault(); moveString(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); stepNote(1); }
    else if (k === 'ArrowLeft') { e.preventDefault(); stepNote(-1); }
    else if (k === '+' || k === '=') shiftPitch(1);
    else if (k === '-' || k === '_') shiftPitch(-1);
    else if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); $('insp-del').click(); }
  }
});

setSpeed(1);
requestAnimationFrame(tick);
window.__bassTabs = state; // for debugging
