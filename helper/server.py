"""Bass Tabs stem helper.

Serves the Bass Tabs web app and runs Demucs (stem separation) on request.

    python server.py [--port 7860] [--host 127.0.0.1]

API (used by the app):
    GET  /api/status                      -> {"ok": true, "device": "cuda"|"cpu", "models": {...}}
    POST /api/separate?model=..&name=..   body = WAV bytes  -> {"job": id}
    GET  /api/job/<id>                    -> {"state", "progress", "message", "folder", "stems"}
    GET  /api/stems/<folder>/<stem>.wav   -> the separated stem
"""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

VERSION = 1
HERE = Path(__file__).resolve().parent
APP_DIR = HERE.parent                 # the web app lives one level up
OUT_DIR = HERE / "separated"          # stems are kept here (and reused)
MODELS = {
    "htdemucs": {"label": "4 stems: drums, bass, other, vocals", "bag": 1},
    "htdemucs_ft": {"label": "4 stems, fine-tuned: better quality, ~4x slower", "bag": 4},
    "htdemucs_6s": {"label": "6 stems: adds guitar and piano", "bag": 1},
}

jobs = {}
jobs_lock = threading.Lock()
gpu_lock = threading.Semaphore(1)     # one separation at a time
_device = None


def device():
    global _device
    if _device is None:
        try:
            import torch
            _device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            _device = "cpu"
    return _device


def safe_name(name):
    stem = Path(name).stem
    stem = re.sub(r"[^\w\- .()]", "_", stem).strip(" .") or "song"
    return stem[:80]


def run_job(job_id, src, model, folder):
    job = jobs[job_id]
    tmp = Path(tempfile.mkdtemp(prefix="demucs_", dir=OUT_DIR))
    try:
        with gpu_lock:
            job.update(state="running", message="Starting Demucs…")
            cmd = [sys.executable, "-m", "demucs", "-n", model, "-d", device(),
                   "-o", str(tmp), "--filename", "{stem}.{ext}", str(src)]
            proc = subprocess.Popen(cmd, stderr=subprocess.PIPE, stdout=subprocess.PIPE, cwd=str(HERE))
            bag = MODELS[model]["bag"]
            bar, last_pct, tail, buf = 0, 0, [], b""
            while True:
                chunk = proc.stderr.read(256)
                if not chunk:
                    break
                buf += chunk
                text = buf.decode("utf-8", "replace")
                parts = re.split(r"[\r\n]", text)
                buf = parts[-1].encode()
                for line in parts[:-1]:
                    if not line.strip():
                        continue
                    tail = (tail + [line])[-30:]
                    m = re.findall(r"(\d+)%\|", line)
                    if m:
                        pct = int(m[-1])
                        if pct < last_pct:  # a new progress bar started (bag of models)
                            bar += 1
                        last_pct = pct
                        job["progress"] = min(0.99, (bar * 100 + pct) / (100 * bag))
                        job["message"] = "Separating…"
                    elif "Downloading" in line or "download" in line.lower():
                        job["message"] = "Downloading the model (first run only)…"
            proc.wait()
            if proc.returncode != 0:
                raise RuntimeError("Demucs failed:\n" + "\n".join(tail[-12:]))
        produced = tmp / model
        dest = OUT_DIR / folder
        if dest.exists():
            shutil.rmtree(dest)
        dest.mkdir(parents=True)
        stems = []
        for f in sorted(produced.glob("*.wav")):
            shutil.move(str(f), dest / f.name)
            stems.append(f.name)
        (dest / "meta.json").write_text(json.dumps({"hash": job["hash"], "model": model, "name": job["name"], "stems": stems}))
        job.update(state="done", progress=1.0, message="Done", stems=stems)
    except Exception as e:  # noqa: BLE001
        job.update(state="error", message=str(e))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        try:
            Path(src).unlink()
        except OSError:
            pass


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".html": "text/html",
        ".json": "application/json", ".yaml": "text/yaml", ".wav": "audio/wav", ".svg": "image/svg+xml",
    }

    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(APP_DIR), **kw)

    def log_message(self, fmt, *args):
        if "/api/job/" not in (self.path or ""):
            sys.stderr.write("%s  %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_json(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_OPTIONS(self):
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        url = urlparse(self.path)
        path = unquote(url.path)
        if path == "/api/status":
            busy = any(j["state"] in ("queued", "running") for j in jobs.values())
            return self.send_json({"ok": True, "app": "bass-tabs-helper", "version": VERSION, "device": device(),
                                   "models": {k: v["label"] for k, v in MODELS.items()}, "busy": busy})
        if path.startswith("/api/job/"):
            job = jobs.get(path.rsplit("/", 1)[-1])
            if not job:
                return self.send_json({"error": "unknown job"}, 404)
            return self.send_json({k: job[k] for k in ("state", "progress", "message", "folder", "stems")})
        if path.startswith("/api/stems/"):
            rel = path[len("/api/stems/"):]
            f = (OUT_DIR / rel).resolve()
            if OUT_DIR.resolve() not in f.parents or not f.is_file() or f.suffix != ".wav":
                return self.send_json({"error": "not found"}, 404)
            data = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path.startswith("/helper/") or "/." in path:
            return self.send_json({"error": "not found"}, 404)  # don't expose the venv / stems via static files
        return super().do_GET()

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/api/separate":
            return self.send_json({"error": "not found"}, 404)
        q = parse_qs(url.query)
        model = q.get("model", ["htdemucs"])[0]
        name = q.get("name", ["song.wav"])[0]
        if model not in MODELS:
            return self.send_json({"error": f"unknown model {model}"}, 400)
        length = int(self.headers.get("Content-Length", 0))
        if length <= 44:
            return self.send_json({"error": "empty upload"}, 400)
        OUT_DIR.mkdir(exist_ok=True)
        src = OUT_DIR / f"upload_{uuid.uuid4().hex}.wav"
        h = hashlib.sha1()
        with open(src, "wb") as fh:
            left = length
            while left > 0:
                chunk = self.rfile.read(min(1 << 20, left))
                if not chunk:
                    break
                h.update(chunk)
                fh.write(chunk)
                left -= len(chunk)
        digest = h.hexdigest()
        folder = f"{safe_name(name)} [{model}]"
        job_id = uuid.uuid4().hex[:12]
        job = {"state": "queued", "progress": 0.0, "message": "Queued…", "folder": folder, "stems": [],
               "hash": digest, "name": name}
        meta = OUT_DIR / folder / "meta.json"
        if meta.exists():
            try:
                m = json.loads(meta.read_text())
                if m.get("hash") == digest and all((OUT_DIR / folder / s).exists() for s in m["stems"]):
                    job.update(state="done", progress=1.0, message="Already separated (cached)", stems=m["stems"])
                    src.unlink()
            except (OSError, ValueError, KeyError):
                pass
        with jobs_lock:
            jobs[job_id] = job
        if job["state"] != "done":
            threading.Thread(target=run_job, args=(job_id, src, model, folder), daemon=True).start()
        return self.send_json({"job": job_id})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=7860)
    ap.add_argument("--host", default="127.0.0.1",
                    help="127.0.0.1 = this PC only (use `tailscale serve` for remote access); 0.0.0.0 = whole network")
    args = ap.parse_args()
    OUT_DIR.mkdir(exist_ok=True)
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Bass Tabs helper running on http://localhost:{args.port}  (device: {device()})")
    print(f"Stems are saved in {OUT_DIR}")
    print("Press Ctrl+C to stop.")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
