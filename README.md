# Bass Tabs

A browser app that turns a bass recording (WAV, or any format the browser can decode) into tab, with Songsterr-style playback controls.

## Run it

It's a static site with no build step. Serve the folder over HTTP (ES modules don't load from `file://`):

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000. Click **Demo** to try it without a file. It also works on GitHub Pages.

## Features

- **Transcription**: runs entirely in the browser using a Web Worker.
  - Pitch: McLeod pitch method (MPM) with a sub-octave/harmonic check, tuned for bass (28–520 Hz).
  - Onsets: spectral flux. Repeated notes on the same pitch are split; pitch changes with no new attack become slides or legato.
  - Tuning offset: detected automatically (for recordings not tuned to A440).
  - Tempo and first downbeat: estimated automatically. Notes are quantized to 16th or 8th notes.
  - Fingering: string and fret chosen by a Viterbi search that minimizes hand movement.
  - Tuning: picked automatically (standard, drop D, Eb, 5-string) from the lowest note.
- **Tab view**: bars, string names, fret numbers, rhythm stems, beams and rests.
- **Playback**:
  - Play/pause, speed 25–150% with pitch preserved, loop by dragging across bars, click to seek.
  - Auto-scrolling cursor and highlighting of the note that is playing.
  - Metronome, count-in, and a mix between the original audio and a synthesized tab track.
- **Editing**: click a note to move it to another string or fret, change its pitch or octave, or delete it.
- **Export**: plain-text tab (.txt), downloaded or copied.

### Keyboard

| Key | Action |
| --- | --- |
| Space | Play / pause |
| L | Toggle loop |
| M | Metronome |
| `[` / `]` | Slower / faster |
| Home | Back to start (or loop start) |
| ↑ / ↓ | Move the selected note to another string |
| + / − | Change the selected note's pitch |
| ← / → | Previous / next note |
| Del | Delete the selected note |

## Tips

- Isolated bass works best: DI tracks, or stems from a source-separation tool such as Demucs. Full mixes will be noisy.
- If notes are missing or doubled, open ⚙ Settings and adjust **Onset sensitivity**, **Pitch confidence** and the **Noise gate**.
- If the bar lines are off, adjust the BPM (½× / 2×) or shift the downbeat by a beat.

## Files

- `js/analysis-worker.js`: pitch, RMS and onset features (FFT-based MPM).
- `js/transcribe.js`: note segmentation, tempo estimation, quantization, fret assignment, ASCII export.
- `js/tab-render.js`: SVG tab layout and cursor mapping.
- `js/synth.js`: tab synth, metronome, demo riff, WAV encoder.
- `js/main.js`: UI, transport, loop, editing.
