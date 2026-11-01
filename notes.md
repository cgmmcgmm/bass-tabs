# Notes

## Isolating the bass with Demucs

**Status:** implemented as option 1 below, a local helper (`helper/`). The notes below are kept for reference.

Transcription works best on a solo or DI bass track. On a full mix, the drums, guitars and vocals cause wrong pitches and false note starts. [Demucs](https://github.com/facebookresearch/demucs) (Meta, MIT licence) is a source-separation model that can pull the bass out of a full song. This would let users upload a normal song file.

Quick test (Python):

```bash
pip install demucs
demucs --two-stems=bass song.mp3   # -> separated/htdemucs/song/bass.wav
```

Then upload `bass.wav` into the app.

### Ways to integrate it

1. **Small local or hosted backend (simplest).** A Python service (e.g. FastAPI) runs `htdemucs` with `--two-stems=bass` and returns `bass.wav`. The app then transcribes it as usual. A GPU makes it fast; on a CPU it takes about 1× to 3× the song's length.
2. **In the browser.** Export the model to ONNX and run it with onnxruntime-web (WebGPU/WASM). There's no server and everything stays private. The catch is a large download (~80 MB+), it can be slow on weaker machines, and the export is fiddly.
3. **Hosted inference.** Use a Hugging Face Space or a Replicate model running Demucs. This is the fastest to wire up, but the audio leaves the user's machine, and it may cost money or have rate limits.

### UI sketch

- On upload, ask whether it's a full mix ("Isolate bass first").
- Let the user switch the playback audio between the full mix and the isolated bass. Transcription always uses the isolated bass.

## Other ideas

- **Live input:** play along through an audio interface or mic. The input is monitored and mixed with the tracks, and there's a latency setting.
- **Record the live input** while the song plays, in sync with the tab and loop.
- **Use a recording:** add the take as a track, or upload a new recording, then compare it against the tab (or transcribe it).
- **Synth sounds:** 3–5 presets for the tab synth (e.g. finger, pick, slap/bright, sub/synth bass, muted).

- MIDI and Guitar Pro (.gp) export.
- Detecting hammer-ons and pull-offs versus slides, and ghost or dead notes (X).
- Tempo changes within a song (a beat-tracking curve instead of one fixed BPM).
- Section markers (intro, verse, chorus) and repeat signs.
