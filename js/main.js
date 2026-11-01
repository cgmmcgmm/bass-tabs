import { TUNINGS, segmentNotes, estimateTempo, arrange, positionsFor, noteName, toAsciiTab } from './transcribe.js';
import { renderTab, cursorPos, timeAt, rangeRects } from './tab-render.js';
import { pluck, click, makeDemo, encodeWav, SYNTH_PRESETS } from './synth.js';
import { toMidi } from './midi.js';
import { Mixer } from './mixer.js';
import { loadConfig } from './config.js';
import { KINDS, autoLabel, setAutoLabels, setUnknownLabel } from './kinds.js';
import { helper, connectHelper, setHelperUrl, separate, fetchStem } from './helper.js';

const CONFIG = await loadConfig();
if (CONFIG.auto_labels) setAutoLabels(CONFIG.auto_labels);
setUnknownLabel(CONFIG.mixer.unknown_label);

const $ = (id) => document.getElementById(id);
const mixer = new Mixer();
const audio = mixer; // same API as an <audio> element (currentTime, play, pause, ...)
const ANALYSIS_SR = 11025;
const HOP = 128;

const state = {
  feat: null, seg: null, song: null, layout: null, title: '',
  selected: null, loop: null, loopOn: false, metro: false, countIn: false,
  speed: 1, playing: false, countingIn: false,
  tabTrack: null, // id of the track the tab is transcribed from
};

