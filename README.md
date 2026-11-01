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
  - Play/pause, speed 25–150% with pitch preserved, loop with free in/out points (drag across the tab, or tap In/Out while playing; snapped to the 16th grid), click to seek.
  - Auto-scrolling cursor and highlighting of the note that is playing.
  - Metronome, count-in, and a mix between the original audio and a synthesized tab track.
- **Multiple tracks (stems)**:
  - Open several files at once, or add and remove them later in the 🎚 Mixer. Each track has volume, mute and solo.
  - The tab is made from the track marked **TAB** (by default the one with "bass" in its name). You can switch it at any time.
  - All tracks play through one AudioWorklet engine that mixes and time-stretches them together (WSOLA). They stay sample-locked at any speed, and pitch doesn't change.
- **Projects**: **Save** writes a small `.basstab` file with:
  - The track list, mix and settings (tuning, tempo, downbeat, detection sliders).
  - The speed, loop, metronome and count-in state.
  - All note edits.

  Audio isn't embedded. Keep the project file in the same folder as the audio files. To reopen, choose the `.basstab` together with its audio files (multi-select), Tracks are matched by file name. If some are missing, you're asked to locate them: choose the files, or (Chrome/Edge on desktop) **Look in a folder**, which loads only the listed files.
- **Editing**: click a note to move it to another string or fret, change its pitch or octave, or delete it.
- **Export**: plain-text tab (.txt), downloaded or copied.

### Keyboard

| Key | Action |
| --- | --- |
| Space | Play / pause |
| L | Toggle loop |
| I / O | Set loop in / out point at the cursor |
| M | Metronome |
| `[` / `]` | Slower / faster |
| Home | Back to start (or loop start) |
| ↑ / ↓ | Move the selected note to another string |
| + / − | Change the selected note's pitch |
| ← / → | Previous / next note |
| J | Merge the selected note into the previous one |
| Del | Delete the selected note |
| ? | Show all shortcuts |

## Stem separation (optional PC helper)

`helper/` contains a small Windows helper that runs Demucs on your PC and serves the app. Run `install.bat` once, then `start.bat`. Each track in the Mixer gets a ✂ button that splits it into drums/bass/other/vocals. See [helper/README.md](helper/README.md), including how to use it from your phone with Tailscale.

## Settings file

`config.yaml` sets the defaults: tuning, frets, grid (8ths or 16ths), time signature, detection sliders, speed step and limits, drag-to-loop, metronome, count-in, synth volume, slide glide time, which track becomes the TAB track, and the auto-label keywords (`auto_labels`). Edit it and reload the page. Keys you remove fall back to the built-in defaults in `js/config.js`.

## Tips

- Isolated bass works best: DI tracks, or stems from a source-separation tool such as Demucs. Full mixes will be noisy.
- If notes are missing or doubled, open ⚙ Settings and adjust **Onset sensitivity**, **Pitch confidence** and the **Noise gate** (tap **?** next to each for an explanation). For a one-off false split, select the second half and use **Merge with previous** (J).
- If the bar lines are off, adjust the BPM (½× / 2×) or shift the downbeat by a beat.

## Files

- `js/analysis-worker.js`: pitch, RMS and onset features (FFT-based MPM).
- `js/transcribe.js`: note segmentation, tempo estimation, quantization, fret assignment, ASCII export.
- `js/tab-render.js`: SVG tab layout and cursor mapping.
- `js/synth.js`: tab synth, metronome, demo riff, WAV encoder.
- `js/main.js`: UI, transport, loop, editing.
