# Stem helper (Demucs) for Bass Tabs

A small program that runs on your Windows PC. It separates a full song into stems (drums, bass, other, vocals) with [Demucs](https://github.com/facebookresearch/demucs), and serves the Bass Tabs app so you can use it from the browser.

## Install (once)

1. Double-click **`install.bat`**. It does the following:
   - Finds Python 3.10–3.12. If none is found, it offers to install 3.12 with `winget`.
   - Creates a private environment in `helper\.venv`, so nothing is installed system-wide.
   - Installs PyTorch: the **CUDA** build if you have an NVIDIA GPU (about 2.5 GB download), otherwise the CPU build.
   - Installs Demucs.
2. The first separation also downloads the Demucs model (about 80 MB).

To uninstall, delete the `helper\.venv` folder.

## Use

1. Double-click **`start.bat`**. It opens **http://localhost:7860**, which is the Bass Tabs app served by the helper.
2. Open a full song. In the **🎚 Mixer**, press **✂** on the track and choose a model:
   - `htdemucs`: 4 stems, fast.
   - `htdemucs_ft`: 4 stems, better quality, about 4× slower.
   - `htdemucs_6s`: adds guitar and piano.
3. The stems are added as tracks and the original is muted. If the tab was made from the original, it's re-made from the bass stem.

Stems are kept in `helper\separated\<song> [<model>]\`. Separating the same file again reuses them instantly. A saved project remembers where its stems came from, so when you reopen it the app can fetch them back from the helper (**Get stems from the helper**).

Rough speed for a 4-minute song: about 20–40 s on a recent NVIDIA GPU; several minutes on a CPU.

## Using it from your phone (Tailscale)

The helper only listens on the PC itself (`127.0.0.1`), which is safer. Use Tailscale to reach it over HTTPS. In a terminal on the PC, run:

```
tailscale serve --bg 7860
```

Then open **https://&lt;your-pc-name&gt;.&lt;your-tailnet&gt;.ts.net/** on your phone. The full address is shown by `tailscale serve status`. If Tailscale asks, enable **HTTPS certificates** for your tailnet in the admin console (DNS page).

HTTPS matters because browsers only allow the app's audio engine on secure pages. Plain `http://<tailscale-ip>:7860` won't play audio on the phone.

You can also keep using the GitHub Pages site. Open ⚙ Settings → **Stem helper**, enter the `https://…ts.net` address and press Connect.

To stop sharing, run `tailscale serve --bg off` (or `tailscale serve reset`).

## Notes

- Options: `start.bat --port 8000` uses another port. `start.bat --host 0.0.0.0` makes the helper reachable from your whole local network over plain HTTP. Audio still needs HTTPS or localhost, so prefer Tailscale.
- Only one separation runs at a time; others wait in a queue.
- The app always uploads WAV, so FFmpeg isn't needed.