/* ---------- settings ---------- */
for (const [k, t] of Object.entries(TUNINGS)) {
  const o = document.createElement('option'); o.value = k; o.textContent = t.name; $('tuning').appendChild(o);
}
function applyConfigDefaults() {
  const c = CONFIG;
  const set = (id, v) => { if (v !== undefined && v !== '') { $(id).value = v; $(id).dispatchEvent(new Event('input')); } };
  if (c.instrument.tuning !== 'auto' && TUNINGS[c.instrument.tuning]) { $('tuning').value = c.instrument.tuning; $('tuning').dataset.auto = 'no'; }
  else $('tuning').dataset.auto = '';
  set('max-fret', c.instrument.frets);
  set('grid', +c.rhythm.grid === 16 ? 4 : 2);
  set('beats', c.rhythm.beats_per_bar);
  set('sens', c.detection.onset_sensitivity);
  set('min-note', c.detection.min_note_ms);
  set('min-conf', c.detection.pitch_confidence);
  set('gate', c.detection.noise_gate_db);
  set('vol-synth', c.playback.tab_synth_volume);
  if (SYNTH_PRESETS[c.playback.synth_preset]) $('synth-preset').value = c.playback.synth_preset;
  set('vol-metro', c.playback.metronome_volume);
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
  transpose: state.transpose || 0,
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

const AUDIO_RE = /\.(wav|wave|mp3|m4a|aac|mp4|ogg|oga|opus|flac|aif|aiff|caf|webm)$/i;
const PROJECT_RE = /\.(basstab|json)$/i;
const baseName = (n) => n.replace(/\.[^.]+$/, '');
// "My Song - bass.wav" -> "My Song"
const songTitle = (n) => baseName(n)
  .replace(/\s*-\s*(bass|drums|vocals|other|guitar|piano|keys|metronome)(-.*)?$/i, '') // "Song - bass", Moises "Song-bass-D minor-119bpm-440hz"
  .trim() || baseName(n);
const guessBass = (tracks) => {
  const key = String(CONFIG.mixer.tab_track_match || 'bass').toLowerCase();
  return tracks.find((t) => t.name.toLowerCase().includes(key)) || tracks[0];
};

/** Entry point for files from the picker, drag & drop or a folder. */
async function openFiles(fileList, { add = false } = {}) {
  const files = [...fileList];
  const project = files.find((f) => PROJECT_RE.test(f.name));
  const audioFiles = files.filter((f) => f !== project && (AUDIO_RE.test(f.name) || f.type.startsWith('audio/')));
  try {
    if (project) return await loadProject(JSON.parse(await project.text()), audioFiles, baseName(baseName(project.name)));
    if (!audioFiles.length) {
      if (files.length) alert('No audio files found. Choose WAV, MP3, M4A (or a saved .basstab project).');
      return;
    }
    if (add && state.song) await addTracks(audioFiles);
    else await newProject(audioFiles);
  } catch (err) {
    console.error(err);
    alert(err.message || String(err));
    showView(state.song ? 'song' : 'empty');
  }
}

async function decodeAll(files, opts = () => ({})) {
  const out = [];
  for (let i = 0; i < files.length; i++) {
    setProgress(`Loading ${files[i].name}…`, 0.02 + 0.06 * (i / files.length));
    try { out.push(await mixer.addFile(files[i], opts(files[i]))); }
    catch (e) { console.error(e); alert(`Couldn't decode "${files[i].name}" as audio. Try WAV, MP3 or M4A.`); }
  }
  return out;
}

async function newProject(files) {
  pause();
  showView('progress');
  mixer.clear();
  state.feat = null; state.seg = null; state.song = null;
  state.loop = null; state.loopOn = false; state.selected = null; mixer.setLoop(null);
  setTranspose(0);
  if (CONFIG.instrument.tuning !== 'auto' && TUNINGS[CONFIG.instrument.tuning]) $('tuning').dataset.auto = 'no';
  else $('tuning').dataset.auto = '';
  const loaded = await decodeAll(files);
  if (!loaded.length) { showView('empty'); return; }
  const tab = guessBass(loaded.map((l) => l.track));
  state.title = songTitle(tab.name);
  await transcribeTrack(tab.id, loaded.find((l) => l.track === tab).buffer, { tempo: true, tuning: true });
  renderMixer();
}

async function addTracks(files) {
  const loaded = await decodeAll(files);
  renderMixer();
  if (loaded.length) toast(`Added ${loaded.map((l) => l.track.name).join(', ')}`);
}

/** Analyze one track and build the tab from it. */
async function transcribeTrack(id, buffer, { tempo = false, tuning = false, notes = null } = {}) {
  const track = mixer.tracks.find((t) => t.id === id);
  if (!buffer) buffer = await mixer.ctx.decodeAudioData(await track.file.arrayBuffer());
  showView('progress'); setProgress('Resampling…', 0.08);
  const len = Math.ceil(buffer.duration * ANALYSIS_SR);
  const off = new OfflineAudioContext(1, len, ANALYSIS_SR);
  const src = off.createBufferSource(); src.buffer = buffer; src.connect(off.destination); src.start();
  const samples = (await off.startRendering()).getChannelData(0).slice();
  state.feat = await analyze(samples);
  state.tabTrack = id;
  setProgress('Transcribing…', 1);
  showView('song');
  if (notes) {
    state.seg = { notes, tuningShift: 0, onsets: [] };
    rearrange();
  } else retranscribe(tempo, tuning);
  updateTime();
}

/* ---------- projects ---------- */
const SETTING_IDS = ['synth-preset', 'tuning', 'max-fret', 'bpm', 'offset', 'beats', 'grid', 'sens', 'min-note', 'min-conf', 'gate', 'vol-synth', 'vol-metro'];

function projectData() {
  const tab = mixer.tracks.find((t) => t.id === state.tabTrack);
  return {
    app: 'bass-tabs', version: 1, savedAt: new Date().toISOString(), title: state.title,
    tracks: mixer.tracks.map((t) => ({ name: t.name, size: t.size, vol: t.vol, mute: t.mute, solo: t.solo, tab: t.id === state.tabTrack, protect: t.protect || undefined, label: t.label, kind: t.kind, ...(t.remote ? { remote: t.remote } : {}) })),
    tabTrack: tab?.name || null,
    settings: Object.fromEntries(SETTING_IDS.map((id) => [id, $(id).value])),
    tuningManual: $('tuning').dataset.auto === 'no',
    speed: state.speed, transpose: state.transpose || 0, metro: state.metro, countIn: state.countIn,
    loop: state.loop ? { a: state.loop.a, b: state.loop.b, on: state.loopOn } : null,
    notes: state.seg ? state.seg.notes.map((n) => ({
      start: +n.start.toFixed(4), end: +n.end.toFixed(4), midi: n.midi, vel: +n.vel.toFixed(3),
      ...(n.legato ? { legato: true } : {}), ...(n.deleted ? { deleted: true } : {}), ...(n.pinned ? { pinned: n.pinned } : {}),
    })) : null,
  };
}

async function saveProject() {
  if (!state.song) return;
  const name = (state.title || 'bass-tab') + '.basstab';
  const blob = new Blob([JSON.stringify(projectData(), null, 1)], { type: 'application/json' });
  if (window.showSaveFilePicker) {
    try {
      const h = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Bass Tabs project', accept: { 'application/json': ['.basstab'] } }] });
      const w = await h.createWritable(); await w.write(blob); await w.close();
      toast('Project saved. Keep it in the same folder as the audio files.');
      return;
    } catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast('Project downloaded. Move it next to the audio files to reopen them together.');
}

async function loadProject(proj, files, fallbackTitle) {
  if (proj.app !== 'bass-tabs') throw new Error('That file is not a Bass Tabs project.');
  pause();
  showView('progress');
  mixer.clear(); state.feat = null; state.seg = null; state.song = null; state.selected = null;
  const byName = new Map(files.map((f) => [f.name.toLowerCase(), f]));
  const wanted = proj.tracks.map((t) => ({ t, f: byName.get(t.name.toLowerCase()) }));
  let missing = wanted.filter((w) => !w.f).map((w) => w.t.name);
  if (missing.length) {
    showView(state.song ? 'song' : 'empty');
    const remotes = Object.fromEntries(proj.tracks.filter((t) => t.remote).map((t) => [t.name, t.remote]));
    const extra = await askForMissing(missing, remotes);
    for (const f of extra) {
      const w = wanted.find((x) => !x.f && x.t.name.toLowerCase() === f.name.toLowerCase());
      if (w) w.f = f;
    }
    missing = wanted.filter((w) => !w.f).map((w) => w.t.name);
    showView('progress');
  }
  const loaded = await decodeAll(wanted.filter((w) => w.f).map((w) => w.f), (f) => {
    const t = proj.tracks.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
    return { vol: t.vol, mute: t.mute, solo: t.solo, protect: t.protect, remote: t.remote, label: t.label, kind: t.kind };
  });
  for (const [id, v] of Object.entries(proj.settings || {})) if ($(id)) { $(id).value = v; $(id).dispatchEvent(new Event('input')); }
  $('tuning').dataset.auto = proj.tuningManual ? 'no' : '';
  state.title = proj.title || fallbackTitle;
  setSpeed(proj.speed || 1);
  state.transpose = 0; setTranspose(proj.transpose || 0);
  state.metro = !!proj.metro; $('metro').classList.toggle('on', state.metro);
  state.countIn = !!proj.countIn; $('countin').classList.toggle('on', state.countIn);
  if (!loaded.length) {
    showView('empty');
    alert(`None of this project's audio files were selected.\nChoose the project together with: ${proj.tracks.map((t) => t.name).join(', ')}`);
    return;
  }
  const tab = loaded.find((l) => l.track.name.toLowerCase() === (proj.tabTrack || '').toLowerCase()) || loaded[0];
  const notes = tab.track.name.toLowerCase() === (proj.tabTrack || '').toLowerCase() && proj.notes
    ? proj.notes.map((n, i) => ({ ...n, id: i, legato: !!n.legato, fromOnset: true }))
    : null;
  await transcribeTrack(tab.track.id, tab.buffer, { notes, tempo: !notes });
  if (proj.loop) { state.loop = { a: proj.loop.a, b: proj.loop.b }; setLoopOn(!!proj.loop.on); if (!proj.loop.on) { state.loop = { a: proj.loop.a, b: proj.loop.b }; applyLoopHighlight(); } }
  renderMixer();
  if (missing.length) alert(`Still missing (you can add them later from the Mixer):\n${missing.join('\n')}`);
  else toast(`Opened "${state.title}"`);
}

/** Ask the user to locate a project's audio files. Resolves to File[] (possibly empty). */
function askForMissing(names, remotes = {}) {
  const dlg = $('missing');
  $('missing-list').innerHTML = names.map((n) => `<li>${n.replace(/</g, '&lt;')}</li>`).join('');
  $('missing-folder').hidden = !window.showDirectoryPicker;
  const fromHelper = names.filter((n) => remotes[n]);
  $('missing-helper').hidden = !(helper.url && fromHelper.length);
  return new Promise((resolve) => {
    const done = (files) => { dlg.close(); resolve(files); };
    $('missing-helper').onclick = async () => {
      $('missing-helper').textContent = 'Fetching…';
      const files = [];
      for (const n of fromHelper) {
        try { const r = await fetchStem(remotes[n]); files.push(new File([r.file], n, { type: 'audio/wav' })); }
        catch (e) { console.warn(e); }
      }
      $('missing-helper').textContent = 'Get stems from the helper';
      done(files);
    };
    $('missing-files').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; done(f); };
    $('missing-folder').onclick = async () => {
      try {
        const dir = await window.showDirectoryPicker();
        const want = new Set(names.map((n) => n.toLowerCase()));
        const found = [];
        for await (const h of dir.values()) if (h.kind === 'file' && want.has(h.name.toLowerCase())) found.push(await h.getFile());
        done(found);
      } catch (e) { if (e.name !== 'AbortError') alert(e.message); }
    };
    $('missing-skip').onclick = () => done([]);
    dlg.oncancel = () => resolve([]);
    dlg.showModal();
  });
}

/* ---------- stem separation (PC helper) ---------- */
function renderHelperStatus() {
  const st = $('helper-status');
  if (helper.url) {
    st.textContent = `Connected: ${helper.url} (${helper.info.device === 'cuda' ? 'GPU' : 'CPU'})`;
    st.className = 'small ok';
  } else {
    st.textContent = 'Not connected. Start the helper on your PC (helper/start.bat) and open the app from it, or enter its address.';
    st.className = 'small muted';
  }
  $('helper-url').value = helper.url || CONFIG.helper.url || '';
  renderMixer();
}
$('helper-connect').onclick = async () => {
  $('helper-status').textContent = 'Connecting…';
  await setHelperUrl($('helper-url').value);
  renderHelperStatus();
  if (!helper.url) $('helper-status').textContent = "Couldn't reach a helper at that address.";
};

let splitAbort = null;
function openSplit(track) {
  const dlg = $('split');
  $('split-name').textContent = track.name;
  const sel = $('split-model');
  sel.innerHTML = Object.entries(helper.info.models).map(([k, v]) => `<option value="${k}">${k} — ${v}</option>`).join('');
  $('split-progress').hidden = true; $('split-msg').textContent = '';
  $('split-start').disabled = false;
  $('split-start').onclick = () => runSplit(track, sel.value);
  $('split-cancel').onclick = () => { splitAbort?.abort(); dlg.close(); };
  dlg.showModal();
}

async function runSplit(track, model) {
  const fill = $('split-fill'), msg = $('split-msg');
  $('split-progress').hidden = false; $('split-start').disabled = true;
  splitAbort = new AbortController();
  const phases = { upload: [0, 0.1], separate: [0.1, 0.9], download: [0.9, 1] };
  try {
    msg.textContent = 'Preparing audio…';
    let wav = track.file;
    if (!/\.wav$/i.test(track.name)) {
      const buf = await ctx.decodeAudioData(await track.file.arrayBuffer());
      wav = encodeWav([...Array(buf.numberOfChannels).keys()].map((c) => buf.getChannelData(c)), buf.sampleRate);
    }
    const stems = await separate(wav, track.name, model, ({ phase, progress, message }) => {
      const [a, b] = phases[phase];
      fill.style.width = Math.round((a + (b - a) * (progress || 0)) * 100) + '%';
      msg.textContent = message || '';
    }, splitAbort.signal);
    msg.textContent = 'Adding stems…';
    const base = baseName(track.name);
    const added = [];
    for (const s of stems) {
      const name = `${base} - ${s.name}`;
      const { track: nt } = await mixer.addFile(new File([s.file], name, { type: 'audio/wav' }), { remote: s.remote });
      added.push(nt);
    }
    mixer.update(track.id, { mute: true });
    $('split').close();
    const bass = added.find((t) => /- bass\.wav$/i.test(t.name));
    if (bass && state.tabTrack === track.id) {
      state.title = base;
      await transcribeTrack(bass.id, null, { tempo: true, tuning: true });
      toast(`Added ${added.length} stems. The tab is now made from the bass stem; the original is muted.`);
    } else toast(`Added ${added.length} stems; the original track is muted.`);
    renderMixer();
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error(e);
    msg.textContent = 'Error: ' + e.message;
    $('split-start').disabled = false;
  }
}

/* ---------- mixer panel ---------- */
function updateSub() {
  const nt = mixer.tracks.length;
  $('song-sub').textContent = (state.subBase || '') + (nt > 1 ? ` · ${nt} tracks` : '');
}
mixer.addEventListener('tracks', updateSub);
function renderMixer() {
  const list = $('mixer-tracks');
  list.innerHTML = '';
  for (const t of mixer.tracks) {
    const row = document.createElement('div');
    row.className = 'mix-row';
    autoLabel(t);
    const K = KINDS[t.kind] || KINDS.other;
    const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    row.innerHTML = `
      <label class="tab-src" title="Make the tab from this track"><input type="radio" name="tabsrc" ${t.id === state.tabTrack ? 'checked' : ''}><span>TAB</span></label>
      <button class="ticon" style="--c:${K.color}" title="Instrument: ${K.label} (click to change)" aria-label="Instrument: ${K.label}">${K.icon}</button>
      <div class="mix-meta">
        <input class="mix-label" value="${esc(t.label)}" aria-label="Track label" spellcheck="false">
        <span class="mix-file" title="${esc(t.name)}">${esc(t.name)}</span>
      </div>
      <button class="ms ${t.mute ? 'on' : ''}" data-k="mute" title="Mute">M</button>
      <button class="ms solo ${t.solo ? 'on' : ''}" data-k="solo" title="Solo">S</button>
      <button class="ms lock ${t.protect ? 'on' : ''}" data-k="protect" title="Keep original pitch when transposing (e.g. your own recording)" aria-label="Protect from transpose">🔒</button>
      <input type="range" min="0" max="1" step="0.01" value="${t.vol}" aria-label="Volume of ${esc(t.label)}">
      ${helper.url ? '<button class="ms split" title="Split into stems with Demucs">✂</button>' : ''}
      <button class="x rm" title="Remove track" aria-label="Remove track">×</button>`;
    const lab = row.querySelector('.mix-label');
    lab.onchange = () => { t.label = lab.value.trim() || K.label; lab.value = t.label; };
    lab.onkeydown = (e) => { if (e.key === 'Enter' || e.key === 'Escape') lab.blur(); };
    row.querySelector('.ticon').onclick = (e) => openKindMenu(t, e.currentTarget);
    row.querySelector('.split')?.addEventListener('click', () => openSplit(t));
    row.querySelector('input[type=range]').oninput = (e) => mixer.update(t.id, { vol: +e.target.value });
    row.querySelectorAll('.ms[data-k]').forEach((b) => (b.onclick = () => {
      mixer.update(t.id, { [b.dataset.k]: !t[b.dataset.k] }); b.classList.toggle('on', t[b.dataset.k]);
    }));
    row.querySelector('.rm').onclick = () => {
      if (t.id === state.tabTrack && !confirm(`"${t.label}" is the track the tab was made from. Remove it anyway? (The tab stays.)`)) return;
      mixer.removeTrack(t.id);
      if (t.id === state.tabTrack) state.tabTrack = null;
      renderMixer(); updateTime();
    };
    row.querySelector('input[type=radio]').onchange = async () => {
      if (!confirm(`Make the tab from "${t.label}"? This re-runs detection and discards note edits.`)) { renderMixer(); return; }
      pause();
      state.title = baseName(t.name);
      await transcribeTrack(t.id, null, { tempo: true, tuning: true });
      renderMixer();
    };
    list.appendChild(row);
  }
  $('mixer-empty').hidden = mixer.tracks.length > 0;
}

function openKindMenu(t, anchor) {
  const m = $('kind-menu');
  m.innerHTML = Object.entries(KINDS).map(([k, K]) =>
    `<button data-k="${k}" class="${k === t.kind ? 'on' : ''}"><span class="ticon" style="--c:${K.color}">${K.icon}</span>${K.label}</button>`).join('');
  const r = anchor.getBoundingClientRect();
  m.style.left = Math.min(r.left, window.innerWidth - 180) + 'px';
  m.style.bottom = (window.innerHeight - r.top + 6) + 'px';
  m.hidden = false;
  m.querySelectorAll('button').forEach((b) => (b.onclick = () => {
    const old = KINDS[t.kind]?.label;
    t.kind = b.dataset.k;
    if (!t.label || t.label === old) t.label = KINDS[t.kind].label; // keep custom labels
    m.hidden = true;
    renderMixer();
  }));
  setTimeout(() => document.addEventListener('pointerdown', function close(e) {
    if (!m.contains(e.target)) { m.hidden = true; document.removeEventListener('pointerdown', close); }
  }), 0);
}

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (el.hidden = true), 3500);
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
// "...-119bpm-..." (Moises) or "120 BPM" in a track's file name
function bpmFromNames() {
  for (const t of mixer.tracks) {
    const m = t.name.match(/(?:^|[^0-9.])(\d{2,3}(?:\.\d+)?)\s*bpm(?![a-z])/i);
    if (m && +m[1] >= 40 && +m[1] <= 250) return +m[1];
  }
  return 0;
}
function autoTempo() {
  const hint = bpmFromNames();
  const { bpm, offset } = estimateTempo(state.feat, state.seg.notes, +$('beats').value, hint);
  if (hint) toast(`Tempo ${hint} BPM taken from the file name.`);
  $('bpm').value = bpm; $('offset').value = offset;
}
function rearrange() {
  if (!state.seg) return;
  const o = arrOpts();
  state.song = arrange(state.seg.notes, o);
  // playback order + slide chains (legato note that starts where the previous one ends)
  state.playList = state.song.notes.filter((n) => !n.hidden).sort((a, b) => a.qStart - b.qStart);
  state.playList.forEach((n, i) => {
    const prev = state.playList[i - 1];
    n.chainNext = null;
    n.chainPrev = n.legato && prev && Math.abs(n.qStart - prev.qEnd) < state.song.slotDur / 2 ? prev : null;
    if (n.chainPrev) prev.chainNext = n;
  });
  $('offset').value = Math.round(state.song.offset * 1000) / 1000;
  const cents = Math.round(state.seg.tuningShift * 100);
  $('tuning-info').textContent = `Detected ${state.song.notes.length} notes. Recording is tuned ${
    Math.abs(cents) < 4 ? 'to A440' : (cents > 0 ? '+' : '') + cents + ' cents from A440'}.`;
  const t = o.tuning.strings.map((m) => noteName(m, false)).join(' ');
  $('song-title').textContent = state.title || 'Untitled';
  const tr = o.transpose ? ` · transposed ${o.transpose > 0 ? '+' : '−'}${Math.abs(o.transpose)}` : '';
  state.subBase = `Electric Bass · ${t} · ${o.bpm} BPM · ${state.song.bars.length} bars${tr}`;
  updateSub();
  $('save').hidden = false;
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
const ctx = mixer.ctx;
const synthGain = ctx.createGain(), metroGain = ctx.createGain();
synthGain.connect(ctx.destination); metroGain.connect(ctx.destination);
function applyVolumes() {
  synthGain.gain.value = +$('vol-synth').value * 1.5;
  metroGain.gain.value = +$('vol-metro').value;
}
$('vol-synth').addEventListener('input', applyVolumes);
for (const [k, P] of Object.entries(SYNTH_PRESETS)) {
  const o = document.createElement('option'); o.value = k; o.textContent = P.label; $('synth-preset').appendChild(o);
}
// Audition a preset: a short bass phrase, even if the synth fader is down.
$('synth-preset').addEventListener('change', async () => {
  if (ctx.state !== 'running') await ctx.resume();
  const g = ctx.createGain(); g.gain.value = Math.max(0.5, +$('vol-synth').value) * 1.5; g.connect(ctx.destination);
  const t = ctx.currentTime + 0.05, pr = $('synth-preset').value;
  [[28, 0, 0.22], [28, 0.25, 0.22], [40, 0.5, 0.22], [31, 0.75, 0.22], [33, 1.0, 0.45]]
    .forEach(([m, at, d]) => pluck(ctx, g, t + at, m, d, 0.8, [], 0.06, pr));
});
$('vol-metro').addEventListener('input', applyVolumes);
applyVolumes();

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
  if (ctx.state !== 'running') await ctx.resume();
  audio.playbackRate = state.speed;
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
function stop() { pause(); audio.currentTime = 0; }
function toggle() {
  if (state.playing || state.countingIn) pause(); else { state.wantPlay = true; play(); }
}
function setPlayIcon(on) { $('play').textContent = on ? '❚❚' : '▶'; $('play').setAttribute('aria-label', on ? 'Pause' : 'Play'); }
audio.addEventListener('play', () => { state.playing = true; setPlayIcon(true); resetSched(); });
audio.addEventListener('pause', () => { state.playing = false; if (!state.countingIn) setPlayIcon(false); clearActive(); });
audio.addEventListener('ended', () => { state.playing = false; setPlayIcon(false); });

function setSpeed(s) {
  const pb = CONFIG.playback;
  state.speed = Math.round(Math.max(pb.min_speed_percent / 100, Math.min(pb.max_speed_percent / 100, s)) * 100) / 100;
  audio.playbackRate = state.speed;
  $('speed').textContent = Math.round(state.speed * 100) + '%';
  resetSched();
}

function setTranspose(semis) {
  semis = Math.max(-12, Math.min(12, Math.round(semis)));
  state.transpose = semis;
  mixer.transpose = semis;
  $('transpose').textContent = semis > 0 ? `+${semis}` : semis < 0 ? `−${-semis}` : '0';
  $('transpose').classList.toggle('on', semis !== 0);
  resetSched();
  if (state.seg) rearrange();
}

function seek(t) {
  audio.currentTime = Math.max(0, Math.min(t, audio.duration || t));
  resetSched(); updateCursor(true); updateTime();
}

/* ---------- scheduling & cursor ---------- */
let schedT = 0, lastT = 0, wrapDone = null, passStart = 0;
function resetSched() { schedT = audio.currentTime; lastT = audio.currentTime; wrapDone = null; passStart = schedT; }

// Schedule synth notes and metronome clicks with times in [from, to).
// `at(t)` converts a song time to an AudioContext time.
// Slides/legato: a chain of notes is played as ONE voice that glides in pitch,
// so only the first note of the chain is plucked.
function scheduleRange(from, to, at, lr, pass) {
  if (to <= from) return;
  const song = state.song;
  if (+$('vol-synth').value > 0) {
    for (const n of state.playList) {
      if (n.qStart < from) continue;
      if (n.qStart >= to) break;
      if (lr && n.qStart >= lr[1]) continue;
      const p = n.chainPrev;
      if (p && p.qStart >= pass && (!lr || p.qStart >= lr[0])) continue; // already sounding as part of a slide
      const glides = [];
      let last = n;
      while (last.chainNext && (!lr || last.chainNext.qStart < lr[1])) {
        last = last.chainNext;
        glides.push({ at: (last.qStart - n.qStart) / state.speed, midi: last.pm });
      }
      const end = lr ? Math.min(last.qEnd, lr[1]) : last.qEnd;
      pluck(ctx, synthGain, at(n.qStart), n.pm, ((end - n.qStart) / state.speed) * 0.95, n.vel,
        glides, CONFIG.playback.slide_time_ms / 1000 / state.speed, $('synth-preset').value);
    }
  }
  if (state.metro) {
    const P = 60 / song.bpm, bpb = song.beatsPerBar;
    for (let k = Math.ceil((from - song.offset) / P - 1e-9); song.offset + k * P < to; k++) {
      const bt = song.offset + k * P;
      if (bt < 0 || (lr && bt >= lr[1] - 1e-3)) continue;
      click(ctx, metroGain, at(bt), ((k % bpb) + bpb) % bpb === 0);
    }
  }
}

function tick() {
  requestAnimationFrame(tick);
  if (!state.song) return;
  let t = audio.currentTime;
  if (state.playing) {
    const lr = state.loopOn && loopRange();
    if (t < lastT - 0.02) { schedT = wrapDone ?? t; wrapDone = null; passStart = lr ? lr[0] : t; }   // loop wrapped
    else if (t - lastT > 0.5) resetSched();
    lastT = t;
    const now = ctx.currentTime;
    const at = (et) => now + Math.max(0, (et - t) / state.speed);
    const horizon = t + 0.15 * state.speed;
    if (lr && t < lr[1] && horizon >= lr[1]) {
      // schedule up to the loop end, then the start of the next pass
      scheduleRange(schedT, lr[1], at, lr, passStart);
      schedT = lr[1];
      const from = wrapDone ?? lr[0], to = lr[0] + (horizon - lr[1]);
      scheduleRange(from, to, (et) => now + Math.max(0, (lr[1] - t + et - lr[0]) / state.speed), lr, lr[0]);
      wrapDone = Math.max(from, to);
    } else if (horizon > schedT) {
      scheduleRange(schedT, horizon, at, lr, passStart);
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
  mixer.setLoop(a, b);
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
  mixer.setLoop(state.loopOn ? state.loop.a : null, state.loopOn ? state.loop.b : null);
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
// Drag-to-loop: on by default with a mouse, off on touch screens (so dragging scrolls).
const LS_DRAG = 'bassTabs.dragToLoop';
function initDragToLoop() {
  let v = CONFIG.playback.drag_to_loop;
  try { const ls = localStorage.getItem(LS_DRAG); if (ls !== null) v = ls === '1'; } catch {}
  if (v === 'auto' || v === '' || v === undefined) v = !matchMedia('(pointer: coarse)').matches;
  setDragToLoop(!!v, false);
}
function setDragToLoop(on, remember = true) {
  state.dragToLoop = on;
  $('drag-loop').checked = on;
  $('tab-host').classList.toggle('drag-loop', on);
  $('hint-drag').textContent = on ? 'drag to set a loop (or use In / Out)' : 'use In / Out to set a loop';
  if (remember) try { localStorage.setItem(LS_DRAG, on ? '1' : '0'); } catch {}
}
$('drag-loop').onchange = (e) => setDragToLoop(e.target.checked);
window.addEventListener('pointercancel', () => { drag = null; }); // browser took over (scrolling)

$('tab-host').addEventListener('pointerdown', (e) => {
  if (!state.layout || e.button !== 0) return;
  const [x, y] = svgPoint(e);
  const hit = timeAt(state.layout, state.song, x, y);
  const noteEl = e.target.closest('.note');
  drag = { x0: e.clientX, y0: e.clientY, t0: hit?.t, hit, noteId: noteEl ? +noteEl.dataset.id : null, moved: false };
});
window.addEventListener('pointermove', (e) => {
  if (!drag || drag.t0 == null || !state.dragToLoop) return;
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
  $('insp-title').textContent = `${noteName(n.pm)} — ${strName(n.string)} string, fret ${n.fret}` +
    (n.outOfRange ? ' (out of range)' : '');
  const chips = $('insp-pos'); chips.innerHTML = '';
  for (const c of positionsFor(n.pm, tuning, arrOpts().maxFret)) {
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
  const pos = positionsFor(n.pm, state.song.tuning, arrOpts().maxFret);
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
// Make the selected note beat 1 of a bar (keeps the tempo; earlier notes become a pickup).
function useAsDownbeat() {
  const n = state.song?.notes.find((x) => x.id === state.selected);
  if (!n) return;
  $('offset').value = n.start.toFixed(3);
  rearrange();
  toast('Bar lines moved: this note is now on beat 1.');
}
$('insp-downbeat').onclick = useAsDownbeat;

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
$('export-midi').onclick = () => {
  if (!state.song) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(toMidi(state.song, { title: state.title || 'Bass', program: SYNTH_PRESETS[$('synth-preset').value]?.gm ?? 33 }));
  a.download = (state.title || 'bass-tab') + '.mid';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('copy-txt').onclick = async () => {
  try { await navigator.clipboard.writeText(asciiTab()); $('copy-txt').textContent = 'Copied!'; }
  catch { $('copy-txt').textContent = 'Copy failed'; }
  setTimeout(() => ($('copy-txt').textContent = 'Copy tab'), 1500);
};

/* ---------- wiring ---------- */
const pick = (id, opts) => $(id).addEventListener('change', (e) => { openFiles(e.target.files, opts); e.target.value = ''; });
pick('file'); pick('file2'); pick('add-file', { add: true });
$('save').onclick = saveProject;
function toggleKeys() { $('keys').hidden = !$('keys').hidden; }
$('keys-btn').onclick = toggleKeys;
$('keys-close').onclick = toggleKeys;
$('mixer-btn').onclick = () => { $('mixer').hidden = !$('mixer').hidden; $('mixer-btn').classList.toggle('on', !$('mixer').hidden); };
$('mixer-close').onclick = () => { $('mixer').hidden = true; $('mixer-btn').classList.remove('on'); };
const demo = async () => {
  showView('progress'); setProgress('Generating demo…', 0.01);
  await new Promise((r) => setTimeout(r, 20));
  const { samples, drums, sr } = makeDemo();
  await openFiles([
    new File([encodeWav(samples, sr)], 'Demo bass.wav', { type: 'audio/wav' }),
    new File([encodeWav(drums, sr)], 'Demo drums.wav', { type: 'audio/wav' }),
  ]);
};
$('demo').onclick = demo; $('demo2').onclick = demo;

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging');
  if (e.dataTransfer.files.length) openFiles(e.dataTransfer.files, { add: !!state.song && ![...e.dataTransfer.files].some((f) => PROJECT_RE.test(f.name)) });
});

$('play').onclick = toggle;
$('rewind').onclick = () => seek(state.loopOn && loopRange() ? loopRange()[0] : 0);
$('key-down').onclick = () => setTranspose((state.transpose || 0) - 1);
$('key-up').onclick = () => setTranspose((state.transpose || 0) + 1);
$('transpose').onclick = () => setTranspose(0);
$('slower').onclick = () => setSpeed(state.speed - STEP);
$('faster').onclick = () => setSpeed(state.speed + STEP);
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
// Make room for the settings drawer (wide screens) so it doesn't cover the tab.
new MutationObserver(() => {
  const open = !$('settings').hidden;
  if (document.body.classList.contains('drawer-open') === open) return;
  document.body.classList.toggle('drawer-open', open);
  requestAnimationFrame(render);
}).observe($('settings'), { attributes: true, attributeFilter: ['hidden'] });
$('settings-close').onclick = () => ($('settings').hidden = true);

const STEP = (CONFIG.playback.speed_step_percent || 5) / 100;
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
  else if ((k === 'b' || k === 'B') && state.selected != null) useAsDownbeat();
  else if (k === 'm' || k === 'M') $('metro').click();
  else if (k === '[') setSpeed(state.speed - STEP);
  else if (k === ']') setSpeed(state.speed + STEP);
  else if (k === 'Home') { e.preventDefault(); $('rewind').click(); }
  else if (k === '?') toggleKeys();
  else if (k === 'Escape') { selectNote(null); $('settings').hidden = true; $('keys').hidden = true; }
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

applyConfigDefaults();
applyVolumes();
initDragToLoop();
connectHelper(CONFIG.helper.url).then(renderHelperStatus);
state.metro = !!CONFIG.playback.metronome; $('metro').classList.toggle('on', state.metro);
state.countIn = !!CONFIG.playback.count_in; $('countin').classList.toggle('on', state.countIn);
setSpeed(1);
requestAnimationFrame(tick);
window.__bassTabs = state; // for debugging
window.__mixer = mixer;
