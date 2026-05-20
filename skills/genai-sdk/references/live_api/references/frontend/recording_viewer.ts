/**
 * @fileoverview Frontend controller for the recording viewer page.
 *
 * Adapted from the recording_viewer_frontend reference (script.js). Renders
 * per-agent timelines for a recording produced by the
 * ``proto_message_recorder`` and served via ``recording_viewer.py``:
 *
 *   GET  /api/recordings           - list of recent recordio files on disk
 *   GET  /api/agents               - per-agent timelines for the loaded file
 *   GET  /api/audio/<idx>.wav      - mixed stereo WAV per agent
 *   POST /api/load   { path }      - loads a recording at the given server path
 *   POST /api/upload  multipart    - uploads a .recordio and loads it
 *   GET  /api/download?name=...    - raw recordio bytes for a recent entry
 */

import {objectUrlFromSafeSource} from 'safevalues';
import {setAnchorHref} from 'safevalues/dom';

// ------------------------------------------------------------------
// Types matching the JSON shape served by recording_viewer.py.
// ------------------------------------------------------------------
interface RvRecordingEntry {
  name: string;
  path: string;
  size: number;
  mtime: number;
}

interface RvMessage {
  direction: 'client' | 'server';
  kind: string;
  modality: string;
  interrupted: boolean;
  // tslint:disable:enforce-name-casing wire fields use snake_case.
  start_ms: number;
  end_ms: number;
  duration_ms: number;
  wire_ms: number;
  text_preview: string;
  audio_bytes: number;
  audio_rate_hz: number;
  mime_types: string[];
  frame_indices?: number[];
  // tslint:enable:enforce-name-casing
  // tslint:disable-next-line:no-any structurally-typed proto-to-JSON dump.
  detail: any;
}

interface RvFrame {
  frame_ms: number; // tslint:disable-line:enforce-name-casing
  mime_type: string; // tslint:disable-line:enforce-name-casing
}

interface RvAgent {
  index: number;
  agent_name: string; // tslint:disable-line:enforce-name-casing
  total_ms: number; // tslint:disable-line:enforce-name-casing
  messages: RvMessage[];
  frames?: RvFrame[];
}

interface RvAgentsPayload {
  input_path: string; // tslint:disable-line:enforce-name-casing
  agents: RvAgent[];
}

type RvMode = 'playback' | 'message';

const LABEL_W = 90;
const RIGHT_PAD = 60;
const ZOOM_STEP = Math.SQRT2;
const ZOOM_MIN = 0.125;
const ZOOM_MAX = 64;
const MESSAGE_BAR_W = 4;
const ROW_H = 48;
// Default viewport window at zoom=1. Rendering an entire long recording at
// "fit to width" produces thousands of overlapping bars and makes the
// fisheye interaction stutter; instead the default scale shows this many
// milliseconds across the viewport width and the user can scroll/zoom.
const DEFAULT_WINDOW_MS = 20_000;

// ---------- Fisheye magnification ----------
const FISHEYE_RADIUS_PX = 140;
const FISHEYE_K = 2.4;
const FISHEYE_GAP_PX = 1;
const FISHEYE_MAX_SCALE = 2.0;
const FISHEYE_SIGMA_PX = 70;

/**
 * Initializes the recording viewer page. Idempotent; safe to call before
 * the page is shown.
 */
