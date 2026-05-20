/**
 * Slim recording-viewer page.
 *
 * Wire endpoints (served by ./server/server.py):
 *   GET  /api/recordings           -> {recordings: [{name, size, mtime}]}
 *   POST /api/load   { name }      -> {frames: [{timestamp_ms, direction, decoded}]}
 *   POST /api/upload  multipart    -> {name}
 *
 * Each frame's `decoded` is a small JSON projection of the corresponding
 * ClientMessage or ServerMessage. The server does the proto -> JSON
 * conversion so this page stays proto-free.
 */

interface RecordingListEntry {
  name: string;
  size: number;
  mtime: number;
}

interface FrameJson {
  timestamp_ms: number;
  // 'CLIENT_TO_SERVER' | 'SERVER_TO_CLIENT'
  direction: string;
  // Free-form JSON projection of the underlying ClientMessage / ServerMessage.
  decoded: unknown;
}

export interface RecordingViewerHandle {
  refreshList: () => Promise<void>;
}

export function initRecordingViewer(): RecordingViewerHandle {
  const listEl = document.getElementById('rv-list') as HTMLElement;
  const rootEl = document.getElementById('rv-root') as HTMLElement;
  const inputPathEl = document.getElementById('rv-input-path') as HTMLElement;
  const statusEl = document.getElementById('rv-status') as HTMLElement;
  const refreshBtn = document.getElementById(
    'rv-refresh-list',
  ) as HTMLButtonElement;
  const uploadBtn = document.getElementById('rv-upload-btn') as HTMLButtonElement;
  const uploadInput = document.getElementById(
    'rv-upload-input',
  ) as HTMLInputElement;

  let activeName: string | null = null;

  function setStatus(msg: string, isError = false) {
    statusEl.textContent = msg;
    statusEl.className = isError ? 'status-badge error' : 'status-badge';
  }

  async function refreshList(): Promise<void> {
    try {
      const resp = await fetch('/api/recordings', {cache: 'no-store'});
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      }
      const data = (await resp.json()) as {recordings: RecordingListEntry[]};
      renderList(data.recordings ?? []);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      listEl.replaceChildren();
      const empty = document.createElement('div');
      empty.className = 'rv-list-empty';
      empty.textContent = `Failed to load: ${message}`;
      listEl.appendChild(empty);
    }
  }

  function renderList(entries: RecordingListEntry[]) {
    listEl.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'rv-list-empty';
      empty.textContent = 'No recordings yet.';
      listEl.appendChild(empty);
      return;
    }
    for (const r of entries) {
      const item = document.createElement('div');
      item.className = 'rv-list-item';
      if (r.name === activeName) item.classList.add('is-active');
      const name = document.createElement('div');
      name.className = 'rv-list-item-name';
      name.textContent = r.name;
      const meta = document.createElement('div');
      meta.className = 'rv-list-item-meta';
      meta.textContent =
        `${(r.size / 1024).toFixed(1)} KiB \u00b7 ` +
        new Date(r.mtime * 1000).toLocaleString();
      item.appendChild(name);
      item.appendChild(meta);
      item.addEventListener('click', () => {
        void loadRecording(r.name);
      });
      listEl.appendChild(item);
    }
  }

  async function loadRecording(name: string) {
    setStatus(`Loading ${name}…`);
    try {
      const resp = await fetch('/api/load', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name}),
      });
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      }
      const data = (await resp.json()) as {frames: FrameJson[]};
      activeName = name;
      inputPathEl.textContent = name;
      renderFrames(data.frames ?? []);
      setStatus(`Loaded ${data.frames.length} frames.`);
      // Re-render the list so the active highlight moves.
      await refreshList();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus(`Load failed: ${message}`, true);
    }
  }

  function renderFrames(frames: FrameJson[]) {
    rootEl.replaceChildren();
    if (frames.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.innerHTML =
        '<div class="empty-icon">[empty]</div>' +
        '<div class="empty-title">Recording has no frames</div>';
      rootEl.appendChild(empty);
      return;
    }
    const startMs = frames[0].timestamp_ms;
    for (const f of frames) {
      const frameEl = document.createElement('div');
      frameEl.className = 'rv-frame';
      const meta = document.createElement('div');
      meta.className = 'rv-frame-meta';
      const dirClass =
        f.direction === 'CLIENT_TO_SERVER'
          ? 'rv-frame-dir-c2s'
          : 'rv-frame-dir-s2c';
      const dirSpan = document.createElement('span');
      dirSpan.className = dirClass;
      dirSpan.textContent = f.direction === 'CLIENT_TO_SERVER' ? '>>>' : '<<<';
      const tsSpan = document.createElement('span');
      const deltaMs = f.timestamp_ms - startMs;
      tsSpan.textContent = `t+${(deltaMs / 1000).toFixed(3)}s`;
      meta.appendChild(dirSpan);
      meta.appendChild(tsSpan);
      const body = document.createElement('pre');
      body.className = 'rv-frame-body';
      try {
        body.textContent = JSON.stringify(f.decoded, null, 2);
      } catch {
        body.textContent = String(f.decoded);
      }
      frameEl.appendChild(meta);
      frameEl.appendChild(body);
      rootEl.appendChild(frameEl);
    }
  }

  refreshBtn.addEventListener('click', () => {
    void refreshList();
  });
  uploadBtn.addEventListener('click', () => uploadInput.click());
  uploadInput.addEventListener('change', async () => {
    const file = uploadInput.files?.[0];
    if (!file) return;
    setStatus(`Uploading ${file.name}…`);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const resp = await fetch('/api/upload', {method: 'POST', body: fd});
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      }
      const data = (await resp.json()) as {name: string};
      await refreshList();
      await loadRecording(data.name);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      setStatus(`Upload failed: ${message}`, true);
    } finally {
      uploadInput.value = '';
    }
  });

  return {refreshList};
}
