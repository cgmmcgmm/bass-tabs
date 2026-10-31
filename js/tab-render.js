// SVG tab renderer (Songsterr-like layout).
import { noteName } from './transcribe.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};

const G = {
  gap: 13,         // px between strings
  top: 34,         // space above staff (bar numbers, tempo)
  rhythm: 44,      // space below staff for rhythm stems
  rowGap: 18,
  padL: 16, padR: 12,
  left: 34,        // room for string names
};

export function renderTab(svgHost, song, opts = {}) {
  const width = Math.max(320, opts.width || svgHost.clientWidth || 900);
  const nStr = song.tuning.strings.length;
  const staffH = (nStr - 1) * G.gap;
  const rowH = G.top + staffH + G.rhythm + G.rowGap;
  const upS = 4 / song.grid;

  // Bar widths from densest spacing.
  const barW = song.bars.map((bar) => {
    const notes = bar.events;
    let minGap = song.spb;
    for (let i = 1; i < notes.length; i++) minGap = Math.min(minGap, notes[i].slot - notes[i - 1].slot);
    if (notes.length) minGap = Math.min(minGap, song.spb - notes[notes.length - 1].slot);
    const slotW = Math.min(30, Math.max(8, 30 / Math.max(1, minGap)));
    return Math.max(130, G.padL + G.padR + song.spb * slotW);
  });

  // Pack rows, then justify.
  const avail = width - G.left - 8;
  const rows = [];
  let cur = [], curW = 0;
  barW.forEach((w, i) => {
    if (cur.length && curW + w > avail) { rows.push(cur); cur = []; curW = 0; }
    cur.push(i); curW += w;
  });
  if (cur.length) rows.push(cur);

  svgHost.innerHTML = '';
  const height = rows.length * rowH + 10;
  const svg = el('svg', { width, height, viewBox: `0 0 ${width} ${height}`, class: 'tab-svg' }, svgHost);
  const layers = {
    bg: el('g', { class: 'layer-bg' }, svg),
    staff: el('g', { class: 'layer-staff' }, svg),
    notes: el('g', { class: 'layer-notes' }, svg),
    cursor: el('g', { class: 'layer-cursor' }, svg),
  };

  const layout = { bars: [], rows: [], width, height, rowH, noteEls: new Map(), svg };

  rows.forEach((ids, r) => {
    const total = ids.reduce((s, i) => s + barW[i], 0);
    const isLast = r === rows.length - 1;
    const scale = isLast && total < avail * 0.75 ? 1 : avail / total;
    const y0 = r * rowH + G.top;
    layout.rows.push({ y: r * rowH, yStaff: y0, h: rowH });

    // string names
    song.tuning.strings.forEach((m, s) => {
      const y = y0 + (nStr - 1 - s) * G.gap;
      el('text', { x: G.left - 8, y: y + 3.5, class: 'str-name', 'text-anchor': 'end' }, layers.staff)
        .textContent = noteName(m, false);
    });

    let x = G.left;
    ids.forEach((bi, k) => {
      const w = barW[bi] * scale;
      const bar = song.bars[bi];
      const slotW = (w - G.padL - G.padR) / song.spb;
      const B = { index: bi, x, y: y0, w, slotW, row: r, start: bar.start, end: bar.end };
      layout.bars.push(B);

      // highlight rect (loop / current)
      B.bgEl = el('rect', { x, y: y0 - 22, width: w, height: staffH + 22 + G.rhythm - 8, class: 'bar-bg', 'data-bar': bi }, layers.bg);

      // strings
      for (let s = 0; s < nStr; s++) {
        const y = y0 + s * G.gap;
        el('line', { x1: x, x2: x + w, y1: y, y2: y, class: 'str-line' }, layers.staff);
      }
      // bar lines
      el('line', { x1: x, x2: x, y1: y0, y2: y0 + staffH, class: 'bar-line' }, layers.staff);
      if (k === ids.length - 1) {
        const end = bi === song.bars.length - 1;
        el('line', { x1: x + w, x2: x + w, y1: y0, y2: y0 + staffH, class: end ? 'bar-line end' : 'bar-line' }, layers.staff);
        if (end) el('line', { x1: x + w - 4, x2: x + w - 4, y1: y0, y2: y0 + staffH, class: 'bar-line' }, layers.staff);
      }
      el('text', { x: x + 3, y: y0 - 8, class: 'bar-num' }, layers.staff).textContent = bi + 1;
      if (bi === 0) {
        const t = el('text', { x: x + 26, y: y0 - 8, class: 'tempo' }, layers.staff);
        el('tspan', { class: 'q' }, t).textContent = '♩';
        el('tspan', {}, t).textContent = ` = ${song.bpm}`;
      }

      // events
      const stemTop = y0 + staffH + 8;
      const beamY = stemTop + 24;
      const beatGroups = new Map();
      for (const e of bar.events) {
        const ex = x + G.padL + e.slot * slotW;
        if (e.type === 'rest') { drawRest(layers.notes, ex, y0, staffH, e.units); continue; }
        const nt = e.note;
        const y = y0 + (nStr - 1 - nt.string) * G.gap;
        const g = el('g', { class: 'note' + (nt.outOfRange ? ' oor' : ''), 'data-id': nt.id }, layers.notes);
        const label = String(nt.fret);
        const tw = label.length * 7.4 + 4;
        el('rect', { x: ex - tw / 2, y: y - 7, width: tw, height: 14, rx: 3, class: 'note-bg' }, g);
        const txt = el('text', { x: ex, y: y + 4.5, 'text-anchor': 'middle', class: 'fret' }, g);
        txt.textContent = label;
        if (nt.legato) {
          const prevUp = nt.legatoDir !== undefined ? nt.legatoDir : 1;
          const x1 = ex - tw / 2 - 9, x2 = ex - tw / 2 - 1;
          el('line', { x1, x2, y1: y + (prevUp > 0 ? 5 : -5), y2: y + (prevUp > 0 ? -5 : 5), class: 'slide' }, g);
        }
        layout.noteEls.set(nt.id, { g, x: ex, y, bar: bi });

        // rhythm
        if (e.units < 16) {
          const len = e.units >= 8 ? 14 : 24;
          el('line', { x1: ex, x2: ex, y1: stemTop, y2: stemTop + len, class: 'stem' }, layers.notes);
        }
        if ([12, 6, 3].includes(e.units)) el('circle', { cx: ex + 5, cy: stemTop + 21, r: 1.8, class: 'dot' }, layers.notes);
        if (e.units < 4 || e.units === 3) {
          const beat = Math.floor(e.slot / song.grid);
          if (!beatGroups.has(beat)) beatGroups.set(beat, []);
          beatGroups.get(beat).push({ x: ex, units: e.units });
        }
      }
      for (const grp of beatGroups.values()) drawBeams(layers.notes, grp, beamY);
      x += w;
    });
  });

  // cursor
  layout.cursor = el('rect', { x: 0, y: 0, width: 2, height: staffH + 24, class: 'cursor', rx: 1 }, layers.cursor);
  layout.cursor.style.display = 'none';
  layout.staffH = staffH;
  return layout;
}