export function initRecordingViewer(): {refreshList: () => Promise<void>} {
  const byId = (id: string) =>
    document.getElementById(id) as HTMLElement | null;

  const root = byId('rv-root') as HTMLElement;
  const inputPathLabel = byId('rv-input-path') as HTMLElement;
  const statusEl = byId('rv-status') as HTMLElement;
  const listEl = byId('rv-list') as HTMLElement;
  const refreshBtn = byId('rv-refresh-list') as HTMLButtonElement;
  const uploadInput = byId('rv-upload-input') as HTMLInputElement;
  const uploadBtn = byId('rv-upload-btn') as HTMLButtonElement;
  const tooltip = byId('rv-tooltip') as HTMLElement;
  const globalModeToggle = byId('rv-global-mode-toggle') as HTMLElement;

  let globalMode: RvMode = 'playback';
  const agentZoom = new Map<number, number>();
  const agentModeOverride = new Map<number, RvMode>();
  let lastAgentsData: RvAgentsPayload | null = null;
  let tooltipPinned = false;
  // Bumped on every successful recording load. Appended to audio/frame
  // URLs as ``?v=N`` so the browser cannot serve assets from a previous
  // recording out of its own cache.
  let loadVersion = 0;

  // ---------- Audio playback ----------
  let audioCtx: AudioContext | null = null;
  let activeChunkSource: AudioBufferSourceNode | null = null;
  // Per-agent, per-direction mono AudioBuffers. The server returns a stereo
  // mix (left=client, right=server) so playing the buffer as-is would bleed
  // the other channel. Split into mono channels here so per-chunk playback
  // only emits the relevant direction.
  interface AgentChannels {
    client: AudioBuffer;
    server: AudioBuffer;
  }
  const decodedChannels = new Map<number, AgentChannels>();
  const decodingPromises = new Map<number, Promise<AgentChannels>>();

  function getAudioCtx(): AudioContext {
    if (!audioCtx) {
      // tslint:disable:enforce-name-casing names mirror DOM globals.
      const audioContextCtor =
        (window as unknown as {AudioContext: typeof AudioContext})
          .AudioContext ||
        (window as unknown as {webkitAudioContext: typeof AudioContext})
          .webkitAudioContext;
      // tslint:enable:enforce-name-casing
      audioCtx = new audioContextCtor();
    }
    return audioCtx;
  }

  function splitStereo(ctx: AudioContext, stereo: AudioBuffer): AgentChannels {
    const sr = stereo.sampleRate;
    const len = stereo.length;
    const mono = (channelIdx: number) => {
      const buf = ctx.createBuffer(1, len, sr);
      // If the source isn't stereo (shouldn't happen), fall back to ch 0.
      const srcCh = channelIdx < stereo.numberOfChannels ? channelIdx : 0;
      buf.copyToChannel(stereo.getChannelData(srcCh), 0);
      return buf;
    };
    return {client: mono(0), server: mono(1)};
  }

  async function getAgentChannels(agent: RvAgent): Promise<AgentChannels> {
    const cached = decodedChannels.get(agent.index);
    if (cached) return cached;
    const inflight = decodingPromises.get(agent.index);
    if (inflight) return inflight;
    const p = (async () => {
      // Use the uncut mix so per-chunk playback can preview audio that
      // would have been silenced by an interrupt in the full timeline.
      const resp = await fetch(
        `/api/audio/${agent.index}.wav?raw=1&v=${loadVersion}`,
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const arr = await resp.arrayBuffer();
      const ctx = getAudioCtx();
      const stereo = await ctx.decodeAudioData(arr);
      const channels = splitStereo(ctx, stereo);
      decodedChannels.set(agent.index, channels);
      decodingPromises.delete(agent.index);
      return channels;
    })();
    decodingPromises.set(agent.index, p);
    return p;
  }

  async function playMessage(agent: RvAgent, m: RvMessage) {
    try {
      const ctx = getAudioCtx();
      if (ctx.state === 'suspended') await ctx.resume();
      const channels = await getAgentChannels(agent);
      const buffer =
        m.direction === 'server' ? channels.server : channels.client;
      if (activeChunkSource) {
        try {
          activeChunkSource.stop();
        } catch {
          // ignored
        }
        activeChunkSource = null;
      }
      const startSec = Math.max(0, m.start_ms / 1000);
      const endSec = m.end_ms > m.start_ms ? m.end_ms / 1000 : startSec + 1;
      const durationSec = Math.max(0, endSec - startSec);
      if (durationSec <= 0) return;
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);
      src.onended = () => {
        if (activeChunkSource === src) activeChunkSource = null;
      };
      activeChunkSource = src;
      src.start(0, startSec, durationSec);
    } catch (e) {
      console.error('rv playMessage failed', e);
    }
  }

  // ---------- Replay popup (audio + frames) ----------
  // Tracks resources for the currently-open replay popup so closing the
  // window (or clicking the close button) releases everything immediately.
  interface ReplaySession {
    overlay: HTMLElement;
    audio: HTMLAudioElement;
    img: HTMLImageElement;
    rafId: number | null;
    frameUrls: string[]; // object URLs to revoke on close
  }
  let activeReplay: ReplaySession | null = null;

  function stopActiveChunk() {
    if (activeChunkSource) {
      try {
        activeChunkSource.stop();
      } catch {
        // ignored
      }
      try {
        activeChunkSource.disconnect();
      } catch {
        // ignored
      }
      activeChunkSource = null;
    }
  }

  function closeReplay() {
    const r = activeReplay;
    if (!r) return;
    activeReplay = null;
    // Also kill any per-chunk Web Audio source so the popup doesn't
    // leave a second sound source playing in the background.
    stopActiveChunk();
    if (r.rafId != null) {
      cancelAnimationFrame(r.rafId);
      r.rafId = null;
    }
    // Belt-and-suspenders teardown of the <audio> element. Just calling
    // pause() leaves a race: if the audio was mid-buffer/seek, the
    // browser may decide to start playing again once the buffer is
    // ready. We:
    //   1) mute so any micro-window of playback is silent,
    //   2) pause,
    //   3) clear src and call load() to abort the resource fetch
    //      (per HTML spec, setting src then calling load() aborts any
    //      ongoing playback and tears down the media element),
    //   4) remove from the DOM (also kills any pending Range request).
    try {
      r.audio.muted = true;
      r.audio.pause();
      r.audio.currentTime = 0;
      r.audio.removeAttribute('src');
      r.audio.load();
      if (r.audio.parentNode) {
        r.audio.parentNode.removeChild(r.audio);
      }
    } catch {
      // ignored
    }
    for (const u of r.frameUrls) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        // ignored
      }
    }
    if (r.overlay.parentNode) r.overlay.parentNode.removeChild(r.overlay);
  }

  // Info toast shown when the user clicks "Download MP4". Stays up for
  // a few seconds (or until the user clicks/keys) to reassure the user
  // that the long ffmpeg render is running in the background and that
  // the download will start automatically when it's ready.
  let activeDownloadInfoToast: {
    el: HTMLElement;
    dismiss: () => void;
  } | null = null;

  function showDownloadInfoToast() {
    // If one is already up, refresh it.
    if (activeDownloadInfoToast) activeDownloadInfoToast.dismiss();

    const toast = document.createElement('div');
    toast.className = 'rv-download-info-toast';
    const card = document.createElement('div');
    card.className = 'rv-download-info-card';
    const icon = document.createElement('div');
    icon.className = 'rv-download-info-icon';
    icon.textContent = '\u23F3';
    const title = document.createElement('div');
    title.className = 'rv-download-info-title';
    title.textContent = 'Preparing your download';
    const body = document.createElement('div');
    body.className = 'rv-download-info-body';
    body.textContent =
      'Rendering the MP4 in the background. The download will start ' +
      'automatically when it\u2019s ready. Feel free to keep using the ' +
      'app in the meantime.';
    const hint = document.createElement('div');
    hint.className = 'rv-download-info-hint';
    hint.textContent = 'Click anywhere or press any key to dismiss.';
    card.appendChild(icon);
    card.appendChild(title);
    card.appendChild(body);
    card.appendChild(hint);
    toast.appendChild(card);
    document.body.appendChild(toast);
    requestAnimationFrame(() => {
      toast.classList.add('is-visible');
    });

    let dismissed = false;
    let autoTimer: number | null = null;
    const onInput = () => {
      dismiss();
    };
    const dismiss = () => {
      if (dismissed) return;
      dismissed = true;
      if (autoTimer != null) clearTimeout(autoTimer);
      document.removeEventListener('mousedown', onInput, true);
      document.removeEventListener('keydown', onInput, true);
      document.removeEventListener('touchstart', onInput, true);
      toast.classList.remove('is-visible');
      setTimeout(() => {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 200);
      if (activeDownloadInfoToast && activeDownloadInfoToast.el === toast) {
        activeDownloadInfoToast = null;
      }
    };
    activeDownloadInfoToast = {el: toast, dismiss};
    // Auto-dismiss after ~3 seconds; listeners registered on the next
    // frame so the click that opened the toast isn't what closes it.
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', onInput, true);
      document.addEventListener('keydown', onInput, true);
      document.addEventListener('touchstart', onInput, true);
    });
    autoTimer = window.setTimeout(dismiss, 3000);
  }

  // Per-agent in-flight MP4 download state. Survives popup close/reopen
  // so users can dismiss the popup, do something else, and reopen later
  // to find the still-rendering download. The first popup to observe
  // completion triggers the actual save-file dialog; if no popup is
  // open at that moment the download is triggered globally.
  interface PendingMp4Download {
    promise: Promise<void>;
    // Buttons that should reflect "Rendering…" disabled state while the
    // download is in flight. Adds/removes as popups open/close.
    listeners: Set<HTMLButtonElement>;
    // Label to restore when the download completes / fails.
    originalText: string;
  }
  const pendingMp4: Map<number, PendingMp4Download> = new Map();

  function applyMp4PendingStateToButton(
    btn: HTMLButtonElement,
    pending: PendingMp4Download,
  ) {
    btn.disabled = true;
    btn.textContent = 'Rendering\u2026';
    pending.listeners.add(btn);
  }

  function downloadReplayMp4(agent: RvAgent, btn: HTMLButtonElement) {
    showDownloadInfoToast();

    // If a previous download is already in flight for this agent, simply
    // attach this button to its state -- do NOT kick off a second fetch.
    const existing = pendingMp4.get(agent.index);
    if (existing) {
      applyMp4PendingStateToButton(btn, existing);
      return;
    }

    const originalText = btn.textContent || '\u2B07 Download MP4';
    setStatus('Rendering MP4\u2026 the download will start when ready.');

    const url = `/api/replay/${agent.index}.mp4?v=${loadVersion}`;

    const promise = (async () => {
      let resp: Response;
      try {
        resp = await fetch(url);
      } catch (e) {
        throw e instanceof Error ? e : new Error(String(e));
      }
      if (!resp.ok) {
        const msg = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status}: ${msg}`);
      }
      const blob = await resp.blob();
      // Trigger an explicit anchor download. This fires the browser's
      // save-file UX regardless of whether the originating popup is
      // still open.
      const safeBlob = new Blob([blob], {type: 'video/mp4'});
      const dlUrl = objectUrlFromSafeSource(safeBlob);
      const tmp = document.createElement('a');
      setAnchorHref(tmp, dlUrl);
      tmp.download = `${agent.agent_name || `agent_${agent.index}`}_replay.mp4`;
      document.body.appendChild(tmp);
      tmp.click();
      document.body.removeChild(tmp);
      setTimeout(() => {
        URL.revokeObjectURL(dlUrl.toString());
      }, 60_000);
    })();

    const pending: PendingMp4Download = {
      promise,
      listeners: new Set<HTMLButtonElement>(),
      originalText,
    };
    pendingMp4.set(agent.index, pending);
    applyMp4PendingStateToButton(btn, pending);

    promise
      .catch((e: Error) => {
        setStatus(`Download failed: ${e.message}`, 'error');
        console.error('rv downloadReplayMp4 failed', e);
      })
      .finally(() => {
        pendingMp4.delete(agent.index);
        // Re-enable every button that was waiting on this download
        // (the originating popup's button, plus any popup buttons that
        // were opened later while the same download was still in
        // flight).
        for (const listener of pending.listeners) {
          listener.disabled = false;
          listener.textContent = pending.originalText;
        }
        pending.listeners.clear();
      });
  }

  async function openReplay(agent: RvAgent) {
    // Tear down any prior replay first.
    closeReplay();

    const overlay = document.createElement('div');
    overlay.className = 'rv-replay-overlay';
    const card = document.createElement('div');
    card.className = 'rv-replay-card';

    const headerEl = document.createElement('div');
    headerEl.className = 'rv-replay-header';
    const titleEl = document.createElement('div');
    titleEl.className = 'rv-replay-title';
    titleEl.textContent = `Replay \u00b7 ${agent.agent_name}`;

    const dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'btn btn-ghost btn-sm rv-replay-download';
    dlBtn.title = 'Download replay (audio + frame slideshow as MP4)';
    dlBtn.textContent = '\u2B07 Download MP4';
    dlBtn.addEventListener('click', () => {
      downloadReplayMp4(agent, dlBtn);
    });
    // If a download is already in flight for this agent (e.g. user closed
    // the previous popup mid-render), reflect that in the new button so
    // it stays disabled until the existing download completes.
    const existingDownload = pendingMp4.get(agent.index);
    if (existingDownload) {
      applyMp4PendingStateToButton(dlBtn, existingDownload);
    }

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'rv-replay-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', closeReplay);
    headerEl.appendChild(titleEl);
    headerEl.appendChild(dlBtn);
    headerEl.appendChild(closeBtn);

    const stage = document.createElement('div');
    stage.className = 'rv-replay-stage';
    const img = document.createElement('img');
    img.className = 'rv-replay-frame';
    img.alt = '';
    const noFrames = document.createElement('div');
    noFrames.className = 'rv-replay-noframes';
    noFrames.textContent = 'No client video frames recorded.';
    stage.appendChild(img);
    if (!agent.frames || !agent.frames.length) {
      stage.appendChild(noFrames);
      img.hidden = true;
    }

    const audio = document.createElement('audio');
    audio.controls = true;
    // Suppress the browser's built-in "Download" item in the overflow
    // menu. The mixed WAV is a synthetic replay artifact; users who want
    // the original recording use the Download button in the Recent
    // recordings list.
    audio.setAttribute('controlsList', 'nodownload noplaybackrate');
    audio.preload = 'auto';
    audio.className = 'rv-replay-audio';
    audio.src = `/api/audio/${agent.index}.wav?v=${loadVersion}`;

    card.appendChild(headerEl);
    card.appendChild(stage);
    card.appendChild(audio);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Click on the backdrop (but not the card itself) closes.
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeReplay();
    });
    document.addEventListener('keydown', escHandler);

    const session: ReplaySession = {
      overlay,
      audio,
      img,
      rafId: null,
      frameUrls: [],
    };
    activeReplay = session;

    // Pre-fetch frames as Blob -> object URL so seeking is instant. Done
    // in parallel; capped to keep memory bounded for very long sessions.
    const frames = agent.frames || [];
    const FRAME_LIMIT = 600; // ~10 min at 1 fps
    const sampled =
      frames.length <= FRAME_LIMIT
        ? frames
        : frames.filter(
            (_, i) => i % Math.ceil(frames.length / FRAME_LIMIT) === 0,
          );
    const sampledTimes: number[] = sampled.map((f) => f.frame_ms);
    const fetchPromises = sampled.map((_, i) => {
      const origIdx = frames.indexOf(sampled[i]);
      return fetch(`/api/frame/${agent.index}/${origIdx}?v=${loadVersion}`)
        .then((r) => (r.ok ? r.blob() : null))
        .then((blob) => {
          if (!blob || activeReplay !== session) return '';
          const safeBlob = new Blob([blob], {
            type: blob.type || 'image/jpeg',
          });
          const safeUrl = objectUrlFromSafeSource(safeBlob);
          session.frameUrls.push(safeUrl.toString());
          return safeUrl.toString();
        })
        .catch(() => '');
    });
    const frameUrls = await Promise.all(fetchPromises);
    if (activeReplay !== session) return; // closed during fetch.

    let lastShownIdx = -1;
    function tick() {
      if (activeReplay !== session) return;
      const tMs = audio.currentTime * 1000;
      // Find the latest frame whose frame_ms <= tMs.
      let lo = 0;
      let hi = sampledTimes.length - 1;
      let best = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sampledTimes[mid] <= tMs) {
          best = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best !== lastShownIdx && best >= 0 && frameUrls[best]) {
        lastShownIdx = best;
        // safevalues already validated the URL via objectUrlFromSafeSource;
        // re-wrap here is not needed for img.src in tsetse.
        img.src = frameUrls[best];
        img.hidden = false;
      }
      session.rafId = requestAnimationFrame(tick);
    }
    session.rafId = requestAnimationFrame(tick);
  }

  function escHandler(e: KeyboardEvent) {
    if (e.key === 'Escape' && activeReplay) {
      closeReplay();
    }
    if (e.key === 'Escape' && activeImagePopup) {
      closeImagePopup();
    }
  }

  // ---------- Image popup (single-message frame viewer) ----------
  interface ImagePopupSession {
    overlay: HTMLElement;
    objectUrls: string[];
  }
  let activeImagePopup: ImagePopupSession | null = null;

  function closeImagePopup() {
    const r = activeImagePopup;
    if (!r) return;
    activeImagePopup = null;
    for (const u of r.objectUrls) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        // ignored
      }
    }
    if (r.overlay.parentNode) r.overlay.parentNode.removeChild(r.overlay);
  }

  async function openImagePopup(agent: RvAgent, m: RvMessage) {
    closeImagePopup();
    const indices = m.frame_indices || [];
    if (!indices.length) return;

    const overlay = document.createElement('div');
    overlay.className = 'rv-replay-overlay';
    const card = document.createElement('div');
    card.className = 'rv-replay-card';

    const headerEl = document.createElement('div');
    headerEl.className = 'rv-replay-header';
    const titleEl = document.createElement('div');
    titleEl.className = 'rv-replay-title';
    titleEl.textContent =
      `Image \u00b7 ${agent.agent_name} \u00b7 ${fmtMs(m.wire_ms)}` +
      (indices.length > 1 ? ` \u00b7 ${indices.length} frames` : '');
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'rv-replay-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', closeImagePopup);
    headerEl.appendChild(titleEl);
    headerEl.appendChild(closeBtn);

    const stage = document.createElement('div');
    stage.className = 'rv-replay-stage';
    const img = document.createElement('img');
    img.className = 'rv-replay-frame';
    img.alt = '';
    stage.appendChild(img);

    // Multi-frame navigation strip.
    let cursor = 0;
    const nav = document.createElement('div');
    nav.className = 'rv-img-nav';
    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'rv-img-nav-btn';
    prevBtn.textContent = '\u2039';
    const navLabel = document.createElement('span');
    navLabel.className = 'rv-img-nav-label';
    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'rv-img-nav-btn';
    nextBtn.textContent = '\u203A';
    nav.appendChild(prevBtn);
    nav.appendChild(navLabel);
    nav.appendChild(nextBtn);
    if (indices.length <= 1) nav.hidden = true;

    card.appendChild(headerEl);
    card.appendChild(stage);
    card.appendChild(nav);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeImagePopup();
    });
    document.addEventListener('keydown', escHandler);

    const session: ImagePopupSession = {
      overlay,
      objectUrls: [],
    };
    activeImagePopup = session;

    const urls: Array<string | null> = new Array(indices.length).fill(null);
    async function showAt(i: number) {
      cursor = Math.max(0, Math.min(indices.length - 1, i));
      navLabel.textContent = `${cursor + 1} / ${indices.length}`;
      prevBtn.disabled = cursor === 0;
      nextBtn.disabled = cursor === indices.length - 1;
      if (urls[cursor] == null) {
        try {
          const resp = await fetch(
            `/api/frame/${agent.index}/${indices[cursor]}?v=${loadVersion}`,
          );
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const blob = await resp.blob();
          if (activeImagePopup !== session) return;
          const safeBlob = new Blob([blob], {
            type: blob.type || 'image/jpeg',
          });
          const safeUrl = objectUrlFromSafeSource(safeBlob);
          urls[cursor] = safeUrl.toString();
          session.objectUrls.push(safeUrl.toString());
        } catch (e) {
          console.error('rv image fetch failed', e);
          return;
        }
      }
      if (activeImagePopup !== session) return;
      img.src = urls[cursor]!;
    }
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void showAt(cursor - 1);
    });
    nextBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void showAt(cursor + 1);
    });
    void showAt(0);
  }

  // ---------- Status ----------
  function setStatus(msg: string, kind?: 'ok' | 'error') {
    statusEl.textContent = msg || '';
    statusEl.className = `status-badge ${kind || ''}`;
  }

  // ---------- Utilities ----------
  function fmtMs(ms: number): string {
    if (ms < 1000) return `${ms.toFixed(1)} ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(2)} s`;
    const mn = Math.floor(s / 60);
    const r = (s - mn * 60).toFixed(2);
    return `${mn}m ${r}s`;
  }
  function fmtBytes(n: number): string {
    if (!n) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
    return `${(n / 1024 / 1024).toFixed(2)} MiB`;
  }
  function fmtTimeAgo(epochSec: number): string {
    const d = new Date(epochSec * 1000);
    return d.toLocaleString();
  }

  function getAgentMode(agent: RvAgent): RvMode {
    return agentModeOverride.get(agent.index) || globalMode;
  }
  function getAgentTotalMs(agent: RvAgent): number {
    if (!agent.messages.length) return 100;
    const mode = getAgentMode(agent);
    let maxMs = 0;
    for (const m of agent.messages) {
      const t = mode === 'message' ? m.wire_ms || 0 : m.end_ms;
      if (t > maxMs) maxMs = t;
    }
    return Math.max(maxMs, 100);
  }
  function getAgentZoom(agent: RvAgent): number {
    return agentZoom.get(agent.index) || 1;
  }

  /**
   * Returns the base px-per-ms scale at zoom=1 for an agent's timeline.
   *
   * For short recordings we keep the previous "fit-to-width" behavior so
   * tiny sessions don't appear scrunched. For longer recordings the scale
   * is pinned so ``DEFAULT_WINDOW_MS`` worth of timeline fills the
   * viewport; the rest scrolls into view.
   */
  function baseScalePxPerMs(totalMs: number): number {
    const minWidth = Math.max(window.innerWidth - 80, 1200);
    const fitPxPerMs = Math.max(minWidth / Math.max(totalMs, 1), 0.001);
    const windowPxPerMs = minWidth / DEFAULT_WINDOW_MS;
    // Pick the more zoomed-in scale: when the recording is shorter than
    // ``DEFAULT_WINDOW_MS``, ``fitPxPerMs`` is larger (no horizontal
    // scroll needed). When the recording is longer, ``windowPxPerMs`` is
    // larger and yields a ~20s viewport with the rest scrolled offscreen.
    return Math.max(fitPxPerMs, windowPxPerMs);
  }

  // ---------- Tooltip ----------
  function makeKv(container: HTMLElement, label: string, value: string) {
    const b = document.createElement('b');
    b.textContent = label;
    const s = document.createElement('span');
    s.textContent = value;
    container.appendChild(b);
    container.appendChild(s);
  }
  function buildTooltipDom(
    m: RvMessage,
    pinned: boolean,
    onPlay?: () => void,
    onClose?: () => void,
    onShowImage?: () => void,
  ): DocumentFragment {
    const frag = document.createDocumentFragment();
    if (pinned) {
      const bar = document.createElement('div');
      bar.id = 'rv-tt-pin-bar';
      const pinnedBadge = document.createElement('span');
      pinnedBadge.className = 'badge';
      pinnedBadge.style.background = 'var(--accent)';
      pinnedBadge.style.color = 'white';
      pinnedBadge.textContent = 'PINNED';
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = 'click outside to close';
      const closeBtn = document.createElement('button');
      closeBtn.title = 'Close';
      closeBtn.textContent = '\u00d7';
      if (onClose) closeBtn.addEventListener('click', onClose);
      bar.appendChild(pinnedBadge);
      bar.appendChild(hint);
      bar.appendChild(closeBtn);
      frag.appendChild(bar);
    }
    const h3 = document.createElement('h3');
    h3.textContent = `${m.direction.toUpperCase()} \u00b7 ${m.kind}`;
    frag.appendChild(h3);
    const badgeRow = document.createElement('div');
    const modalityBadge = document.createElement('span');
    modalityBadge.className = 'badge';
    modalityBadge.textContent = m.modality;
    badgeRow.appendChild(modalityBadge);
    if (m.interrupted) {
      const intr = document.createElement('span');
      intr.className = 'badge';
      intr.style.background = 'var(--danger)';
      intr.style.color = 'white';
      intr.textContent = 'INTERRUPTED';
      badgeRow.appendChild(intr);
    }
    frag.appendChild(badgeRow);
    if (pinned && m.audio_bytes > 0) {
      const playRow = document.createElement('div');
      playRow.style.marginTop = '6px';
      const playBtn = document.createElement('button');
      playBtn.id = 'rv-tt-play';
      playBtn.className = 'play-action';
      playBtn.textContent = '\u25b6 Play audio';
      if (onPlay) {
        playBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          onPlay();
        });
      }
      const meta = document.createElement('span');
      meta.className = 'hint';
      meta.style.marginLeft = '8px';
      meta.textContent =
        `${fmtMs(m.duration_ms)} \u00b7 ${fmtBytes(m.audio_bytes)} @ ` +
        `${m.audio_rate_hz} Hz`;
      playRow.appendChild(playBtn);
      playRow.appendChild(meta);
      frag.appendChild(playRow);
    }
    if (pinned && m.frame_indices && m.frame_indices.length && onShowImage) {
      const imgRow = document.createElement('div');
      imgRow.style.marginTop = '6px';
      const imgBtn = document.createElement('button');
      imgBtn.id = 'rv-tt-show-image';
      imgBtn.className = 'play-action';
      imgBtn.textContent =
        m.frame_indices.length > 1
          ? `\u{1F5BC} Show ${m.frame_indices.length} images`
          : '\u{1F5BC} Show image';
      imgBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onShowImage();
      });
      imgRow.appendChild(imgBtn);
      frag.appendChild(imgRow);
    }
    const kv = document.createElement('div');
    kv.className = 'kv';
    kv.style.marginTop = '6px';
    makeKv(kv, 'start', fmtMs(m.start_ms));
    makeKv(kv, 'end', fmtMs(m.end_ms));
    makeKv(kv, 'duration', fmtMs(m.duration_ms));
    if (m.wire_ms != null) makeKv(kv, 'wire', fmtMs(m.wire_ms));
    if (m.audio_bytes) {
      makeKv(kv, 'audio', `${fmtBytes(m.audio_bytes)} @ ${m.audio_rate_hz} Hz`);
    }
    if (m.mime_types && m.mime_types.length) {
      makeKv(kv, 'mime', m.mime_types.join(', '));
    }
    if (m.text_preview) makeKv(kv, 'text', m.text_preview);
    frag.appendChild(kv);
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(m.detail, null, 2);
    frag.appendChild(pre);
    return frag;
  }
  function positionTooltipNear(clientX: number, clientY: number) {
    const pad = 14;
    const prev = tooltip.style.display;
    if (prev === 'none' || !prev) tooltip.style.display = 'block';
    const rect = tooltip.getBoundingClientRect();
    let x = clientX + pad;
    let y = clientY + pad;
    if (x + rect.width > window.innerWidth) x = clientX - rect.width - pad;
    if (y + rect.height > window.innerHeight) {
      y = clientY - rect.height - pad;
    }
    if (x < 0) x = 0;
    if (y < 0) y = 0;
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  }
  function showTooltip(e: MouseEvent, m: RvMessage) {
    if (tooltipPinned) return;
    tooltip.replaceChildren(buildTooltipDom(m, false));
    tooltip.style.display = 'block';
    positionTooltipNear(e.clientX, e.clientY);
  }
  function moveTooltip(e: MouseEvent) {
    if (tooltipPinned) return;
    positionTooltipNear(e.clientX, e.clientY);
  }
  function hideTooltip() {
    if (tooltipPinned) return;
    tooltip.style.display = 'none';
  }
  function pinTooltip(e: MouseEvent, agent: RvAgent, m: RvMessage) {
    tooltipPinned = true;
    tooltip.classList.add('pinned');
    tooltip.replaceChildren(
      buildTooltipDom(
        m,
        true,
        () => {
          void playMessage(agent, m);
        },
        unpinTooltip,
        () => {
          void openImagePopup(agent, m);
        },
      ),
    );
    tooltip.style.display = 'block';
    positionTooltipNear(e.clientX, e.clientY);
  }
  function unpinTooltip() {
    tooltipPinned = false;
    tooltip.classList.remove('pinned');
    tooltip.style.display = 'none';
    tooltip.replaceChildren();
  }
  document.addEventListener('mousedown', (e) => {
    if (!tooltipPinned) return;
    const t = e.target as HTMLElement;
    if (tooltip.contains(t)) return;
    if (t.closest && t.closest('.msg')) return;
    unpinTooltip();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && tooltipPinned) unpinTooltip();
  });

  // ---------- Ruler ----------
  function renderRuler(totalMs: number, pxPerMs: number): HTMLElement {
    const ruler = document.createElement('div');
    ruler.className = 'ruler';
    ruler.style.width = `${totalMs * pxPerMs + LABEL_W + RIGHT_PAD}px`;
    const targetTicks = 10;
    const rawStep = totalMs / targetTicks;
    const niceSteps = [
      50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 30000, 60000, 120000,
      300000, 600000,
    ];
    let step = niceSteps[niceSteps.length - 1];
    for (const s of niceSteps) {
      if (s >= rawStep) {
        step = s;
        break;
      }
    }
    for (let t = 0; t <= totalMs; t += step) {
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.style.left = `${LABEL_W + t * pxPerMs}px`;
      tick.textContent = fmtMs(t);
      ruler.appendChild(tick);
    }
    return ruler;
  }

  // ---------- Lane packing ----------
  interface LaneItem {
    el: HTMLElement;
    left: number;
    right: number;
    lane?: number;
  }
  function packLanes(items: LaneItem[]): number {
    if (!items.length) return 0;
    const sorted = [...items].sort((a, b) => a.left - b.left);
    const laneEnds: number[] = [];
    for (const it of sorted) {
      let assigned = -1;
      for (let i = 0; i < laneEnds.length; i++) {
        if (laneEnds[i] <= it.left) {
          assigned = i;
          break;
        }
      }
      if (assigned === -1) {
        assigned = laneEnds.length;
        laneEnds.push(it.right);
      } else {
        laneEnds[assigned] = it.right;
      }
      it.lane = assigned;
    }
    return laneEnds.length;
  }
  function findOverlapComponents(items: LaneItem[]): LaneItem[][] {
    if (!items.length) return [];
    const sorted = [...items].sort((a, b) => a.left - b.left);
    const components: LaneItem[][] = [];
    let cur: LaneItem[] = [sorted[0]];
    let curRight = sorted[0].right;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].left < curRight) {
        cur.push(sorted[i]);
        curRight = Math.max(curRight, sorted[i].right);
      } else {
        components.push(cur);
        cur = [sorted[i]];
        curRight = sorted[i].right;
      }
    }
    components.push(cur);
    return components;
  }
  function zigzagPermutation(numLanes: number): number[] {
    if (numLanes <= 1) return [0];
    const perm: number[] = new Array(numLanes);
    for (let i = 0; i < numLanes; i++) {
      perm[i] = i % 2 === 0 ? i >> 1 : numLanes - 1 - ((i - 1) >> 1);
    }
    return perm;
  }
  function applyClusterBands(
    barList: Array<{el: HTMLElement; left: number}>,
    track: HTMLElement,
  ) {
    const CLUSTER_PX = 6;
    const MIN_BAND_H = 4;
    if (!barList.length) return;
    const items: LaneItem[] = barList.map((b) => ({
      el: b.el,
      left: b.left,
      right: b.left + CLUSTER_PX,
    }));
    const components = findOverlapComponents(items);
    for (const comp of components) {
      if (comp.length === 1) {
        comp[0].el.style.zIndex = '10';
        track.appendChild(comp[0].el);
        continue;
      }
      const numLanes = packLanes(comp);
      const idealH = ROW_H / numLanes;
      const bandH =
        numLanes * MIN_BAND_H <= ROW_H ? Math.max(MIN_BAND_H, idealH) : idealH;
      const perm = zigzagPermutation(numLanes);
      const clusterId = `inst_${comp[0].left.toFixed(2)}`;
      for (const it of comp) {
        const slot = perm[it.lane!];
        it.el.style.top = (slot * bandH).toFixed(2) + 'px';
        it.el.style.height = bandH.toFixed(2) + 'px';
        it.el.style.zIndex = '10';
        it.el.dataset['bandLocked'] = '1';
        it.el.dataset['clusterId'] = clusterId;
        it.el.dataset['bandIndex'] = String(slot);
        it.el.dataset['bandCount'] = String(numLanes);
        track.appendChild(it.el);
      }
    }
  }
  function applyOverlapBands(
    durationBars: Array<{el: HTMLElement; left: number; width: number}>,
  ) {
    if (durationBars.length < 2) return;
    const MIN_BAND_H = 4;
    const items: LaneItem[] = durationBars.map((b) => ({
      el: b.el,
      left: b.left,
      right: b.left + b.width,
    }));
    const components = findOverlapComponents(items);
    for (const comp of components) {
      if (comp.length < 2) continue;
      const numLanes = packLanes(comp);
      if (numLanes < 2) continue;
      const idealH = ROW_H / numLanes;
      const bandH =
        numLanes * MIN_BAND_H <= ROW_H ? Math.max(MIN_BAND_H, idealH) : idealH;
      const perm = zigzagPermutation(numLanes);
      const clusterId = `dur_${comp[0].left.toFixed(2)}`;
      for (const it of comp) {
        const slot = perm[it.lane!];
        it.el.style.top = (slot * bandH).toFixed(2) + 'px';
        it.el.style.height = bandH.toFixed(2) + 'px';
        it.el.dataset['bandLocked'] = '1';
        it.el.dataset['clusterId'] = clusterId;
        it.el.dataset['bandIndex'] = String(slot);
        it.el.dataset['bandCount'] = String(numLanes);
      }
    }
  }

  // ---------- Fisheye magnification ----------
  function fisheyeMap(x: number, cx: number): number {
    const d = x - cx;
    const r = FISHEYE_RADIUS_PX;
    if (d <= -r || d >= r) return x;
    const t = d / r;
    const sign = t < 0 ? -1 : 1;
    const tNew = sign * (1 - Math.pow(1 - Math.abs(t), FISHEYE_K));
    return cx + tNew * r;
  }
  function fisheyeMag(distancePx: number): number {
    if (Math.abs(distancePx) >= FISHEYE_RADIUS_PX) return 1;
    const g = Math.exp(
      -(distancePx * distancePx) / (FISHEYE_SIGMA_PX * FISHEYE_SIGMA_PX),
    );
    return 1 + (FISHEYE_MAX_SCALE - 1) * g;
  }
  function fisheyeMagForRange(left: number, right: number, cx: number): number {
    let dist;
    if (cx < left) dist = left - cx;
    else if (cx > right) dist = cx - right;
    else dist = 0;
    return fisheyeMag(dist);
  }
  interface FisheyeBar {
    el: HTMLElement;
    left: number;
    width: number;
    instant: boolean;
    bandLocked: boolean;
    restTop: number;
    restH: number;
    bandIndex: number;
    bandCount: number;
  }
  function setupFisheye(track: HTMLElement) {
    const bars: FisheyeBar[] = [];
    const clusters = new Map<string, FisheyeBar[]>();
    const msgEls = track.querySelectorAll<HTMLElement>('.msg');
    for (const el of msgEls) {
      const left = Number(el.style.left.replace(/px$/, '')) || 0;
      const isInstant = el.classList.contains('instant');
      const width = isInstant
        ? 2
        : Number(el.style.width.replace(/px$/, '')) || 0;
      const bandLocked = el.dataset['bandLocked'] === '1';
      const bar: FisheyeBar = {
        el,
        left,
        width,
        instant: isInstant,
        bandLocked,
        restTop: Number(el.style.top.replace(/px$/, '')) || 0,
        restH: Number(el.style.height.replace(/px$/, '')) || 0,
        bandIndex: Math.trunc(Number(el.dataset['bandIndex'] || '0')),
        bandCount: Math.trunc(Number(el.dataset['bandCount'] || '1')),
      };
      if (bandLocked) {
        const cid = el.dataset['clusterId'] || '';
        if (!clusters.has(cid)) clusters.set(cid, []);
        clusters.get(cid)!.push(bar);
      }
      bars.push(bar);
    }
    if (!bars.length) return;
    for (const group of clusters.values()) {
      group.sort((a, b) => a.bandIndex - b.bandIndex);
    }

    const cursor = document.createElement('div');
    cursor.className = 'cursor-line';
    track.appendChild(cursor);

    let raf: number | null = null;
    let lastCx: number | null = null;
    let lastCy: number | null = null;

    function paint() {
      raf = null;
      const cx = lastCx;
      if (cx == null) return;
      cursor.style.display = 'block';
      cursor.style.left = `${cx - 0.5}px`;
      for (const b of bars) {
        const newLeft = fisheyeMap(b.left, cx);
        let mag: number;
        if (b.instant) {
          b.el.style.left = `${newLeft}px`;
          mag = fisheyeMag(newLeft + b.width / 2 - cx);
        } else {
          const newRight = fisheyeMap(b.left + b.width, cx);
          b.el.style.left = `${newLeft}px`;
          const w = Math.max(1, newRight - newLeft - FISHEYE_GAP_PX);
          b.el.style.width = `${w}px`;
          mag = fisheyeMagForRange(newLeft, newLeft + w, cx);
        }
        if (b.instant && mag !== 1) {
          b.el.style.transform = `scaleX(${mag.toFixed(3)})`;
        } else {
          b.el.style.transform = '';
        }
      }
      // Band-locked cluster vertical redistribution.
      if (clusters.size && lastCy != null) {
        const Y_SIGMA = 6;
        const WEIGHT_PEAK = 6;
        for (const group of clusters.values()) {
          const n = group.length;
          if (n < 2) continue;
          const colX = group[0].left + group[0].width / 2;
          const horizGate = fisheyeMag(colX - cx) - 1;
          const horizProx = Math.min(1, horizGate / (FISHEYE_MAX_SCALE - 1));
          const restBandH = ROW_H / n;
          const weights = new Array<number>(n);
          let sumW = 0;
          for (let i = 0; i < n; i++) {
            const center = (i + 0.5) * restBandH;
            const dy = lastCy - center;
            const peak = 1 + horizProx * (WEIGHT_PEAK - 1);
            const w =
              1 + (peak - 1) * Math.exp(-(dy * dy) / (Y_SIGMA * Y_SIGMA));
            weights[i] = w;
            sumW += w;
          }
          let curTop = 0;
          for (let i = 0; i < n; i++) {
            const h = (ROW_H * weights[i]) / sumW;
            group[i].el.style.top = curTop.toFixed(2) + 'px';
            group[i].el.style.height = h.toFixed(2) + 'px';
            curTop += h;
          }
        }
      }
    }
    function reset() {
      cursor.style.display = 'none';
      for (const b of bars) {
        b.el.style.left = `${b.left}px`;
        if (!b.instant) b.el.style.width = `${b.width}px`;
        if (b.bandLocked) {
          b.el.style.top = b.restTop.toFixed(2) + 'px';
          b.el.style.height = b.restH.toFixed(2) + 'px';
        }
        b.el.style.transform = '';
      }
      track.classList.remove('zoom');
    }
    track.addEventListener('mousemove', (e) => {
      const rect = track.getBoundingClientRect();
      lastCx = e.clientX - rect.left;
      lastCy = e.clientY - rect.top;
      track.classList.add('zoom');
      if (raf == null) raf = requestAnimationFrame(paint);
    });
    track.addEventListener('mouseleave', () => {
      if (raf != null) {
        cancelAnimationFrame(raf);
        raf = null;
      }
      lastCx = null;
      lastCy = null;
      reset();
    });
  }

  // ---------- Timeline ----------
  function renderTimeline(agent: RvAgent): HTMLElement {
    const mode = getAgentMode(agent);
    const wrap = document.createElement('div');
    wrap.className = 'timeline-wrap';

    const totalMs = getAgentTotalMs(agent);
    const basePxPerMs = baseScalePxPerMs(totalMs);
    const pxPerMs = basePxPerMs * getAgentZoom(agent);

    const tl = document.createElement('div');
    tl.className = 'timeline';
    tl.style.width = `${totalMs * pxPerMs + LABEL_W + RIGHT_PAD}px`;
    tl.appendChild(renderRuler(totalMs, pxPerMs));

    const directions: Array<{key: 'client' | 'server'; label: string}> = [
      {key: 'client', label: 'CLIENT \u2192'},
      {key: 'server', label: 'SERVER \u2190'},
    ];
    for (const dir of directions) {
      const row = document.createElement('div');
      row.className = 'row';
      const lbl = document.createElement('span');
      lbl.className = 'row-label';
      lbl.textContent = dir.label;
      row.appendChild(lbl);
      const track = document.createElement('div');
      track.className = 'row-track';
      row.appendChild(track);

      if (mode === 'message') {
        const allBars: Array<{el: HTMLElement; left: number}> = [];
        for (let i = 0; i < agent.messages.length; i++) {
          const m = agent.messages[i];
          if (m.direction !== dir.key) continue;
          const el = document.createElement('div');
          const cls = ['msg', 'instant', m.modality];
          if (m.direction === 'server' && m.modality === 'audio') {
            cls.push('server');
          }
          if (m.interrupted) cls.push('dropped');
          const left = (m.wire_ms || 0) * pxPerMs;
          el.style.left = `${left}px`;
          el.style.width = `${MESSAGE_BAR_W}px`;
          el.title = `${m.kind} @ wire ${(m.wire_ms || 0).toFixed(1)} ms`;
          el.className = cls.join(' ');
          el.addEventListener('mouseenter', (e) => {
            showTooltip(e, m);
          });
          el.addEventListener('mousemove', moveTooltip);
          el.addEventListener('mouseleave', hideTooltip);
          el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            pinTooltip(ev, agent, m);
          });
          allBars.push({el, left});
        }
        applyClusterBands(allBars, track);
      } else {
        const durationBars: Array<{
          el: HTMLElement;
          left: number;
          width: number;
        }> = [];
        const instants: Array<{el: HTMLElement; left: number}> = [];
        for (let i = 0; i < agent.messages.length; i++) {
          const m = agent.messages[i];
          if (m.direction !== dir.key) continue;
          const el = document.createElement('div');
          const cls = ['msg', m.modality];
          if (m.direction === 'server' && m.modality === 'audio') {
            cls.push('server');
          }
          if (m.interrupted) cls.push('dropped');
          const durationMs = m.end_ms - m.start_ms;
          const isInstant = durationMs <= 0;
          const left = m.start_ms * pxPerMs;
          el.style.left = `${left}px`;
          let widthPx = 2;
          if (isInstant) {
            cls.push('instant');
            el.title = `${m.kind} @ ${m.start_ms.toFixed(1)} ms`;
          } else {
            widthPx = Math.max(2, durationMs * pxPerMs);
            el.style.width = `${widthPx}px`;
            if (widthPx < 30) cls.push('tiny');
            else el.textContent = m.modality;
          }
          el.className = cls.join(' ');
          el.addEventListener('mouseenter', (e) => {
            showTooltip(e, m);
          });
          el.addEventListener('mousemove', moveTooltip);
          el.addEventListener('mouseleave', hideTooltip);
          el.addEventListener('click', (ev) => {
            ev.stopPropagation();
            pinTooltip(ev, agent, m);
          });
          if (isInstant) {
            instants.push({el, left});
          } else {
            durationBars.push({el, left, width: widthPx});
          }
        }
        durationBars.sort((a, b) => b.width - a.width);
        for (const b of durationBars) track.appendChild(b.el);
        applyOverlapBands(durationBars);
        applyClusterBands(instants, track);
      }
      setupFisheye(track);
      tl.appendChild(row);
    }
    wrap.appendChild(tl);
    return wrap;
  }

  // ---------- Zoom controls ----------
  function buildAgentZoomControls(agent: RvAgent): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'zoom-ctrl';
    const out = document.createElement('button');
    out.type = 'button';
    out.textContent = '\u2212';
    const lbl = document.createElement('span');
    lbl.className = 'zoom-level';
    lbl.id = `rv-zoom-level-${agent.index}`;
    const inn = document.createElement('button');
    inn.type = 'button';
    inn.textContent = '+';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset';
    reset.style.fontSize = '11px';

    out.addEventListener('click', () => {
      setAgentZoom(agent, getAgentZoom(agent) / ZOOM_STEP);
    });
    inn.addEventListener('click', () => {
      setAgentZoom(agent, getAgentZoom(agent) * ZOOM_STEP);
    });
    reset.addEventListener('click', () => {
      setAgentZoom(agent, 1);
    });
    wrap.appendChild(out);
    wrap.appendChild(lbl);
    wrap.appendChild(inn);
    wrap.appendChild(reset);
    return wrap;
  }
  function updateAgentZoomLabel(agent: RvAgent) {
    const el = byId(`rv-zoom-level-${agent.index}`);
    if (!el) return;
    const pct = getAgentZoom(agent) * 100;
    el.textContent =
      pct >= 10 && Number.isInteger(pct)
        ? `${pct.toFixed(0)}%`
        : `${pct.toFixed(pct < 10 ? 1 : 0)}%`;
  }
  function setAgentZoom(agent: RvAgent, newZoom: number) {
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newZoom));
    const oldZoom = getAgentZoom(agent);
    if (clamped === oldZoom) {
      updateAgentZoomLabel(agent);
      return;
    }
    const block = byId(`rv-agent-block-${agent.index}`);
    const oldWrap = block?.querySelector<HTMLElement>('.timeline-wrap');
    // Capture the time the viewport is currently centered on so we can
    // restore it at the new zoom level (otherwise the new wrap renders at
    // scrollLeft=0 and the user loses their place).
    const totalMs = getAgentTotalMs(agent);
    const basePxPerMs = baseScalePxPerMs(totalMs);
    const oldPxPerMs = basePxPerMs * oldZoom;
    const newPxPerMs = basePxPerMs * clamped;
    let centerMs = 0;
    let viewportW = 0;
    if (oldWrap) {
      viewportW = oldWrap.clientWidth;
      const centerPx = oldWrap.scrollLeft + viewportW / 2;
      centerMs = (centerPx - LABEL_W) / oldPxPerMs;
      if (!Number.isFinite(centerMs) || centerMs < 0) centerMs = 0;
      if (centerMs > totalMs) centerMs = totalMs;
    }

    agentZoom.set(agent.index, clamped);
    updateAgentZoomLabel(agent);
    rerenderAgentTimeline(agent);

    if (oldWrap) {
      const newWrap = block?.querySelector<HTMLElement>('.timeline-wrap');
      if (newWrap) {
        let target = centerMs * newPxPerMs + LABEL_W - viewportW / 2;
        const maxScroll = Math.max(
          0,
          newWrap.scrollWidth - newWrap.clientWidth,
        );
        if (target < 0) target = 0;
        if (target > maxScroll) target = maxScroll;
        newWrap.scrollLeft = target;
      }
    }
  }

  // ---------- Per-agent mode toggle ----------
  function buildAgentModeToggle(agent: RvAgent): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'segmented segmented-sm';
    const mode = getAgentMode(agent);
    for (const val of ['playback', 'message'] as RvMode[]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'segmented-option' + (val === mode ? ' is-active' : '');
      btn.textContent = val.charAt(0).toUpperCase() + val.slice(1);
      btn.addEventListener('click', () => {
        agentModeOverride.set(agent.index, val);
        for (const o of wrap.querySelectorAll('.segmented-option')) {
          (o as HTMLElement).classList.toggle(
            'is-active',
            (o as HTMLElement).textContent!.toLowerCase() === val,
          );
        }
        rerenderAgentTimeline(agent);
      });
      wrap.appendChild(btn);
    }
    return wrap;
  }
  function rerenderAgentTimeline(agent: RvAgent) {
    const block = byId(`rv-agent-block-${agent.index}`);
    if (!block) return;
    const oldWrap = block.querySelector('.timeline-wrap');
    if (!oldWrap) return;
    const newWrap = renderTimeline(agent);
    oldWrap.replaceWith(newWrap);
  }

  // ---------- Agent block ----------
  function renderAgent(agent: RvAgent): HTMLElement {
    const block = document.createElement('div');
    block.className = 'agent';
    block.id = `rv-agent-block-${agent.index}`;

    const header = document.createElement('div');
    header.className = 'agent-header';
    const title = document.createElement('h2');
    title.textContent = agent.agent_name;
    header.appendChild(title);
    const total = document.createElement('span');
    total.className = 'total';
    total.textContent = `${agent.messages.length} messages, ${fmtMs(agent.total_ms)} total`;
    header.appendChild(total);

    const player = document.createElement('div');
    player.className = 'player';
    const replayBtn = document.createElement('button');
    replayBtn.type = 'button';
    replayBtn.className = 'btn btn-primary btn-sm';
    replayBtn.textContent = '\u25B6 Replay session';
    replayBtn.addEventListener('click', () => {
      void openReplay(agent);
    });
    player.appendChild(replayBtn);
    header.appendChild(player);

    header.appendChild(buildAgentModeToggle(agent));
    header.appendChild(buildAgentZoomControls(agent));
    block.appendChild(header);
    block.appendChild(renderTimeline(agent));
    updateAgentZoomLabel(agent);
    return block;
  }

  // ---------- Top-level render ----------
  function render(data: RvAgentsPayload) {
    lastAgentsData = data;
    loadVersion++;
    inputPathLabel.textContent = data.input_path || '';
    agentZoom.clear();
    agentModeOverride.clear();
    decodedChannels.clear();
    decodingPromises.clear();
    root.replaceChildren();
    if (!data.agents || !data.agents.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      const icon = document.createElement('div');
      icon.className = 'empty-icon';
      icon.textContent = '\uD83D\uDCFC';
      const title = document.createElement('div');
      title.className = 'empty-title';
      title.textContent = 'No recording loaded';
      const hint = document.createElement('div');
      hint.className = 'empty-hint';
      hint.textContent =
        'Pick a recent recording from the list, or upload a .recordio file.';
      empty.appendChild(icon);
      empty.appendChild(title);
      empty.appendChild(hint);
      root.appendChild(empty);
      return;
    }
    for (const a of data.agents) root.appendChild(renderAgent(a));
  }

  // ---------- API helpers ----------
  async function fetchJsonOrThrow(resp: Response): Promise<RvAgentsPayload> {
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(
        (data as {error?: string}).error || `HTTP ${resp.status}`,
      );
    }
    return data as RvAgentsPayload;
  }

  async function loadPath(path: string) {
    setStatus(`Loading ${path} \u2026`);
    try {
      const resp = await fetch('/api/load', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({path}),
      });
      const data = await fetchJsonOrThrow(resp);
      render(data);
      setStatus(`Loaded ${data.agents?.length || 0} agent(s).`, 'ok');
    } catch (e) {
      setStatus(`Load failed: ${(e as Error).message}`, 'error');
      console.error(e);
    }
  }
  async function uploadFile(file: File) {
    uploadBtn.disabled = true;
    setStatus(`Uploading ${file.name} (${fmtBytes(file.size)}) \u2026`);
    try {
      const fd = new FormData();
      fd.append('file', file, file.name);
      const resp = await fetch('/api/upload', {method: 'POST', body: fd});
      const data = await fetchJsonOrThrow(resp);
      render(data);
      setStatus(
        `Loaded ${data.agents?.length || 0} agent(s) from upload.`,
        'ok',
      );
      // Refresh the list since the upload was saved.
      void refreshList();
    } catch (e) {
      setStatus(`Upload failed: ${(e as Error).message}`, 'error');
      console.error(e);
    } finally {
      uploadBtn.disabled = false;
    }
  }

  // ---------- Recordings list ----------
  async function refreshList() {
    try {
      const resp = await fetch('/api/recordings');
      const data = (await resp.json()) as {recordings: RvRecordingEntry[]};
      const recordings = data.recordings || [];
      listEl.replaceChildren();
      if (!recordings.length) {
        const empty = document.createElement('div');
        empty.className = 'rv-list-empty';
        empty.textContent = 'No recordings found in the cache directory.';
        listEl.appendChild(empty);
        return;
      }
      const markActive = (item: HTMLElement) => {
        for (const n of listEl.querySelectorAll('.rv-list-item')) {
          (n as HTMLElement).classList.remove('is-active');
        }
        item.classList.add('is-active');
      };
      for (const r of recordings) {
        const item = document.createElement('div');
        item.className = 'rv-list-item';

        const info = document.createElement('div');
        info.className = 'rv-list-info';
        const name = document.createElement('div');
        name.className = 'rv-list-name mono';
        name.textContent = r.name;
        const meta = document.createElement('div');
        meta.className = 'rv-list-meta';
        meta.textContent = `${fmtTimeAgo(r.mtime)} · ${fmtBytes(r.size)}`;
        info.appendChild(name);
        info.appendChild(meta);
        item.appendChild(info);

        const actions = document.createElement('div');
        actions.className = 'rv-list-actions';

        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'rv-list-action';
        viewBtn.title = 'Open recording';
        viewBtn.textContent = '\u{1F50D}';
        viewBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          markActive(item);
          void loadPath(r.path);
        });

        const dlBtn = document.createElement('button');
        dlBtn.type = 'button';
        dlBtn.className = 'rv-list-action';
        dlBtn.title = 'Download recordio file';
        dlBtn.textContent = '\u2B07';
        dlBtn.addEventListener('click', (ev) => {
          // Don't change selection on download click.
          ev.stopPropagation();
          // Fetch the file as a Blob and synthesize a same-origin object
          // URL anchor click to trigger the download. Avoids CSP issues
          // around assigning a non-constant href.
          (async () => {
            try {
              const resp = await fetch(
                '/api/download?name=' + encodeURIComponent(r.name),
              );
              if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
              const blob = await resp.blob();
              // Force a generic application/octet-stream blob so the browser
              // doesn't sniff the content type when synthesizing the URL.
              const safeBlob = new Blob([blob], {
                type: 'application/octet-stream',
              });
              const safeUrl = objectUrlFromSafeSource(safeBlob);
              const tmp = document.createElement('a');
              setAnchorHref(tmp, safeUrl);
              tmp.download = r.name;
              document.body.appendChild(tmp);
              tmp.click();
              document.body.removeChild(tmp);
              setTimeout(() => {
                URL.revokeObjectURL(safeUrl.toString());
              }, 60_000);
            } catch (e) {
              setStatus(`Download failed: ${(e as Error).message}`, 'error');
            }
          })();
        });

        actions.appendChild(viewBtn);
        actions.appendChild(dlBtn);
        item.appendChild(actions);

        // Single click highlights; double-click loads.
        item.addEventListener('click', () => {
          markActive(item);
        });
        item.addEventListener('dblclick', () => {
          markActive(item);
          void loadPath(r.path);
        });

        listEl.appendChild(item);
      }
    } catch (e) {
      setStatus(`Failed to list recordings: ${(e as Error).message}`, 'error');
    }
  }

  // ---------- Initial fetch + global mode toggle ----------
  for (const btn of globalModeToggle.querySelectorAll('.segmented-option')) {
    btn.addEventListener('click', () => {
      const newMode = (btn as HTMLElement).dataset['value'] as RvMode;
      if (!newMode || newMode === globalMode) return;
      globalMode = newMode;
      for (const o of globalModeToggle.querySelectorAll('.segmented-option')) {
        (o as HTMLElement).classList.toggle(
          'is-active',
          (o as HTMLElement).dataset['value'] === newMode,
        );
      }
      agentModeOverride.clear();
      if (lastAgentsData) render(lastAgentsData);
    });
  }

  refreshBtn.addEventListener('click', () => {
    // Brief spin feedback so the user knows the click registered.
    // Using the Web Animations API avoids the well-known
    // "class-remove + reflow + class-add" race that prevents the
    // CSS animation from restarting on rapid (or even single repeated)
    // clicks. ``animate()`` always creates a fresh Animation instance.
    const svg = refreshBtn.querySelector('svg');
    if (svg && typeof (svg as Element).animate === 'function') {
      (svg as Element).animate(
        [{transform: 'rotate(0deg)'}, {transform: 'rotate(-360deg)'}],
        {duration: 600, easing: 'linear'},
      );
    }
    void refreshList();
  });
  uploadBtn.addEventListener('click', (e) => {
    e.preventDefault();
    uploadInput.click();
  });
  uploadInput.addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement;
    const f = t.files && t.files[0];
    if (f) void uploadFile(f);
    t.value = '';
  });

  void refreshList();

  return {refreshList};
}
