// Standard MIDI File (type 0) export of the tab.

const PPQ = 480;

function vlq(n) {
  const bytes = [n & 0x7f];
  while ((n >>= 7)) bytes.unshift((n & 0x7f) | 0x80);
  return bytes;
}
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >> 8) & 255, n & 255];
const text = (s) => [...new TextEncoder().encode(s)];

/**
 * song: result of arrange() (quantized notes with qs, qStart/qEnd, pm = transposed pitch).
 * opts: { title, program (GM 0-based program number, e.g. 33 = fingered bass) }
 */
export function toMidi(song, { title = 'Bass', program = 33 } = {}) {
  const ticksPerSlot = PPQ / song.grid;
  const events = []; // [tick, order, bytes]
  const usPerQuarter = Math.round(60_000_000 / song.bpm);
  events.push([0, 0, [0xff, 0x03, ...vlq(text(title).length), ...text(title)]]);                 // track name
  events.push([0, 0, [0xff, 0x51, 0x03, (usPerQuarter >> 16) & 255, (usPerQuarter >> 8) & 255, usPerQuarter & 255]]); // tempo
  events.push([0, 0, [0xff, 0x58, 0x04, song.beatsPerBar, 2, 24, 8]]);                            // time signature x/4
  events.push([0, 0, [0xc0, program & 127]]);                                                     // program change
  const notes = song.notes.filter((n) => !n.hidden).sort((a, b) => a.qs - b.qs);
  for (const n of notes) {
    const on = Math.round(n.qs * ticksPerSlot);
    const len = Math.max(1, Math.round(((n.qEnd - n.qStart) / song.slotDur) * ticksPerSlot) - 1);
    const pitch = Math.max(0, Math.min(127, n.pm));
    const vel = Math.max(30, Math.min(127, Math.round(45 + 80 * (n.vel ?? 0.7))));
    events.push([on, 2, [0x90, pitch, vel]]);
    events.push([on + len, 1, [0x80, pitch, 0]]); // note-offs before note-ons at the same tick
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const body = [];
  let last = 0;
  for (const [tick, , bytes] of events) { body.push(...vlq(tick - last), ...bytes); last = tick; }
  body.push(0, 0xff, 0x2f, 0x00); // end of track
  const bytes = [
    ...text('MThd'), ...u32(6), ...u16(0), ...u16(1), ...u16(PPQ),
    ...text('MTrk'), ...u32(body.length), ...body,
  ];
  return new Blob([new Uint8Array(bytes)], { type: 'audio/midi' });
}
