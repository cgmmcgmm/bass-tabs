// Track kinds: auto-detection from file names, labels, colours and icons.

const svg = (body) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

export const KINDS = {
  bass: {
    label: 'Bass', color: '#00a651',
    icon: svg('<path d="M21 3l-8.5 8.5"/><path d="M19 2.5l2.5 2.5"/><path d="M10.6 10.4c-1.6-.9-3.6-.6-4.6.6-.8.9-.6 1.8-1.5 2.5-.9.7-2.3.6-3 1.8-.8 1.4 0 3.4 1.8 4.6 1.6 1.2 3.6 1.3 4.6.2.8-.9.4-2.1 1.2-2.9.8-.8 2.2-.6 3-1.6 1-1.2.9-3.3-.4-4.6z"/><path d="M5.5 16l2 2"/>'),
  },
  guitar: {
    label: 'Guitar', color: '#e67e22',
    icon: svg('<path d="M19.5 4.5L13 11"/><path d="M18 3l3 3"/><path d="M12.2 9.3c-1.9-1.2-4.4-1-5.7.6-1 1.2-.6 2.3-1.7 3.2-1.1.9-2.7.7-3.4 2.2-.9 1.8.2 4 2.4 5.2 2 1.1 4.3 1 5.4-.4.9-1.1.4-2.5 1.3-3.5 1-1 2.6-.8 3.5-2.1 1.1-1.5.4-3.9-1.8-5.2z"/><circle cx="8" cy="15.5" r="1.4"/>'),
  },
  drums: {
    label: 'Drums', color: '#e74c3c',
    icon: svg('<ellipse cx="12" cy="10" rx="8" ry="3"/><path d="M4 10v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/><path d="M8 3l3 6M16 3l-3 6"/>'),
  },
  vocals: {
    label: 'Vocals', color: '#9b59b6',
    icon: svg('<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5v4M8.5 21.5h7"/>'),
  },
  keys: {
    label: 'Keys', color: '#2e86de',
    icon: svg('<rect x="2.5" y="5" width="19" height="14" rx="1.5"/><path d="M7.5 5v14M12 5v14M16.5 5v14"/><path d="M5.8 5v7M10 5v7M14.2 5v7M18.6 5v7" stroke-width="2.6"/>'),
  },
  other: {
    label: 'Other', color: '#7f8c8d',
    icon: svg('<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>'),
  },
  backing: {
    label: 'Backing track', color: '#16a085',
    icon: svg('<path d="M12 3l9 4.5-9 4.5-9-4.5z"/><path d="M3 12l9 4.5 9-4.5"/><path d="M3 16.5L12 21l9-4.5"/>'),
  },
  unknown: {
    label: 'Unknown', color: '#95a5a6',
    icon: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.7.4-1.1 1-1.1 1.8v.5"/><circle cx="12" cy="17" r=".6" fill="currentColor"/>'),
  },
  mix: {
    label: 'Full mix', color: '#34495e',
    icon: svg('<path d="M3 12h1M6 8v8M9 5v14M12 9v6M15 6v12M18 9v6M21 12h0"/>'),
  },
};

// Default auto-label keywords (overridable in config.yaml -> auto_labels).
// First matching kind wins, top to bottom. A keyword matches at the start of a word,
// so "drum" matches "Drums" and "gtr" matches "Gtr2".
export const DEFAULT_AUTO_LABELS = {
  other: 'other',
  bass: 'bass',
  drums: 'drum, kit, perc, kick, snare, cymbal, hihat, hi-hat',
  backing: 'backing, playalong, play-along, minus',
  vocals: 'vocal, vox, voice, sing, choir',
  guitar: 'guitar, gtr',
  keys: 'piano, keys, keyboard, organ, synth, rhodes',
  mix: 'mix, master, full, original',
};

let RULES = [];
export function setAutoLabels(map) {
  RULES = Object.entries(map || DEFAULT_AUTO_LABELS)
    .filter(([k]) => KINDS[k])
    .map(([k, words]) => {
      const list = String(words).split(',').map((w) => w.trim().toLowerCase()).filter(Boolean)
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      return [k, list.length ? new RegExp(`(^|[^a-z0-9])(${list.join('|')})`, 'i') : null];
    })
    .filter(([, re]) => re);
}
setAutoLabels(DEFAULT_AUTO_LABELS);

/** Guess a kind from a file name. Stems from Demucs/Moises end in "- bass", "- other", ... */
export function detectKind(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '');
  const tail = base.split(/\s+-\s+/).pop(); // "Song - bass" -> "bass"
  for (const part of [tail, base]) {
    const n = part.replace(/[_.]+/g, ' ');
    for (const [k, re] of RULES) if (re.test(n)) return k;
  }
  return null;
}

let unknownLabel = 'Unknown';
export function setUnknownLabel(l) { if (l) unknownLabel = String(l); }

/** Fill in kind + label for a track if missing. */
export function autoLabel(track) {
  if (!track.kind) track.kind = detectKind(track.name) || 'unknown';
  if (!track.label) track.label = track.kind === 'unknown' ? unknownLabel : KINDS[track.kind].label;
  return track;
}
