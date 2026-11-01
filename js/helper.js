// Client for the optional PC helper (helper/server.py) that runs Demucs.

const LS_KEY = 'bassTabs.helperUrl';

export const helper = { url: null, info: null };

const clean = (u) => (u || '').trim().replace(/\/+$/, '');

async function probe(url) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(url + '/api/status', { signal: ctl.signal, cache: 'no-store' });
    clearTimeout(t);
    if (!r.ok) return null;
    const j = await r.json();
    return j.app === 'bass-tabs-helper' ? j : null;
  } catch { return null; }
}

/** Find a running helper: saved URL, config URL, or the server this page came from. */
export async function connectHelper(configUrl) {
  let saved = '';
  try { saved = localStorage.getItem(LS_KEY) || ''; } catch {}
  const candidates = [clean(saved), clean(configUrl), location.protocol.startsWith('http') ? location.origin : '']
    .filter((u, i, a) => u && a.indexOf(u) === i);
  for (const url of candidates) {
    const info = await probe(url);
    if (info) { helper.url = url; helper.info = info; return helper; }
  }
  helper.url = null; helper.info = null;
  return helper;
}

export async function setHelperUrl(url) {
  url = clean(url);
  try { url ? localStorage.setItem(LS_KEY, url) : localStorage.removeItem(LS_KEY); } catch {}
  if (!url) return connectHelper('');
  const info = await probe(url);
  helper.url = info ? url : null; helper.info = info;
  return helper;
}

function upload(url, blob, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    x.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    x.onload = () => {
      try {
        const j = JSON.parse(x.responseText);
        x.status < 300 ? resolve(j) : reject(new Error(j.error || x.statusText));
      } catch (e) { reject(e); }
    };
    x.onerror = () => reject(new Error('Upload to the helper failed'));
    x.send(blob);
  });
}

/**
 * Separate `wavBlob` into stems. onStatus({ phase, progress, message }).
 * Resolves to [{ name (stem file), remote (folder/stem path), file: File }].
 */
export async function separate(wavBlob, name, model, onStatus, signal) {
  if (!helper.url) throw new Error('Helper not connected');
  onStatus({ phase: 'upload', progress: 0, message: 'Uploading…' });
  const { job } = await upload(`${helper.url}/api/separate?model=${encodeURIComponent(model)}&name=${encodeURIComponent(name)}`,
    wavBlob, (p) => onStatus({ phase: 'upload', progress: p, message: 'Uploading…' }));
  let st;
  for (;;) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    st = await (await fetch(`${helper.url}/api/job/${job}`, { cache: 'no-store' })).json();
    onStatus({ phase: 'separate', progress: st.progress, message: st.message });
    if (st.state === 'done') break;
    if (st.state === 'error') throw new Error(st.message);
    await new Promise((r) => setTimeout(r, 700));
  }
  const out = [];
  for (let i = 0; i < st.stems.length; i++) {
    const stem = st.stems[i];
    onStatus({ phase: 'download', progress: i / st.stems.length, message: `Downloading ${stem}…` });
    out.push(await fetchStem(`${st.folder}/${stem}`));
  }
  return out;
}

/** Download one stem stored on the helper ("folder/stem.wav"). */
export async function fetchStem(remote) {
  const r = await fetch(`${helper.url}/api/stems/${remote.split('/').map(encodeURIComponent).join('/')}`);
  if (!r.ok) throw new Error(`Helper doesn't have ${remote}`);
  const stem = remote.split('/').pop();
  return { name: stem, remote, file: new File([await r.blob()], stem, { type: 'audio/wav' }) };
}
