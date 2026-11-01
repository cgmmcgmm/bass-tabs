// Loads config.yaml (a small YAML subset: sections, key: value, comments).

export const DEFAULTS = {
  instrument: { tuning: 'auto', frets: 20 },
  rhythm: { grid: 8, beats_per_bar: 4 },
  detection: { onset_sensitivity: 0.55, min_note_ms: 60, pitch_confidence: 0.7, noise_gate_db: -34 },
  playback: {
    speed_step_percent: 5, min_speed_percent: 25, max_speed_percent: 150, count_in: false, metronome: false,
    metronome_volume: 0.6, tab_synth_volume: 0, slide_time_ms: 60,
  },
  mixer: { tab_track_match: 'bass' },
  helper: { url: '' },
};

function parseValue(v) {
  if (/^".*"$|^'.*'$/.test(v)) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === '' || v === 'null' || v === '~') return '';
  if (/^-?\d+(\.\d+)?$/.test(v)) return +v;
  return v;
}

export function parseYaml(text) {
  const out = {};
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    // strip comments that aren't inside quotes
    let line = '', q = null;
    for (const ch of raw) {
      if (q) { if (ch === q) q = null; }
      else if (ch === '"' || ch === "'") q = ch;
      else if (ch === '#') break;
      line += ch;
    }
    if (!line.trim()) continue;
    const m = line.match(/^(\s*)([\w-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const [, indent, key, val] = m;
    if (!indent && val === '') { section = out[key] = out[key] || {}; continue; }
    if (indent && section) section[key] = parseValue(val);
    else out[key] = parseValue(val);
  }
  return out;
}

export async function loadConfig() {
  const cfg = structuredClone(DEFAULTS);
  try {
    const r = await fetch(new URL('../config.yaml', import.meta.url), { cache: 'no-cache' });
    if (r.ok) {
      const user = parseYaml(await r.text());
      for (const [sec, vals] of Object.entries(user)) {
        if (cfg[sec] && typeof vals === 'object') Object.assign(cfg[sec], vals);
      }
    }
  } catch (e) { console.warn('config.yaml not loaded, using defaults', e); }
  return cfg;
}