function drawBeams(g, grp, y) {
  const level = (u) => (u <= 1 ? 2 : 1); // 16th = 2 beams, 8th (2) / dotted 8th (3) = 1
  if (grp.length === 1) {
    const { x, units } = grp[0];
    for (let b = 0; b < level(units); b++) {
      el('path', { d: `M${x} ${y - b * 5} q 6 -3 7 -10`, class: 'flag' }, g);
    }
    return;
  }
  const x0 = grp[0].x, x1 = grp[grp.length - 1].x;
  el('line', { x1: x0, x2: x1, y1: y, y2: y, class: 'beam' }, g);
  for (let i = 0; i < grp.length; i++) {
    if (level(grp[i].units) < 2) continue;
    const prev = grp[i - 1], next = grp[i + 1];
    if (next && level(next.units) === 2) {
      el('line', { x1: grp[i].x, x2: next.x, y1: y - 5, y2: y - 5, class: 'beam' }, g);
    } else if (!(prev && level(prev.units) === 2)) {
      const dir = next ? 1 : -1;
      el('line', { x1: grp[i].x, x2: grp[i].x + dir * 7, y1: y - 5, y2: y - 5, class: 'beam' }, g);
    }
  }
}

function drawRest(g, x, y0, staffH, units) {
  const cy = y0 + staffH / 2;
  if (units >= 16) el('rect', { x: x - 5, y: cy - 4, width: 10, height: 4, class: 'rest' }, g);
  else if (units >= 8) el('rect', { x: x - 5, y: cy, width: 10, height: 4, class: 'rest' }, g);
  else if (units >= 4) {
    el('path', { d: `M${x - 2} ${cy - 10} l5 6 l-5 5 l5 6 q-6 -2 -4 4`, class: 'rest-q' }, g);
  } else {
    const n = units >= 2 ? 1 : 2;
    el('path', { d: `M${x + 4} ${cy - 8} l-5 ${12 + (n - 1) * 5}`, class: 'rest-q' }, g);
    for (let i = 0; i < n; i++) {
      el('circle', { cx: x - 2 + i * -1, cy: cy - 7 + i * 5, r: 2, class: 'rest' }, g);
      el('path', { d: `M${x - 2 + i * -1} ${cy - 6 + i * 5} q4 1 ${6 - i} -2`, class: 'rest-q' }, g);
    }
  }
}

/** Map playback time -> {x, y, bar} using quantized grid. */
export function cursorPos(layout, song, t) {
  const q = (t - song.offset) / song.slotDur;
  const bi = Math.floor(q / song.spb);
  const B = layout.bars[bi] ? layout.bars.find((b) => b.index === bi) : null;
  if (!B) return null;
  const within = q - bi * song.spb;
  return { x: B.x + G.padL + within * B.slotW, y: B.y, bar: bi, B };
}

/** Map an x/y click to a time. */
export function timeAt(layout, song, px, py) {
  const B = layout.bars.find((b) => px >= b.x && px < b.x + b.w && py >= b.y - G.top && py < b.y - G.top + layout.rowH);
  if (!B) return null;
  const slot = Math.max(0, Math.min(song.spb - 0.001, (px - B.x - G.padL) / B.slotW));
  return { t: song.offset + (B.index * song.spb + slot) * song.slotDur, bar: B.index };
}
