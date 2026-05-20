---
name: live-api-recording-viewer
description: >-
  Implements a single-page web viewer for a Live API session log produced by
  the message recorder (see `message_recorder.md`). Renders one interactive
  timeline per agent showing every client/server frame as a colored bar,
  supports per-message inspection of the full proto, and plays back a stereo
  audio mix of the conversation. Use when building a tool to debug, audit, or
  share a captured Live API session.
---

# Live API Recording Viewer

> **Part of the combined "recordings" feature.** The viewer and the
> message recorder (`message_recorder.md`) are a single user-facing
> option: enabling recordings turns on both, and disabling it removes
> both. The agent MUST NOT ask about the recorder and the viewer
> separately.

A web view that loads a recorded Live API session (a length-prefixed
protobuf stream in a `.pb` file produced by the message recorder) and
renders it as one interactive timeline per agent. A developer points the viewer at a
recording and immediately sees the bidirectional sequence of frames, can
hover or click any frame to inspect its full payload, and can listen to
individual audio chunks or a full stereo mix.

## Deployment: a tab inside the chat playground

When this feature is enabled, the viewer is **not** a separate web
app on a separate port. Instead it MUST be served by the same
process, on the same port, as the chat playground backend, and the
frontend MUST present it as a second sidebar tab ("Recordings") of
the single-page app that hosts the Chat tab (see `interactive_ui.md`).
Switching between Chat and Recordings is a client-side route change;
it does not reload the page. Loaded recordings are kept in-process on
the server so the Chat tab can keep its websocket while the user
inspects a recording in the other tab.

A reference frontend implementation lives in
`frontend/recording_viewer.ts` (rendered as the "Recordings" tab of
the single-entry `frontend/index.html`). It expects the viewer HTTP
endpoints listed below to be served by the **same** backend that
handles `/start` and `/ws` (see `backend_bridge.md`); the agent
implements them in the language picked in `SKILL.md` Step 1.

The shared `frontend/style.css` and `frontend/index.html` host the
chrome (sidebar, recordings tab header, recent-list panel, tooltip
overlay). There is **no "load by path" input** — recordings are
loaded either by clicking an entry in the recent list (which the
server populated from its cache directory) or by uploading a
recording file from the user's machine.

**Adapt these reference files rather than producing the viewer from
scratch.**

---

## Architecture

```
┌──────────────────────────┐         ┌──────────────────────────────┐
│  Recording on disk       │  load   │  HTTP server                 │
│  (message_recorder log)  │ ──────► │  - parse log                 │
└──────────────────────────┘         │  - reconstruct timelines     │
                                     │  - assemble per-agent WAV    │
                                     │  - serve JSON + WAV + SPA    │
                                     └────────────┬─────────────────┘
                                                  │ HTTP
                                                  ▼
                                     ┌──────────────────────────────┐
                                     │  Frontend (HTML + JS + CSS)  │
                                     │  See recording_viewer_       │
                                     │  frontend/ for reference     │
                                     └──────────────────────────────┘
```

The server starts with **no recording loaded**. The user either picks
an entry from the "Recent recordings" list (recordings produced by
chat sessions running in the same process, surfaced via
`/api/recordings`) or uploads a `.pb` file from their machine. There
is **no API for loading by arbitrary server-side filesystem path** —
the chat-side recorder and the viewer share a single cache directory
and that is the only on-disk surface the viewer reads from.

---

## Server

### HTTP endpoints

| Method & Path              | Purpose |
| -------------------------- | --- |
| `GET /`                    | Serves the combined SPA (Chat + Recordings tabs). |
| `GET /api/recordings`      | Lists recent recording files on disk so the Recordings tab can populate its "Recent recordings" list automatically. |
| `GET /api/agents`          | JSON payload with per-agent timelines (see schema below). |
| `GET /api/audio/<idx>.wav` | 24 kHz stereo WAV for agent `<idx>`. Left = client audio, right = server audio. Silence gaps preserved. Interrupted audio excluded. |
| `GET /api/frame/<idx>/<frame_idx>` | One client video frame from the per-agent sampled `frames[]` list (image bytes; `Content-Type` from the stored mime). Powers the **Replay popup** slideshow. The popup binary-searches `frame_ms[]` against `audio.currentTime` to figure out which index to request. |
| `GET /api/image/<idx>/<msg_idx>/<chunk_idx>` | Raw image bytes for one chunk of one message — i.e. `messages[msg_idx].image_chunks[chunk_idx]` for the given agent. Powers the **per-message image popup** opened from a pinned tooltip. |
| `POST /api/load`           | Body `{"name": "..."}`. Loads a recording that already lives in the cache directory (the `name` MUST be one of the entries returned by `/api/recordings`). Returns the `/api/agents` payload. |
| `POST /api/upload`         | Multipart `file=...`. Uploads + loads a recording. Returns the `/api/agents` payload. |
| `GET /api/download`        | `?name=<filename>` — raw recording bytes for one entry from the "Recent recordings" list. |

There is intentionally **no path-based load endpoint**: every
recording the viewer can open either originated in the same process's
cache directory (and is referenced by `name`) or was just uploaded
through `/api/upload`. This keeps the on-disk surface area small and
removes the possibility of a path traversal.

The recording on disk is always a length-prefixed serialized protobuf
stream in a `.pb` file (see `message_recorder.md`). No other format is
supported.

Both `/api/load` and `/api/upload` replace the in-memory recording
atomically under a lock. Offload parsing + WAV mixing to a worker
thread.

### Reconstruction pipeline

Transforms a flat log of recorded messages into one reconstructed track
per agent with `(start_time, end_time, interrupted)` annotations.

1. **Read** every record from the log. Each carries: `payload` (client
   or server message), `monotonic_nanos`, `agent_name`.

2. **Pick origin T0** = `monotonic_nanos` of the earliest setup message
   across all agents. All times become `t = monotonic_nanos - T0`.

3. **Group + sort** by `agent_name`, then by `monotonic_nanos`.

4. **Compute playback windows.** Each agent maintains two independent
   cursors (`last_end_client`, `last_end_server`). For each message at
   relative time `t`:
   - `start = max(t, last_end_<dir>)` — prevents same-direction overlap.
   - `end = start + duration` where duration is:
     - Audio: `decoded_pcm_bytes / (sample_rate_hz * bytes_per_sample) * 1e9`
       nanos. `bytes_per_sample = 2` (16-bit signed PCM, the Live API
       standard). See § Audio duration for the source of each input.
     - Everything else: instantaneous (`end = start`).
   - Update `last_end_<dir> = end`.

5. **Apply interrupt semantics.** When a server interrupt arrives at
   time `T`:
   - Schedule it at `start = end = T` (do NOT push through cursor).
   - Walk backwards, mark every prior server message with `start > T`
     as `interrupted = true`.
   - Rewind the server cursor to `T`. Client cursor is unchanged.

6. **Emit** one track per agent. Each message carries both
   `start_ms` / `end_ms` (reconstructed playback window) and `wire_ms`
   (raw observation time). The frontend reads these exact field names —
   do not rename them to `playback_start_ms` / `playback_end_ms` or the
   bars will not render.

> **Note on real-time arrivals.** When server audio arrives off the wire
> in real time (the common case), `t ≈ last_end_server`, so
> `start = max(t, last_end_server) ≈ wire_ms`. The cursor-push rule only
> diverges meaningfully from `wire_ms` for **bursted** arrivals (faster
> than real time), out-of-order arrivals, or after an interrupt rewind.
> The reconstruction's value is therefore primarily duration accuracy
> and interrupt handling — not start-time shifting. **Implementations
> MUST still compute `end = start + duration` for audio so the frontend
> renders duration bars rather than instant markers.** If your server
> audio renders as 2 px instant markers in playback mode, your
> `duration` is 0 — see § Per-message classification, § Audio duration,
> and § Diagnostics.

### Per-message classification

The server classifies each message for the timeline. Key fields:

- **`direction`**: `"client"` | `"server"`.
- **`kind`**: the inner oneof arm (`"setup"`, `"realtime_input"`,
  `"server_content"`, `"tool_call"`, etc.).
- **`modality`**: drives bar color. One of: `"text"`, `"audio"`,
  `"image"`, `"video"`, `"tool"`, `"setup"`, `"interrupt"`, `"control"`,
  `"turn_complete"`, `"generation_complete"`.
- **`detail`**: full proto-to-JSON dump with large `data` blobs replaced
  by `<base64 omitted, ~N bytes>` markers, and unresolvable Any fields
  stripped (surfaced as `_unresolved_any_types`).

#### Where audio bytes live

The classifier MUST inspect these proto paths to find audio payloads:

| Direction | Proto path | Notes |
| --- | --- | --- |
| Client | `realtimeInput.audio.{data, mimeType}` | Single audio chunk per message; MIME usually `audio/pcm;rate=16000`. |
| Client | `realtimeInput.mediaChunks[].{data, mimeType}` | Legacy/batched chunks; sum byte lengths and pick the rate from the first audio chunk. |
| Server | `serverContent.modelTurn.parts[].inlineData.{data, mimeType}` | One or more parts per message; sum byte lengths of parts whose `mimeType` starts with `audio/`. |

Recognized MIME prefixes: `audio/pcm`, `audio/x-pcm`, `audio/L16`,
`audio/wav` (treated as PCM for duration purposes; if a non-PCM
container appears, classify as `audio` but skip the duration formula
and emit `end_ms = start_ms` — the bar will render as instant, not as
a misleading wide bar).

#### Parsing the sample rate

MIME parameters look like `audio/pcm;rate=24000`. Parse as:

```
sample_rate_hz =
  int(mime.split(';')[1:].find('rate=').strip())   if present
  else 24000   (server audio default)
  else 16000   (client audio default)
```

If the rate parameter is malformed or zero, treat it as missing and
fall back to the direction-specific default. Never use `0` or a
negative number — that produces undefined duration.

#### Pseudocode

```
classify(msg, direction) -> {
    modality: str,
    kind: str,
    num_bytes: int,            # decoded PCM byte count, summed across parts
    sample_rate_hz: int,       # parsed from MIME, with default
    mime_types: list[str],
}:
  kind = active oneof arm of msg
  parts = audio-bearing parts at the proto paths above
  if parts is empty:
      modality = derive from kind (text/tool/setup/interrupt/...)
      return (modality, kind, 0, 0, [])
  num_bytes = sum(decoded_len(p.data) for p in parts)
  sample_rate_hz = parse_rate(parts[0].mimeType, direction)
  modality = "audio"
  return (modality, kind, num_bytes, sample_rate_hz, [p.mimeType for p in parts])
```

Capture `num_bytes` and `sample_rate_hz` here, **before** any
blob-stripping pass. The `<base64 omitted, ~N bytes>` marker the
`detail` field uses MUST be derived from this same `num_bytes`.

### Audio duration

Used by step 4 of the reconstruction pipeline:

```
duration_nanos = decoded_pcm_bytes / (sample_rate_hz * bytes_per_sample) * 1e9
```

- `bytes_per_sample = 2` (16-bit signed PCM, the Live API standard).
- `decoded_pcm_bytes` MUST be the byte length of the **decoded** PCM
  payload. If your parser exposes the field as a base64 string, decode
  it (or use the shortcut `len(b64) * 3 / 4` after stripping any `=`
  padding) before computing duration. **Using the base64-encoded
  length directly will overestimate duration by ~33%; using the length
  of the `<base64 omitted, ~N bytes>` placeholder string will produce
  near-zero duration.**
- `sample_rate_hz` MUST come from the per-message classification (see
  above), not be hard-coded — server and client audio commonly use
  different rates (24000 vs. 16000).
- **Invariant:** for every message classified as `modality == "audio"`,
  the emitted JSON MUST satisfy `end_ms > start_ms` (and equivalently
  `duration_ms > 0`). Implementations SHOULD assert this in tests.
  Violation indicates a classifier or duration bug, **not** a corner
  case — the frontend will silently render the bar as a 2 px instant
  marker, making playback mode visually identical to message mode.

### Audio assembly (`/api/audio/<idx>.wav`)

For one agent, build a 24 kHz stereo WAV:

1. Allocate two `int16` PCM buffers (left = client, right = server).
2. For each non-interrupted message: decode audio as `int16` PCM,
   resample linearly to 24 kHz, mix-add (saturating) into the target
   channel at `offset_samples = start_time_nanos * 24000 / 1e9`.
3. Pad both channels equally, interleave LRLR, emit as WAV.

---

## JSON payload shape (`/api/agents`)

```jsonc
{
  "input_path": "<recording filename in cache dir>  OR  <uploaded: name>",
  "agents": [
    {
      "index": 0,
      "agent_name": "alice",
      "total_ms": 128340.5,
      "messages": [
        {
          "index": 0,
          "direction": "client" | "server",
          "kind": "realtime_input" | "server_content" | ...,
          "modality": "audio" | "video" | "image" | "text" | ...,
          "interrupted": false,
          "start_ms": 1234.5,
          "end_ms": 1456.7,
          "duration_ms": 222.2,
          "wire_ms": 1230.1,
          "text_preview": "...",
          "audio_bytes": 9600,
          "audio_rate_hz": 24000,
          "mime_types": ["audio/pcm;rate=24000"],
          // 0 or more image chunks attached to this single message.
          // Referenced by the per-message image popup via
          //   GET /api/image/<agent_idx>/<msg_idx>/<chunk_index>
          "image_bytes": 0,
          "image_mime_types": [],
          "image_chunks": [
            { "chunk_index": 0, "mime": "image/jpeg", "byte_len": 18432 }
          ],
          "detail": { /* proto-to-JSON, large blobs stripped */ }
        }
      ],
      // Sampled client video frames used as the Replay popup's
      // slideshow source. Capped per the server constant
      // `_FRAME_LIMIT` (default 600). The popup binary-searches
      // `frame_ms[]` against `audio.currentTime` and fetches
      //   GET /api/frame/<agent_idx>/<index>
      // when the index changes.
      "frames": [
        { "index": 0, "frame_ms": 412.0,
          "mime": "image/jpeg", "byte_len": 18432 }
      ]
    }
  ]
}
```

---

## View modes (Playback vs. Message)

The viewer supports two view modes, toggled via a segmented control in
the header (global) and per-agent (override). Switching the global
toggle clears per-agent overrides so all agents follow the new setting.

| Mode | What is plotted | Bar shape |
| --- | --- | --- |
| **Playback** | Reconstructed `[start_ms, end_ms]` windows (cursor-pushed, duration-aware). Shows when audio will actually play. | Audio = wide duration bars. Everything else = thin instant markers. |
| **Message** | Raw `wire_ms` — exact send/receive time. Shows when each frame crossed the wire. | Every message = fixed-width bar (4 px) at `wire_ms`. Same-time messages get cluster band splitting. |

Key differences:

- **`total_ms`** is computed per mode: playback uses `max(end_ms)`,
  message uses `max(wire_ms)`.
- **Audio playback always uses playback-mode timestamps** regardless of
  view mode — the WAV is built from the reconstructed schedule.
- **Fisheye, cluster banding, tooltip, and interrupted overlay** all
  work identically in both modes. In message mode, all bars are treated
  as instant-like and go through the same `applyClusterBands()` path.


## Frontend key patterns

The reference code in `frontend/recordings/` implements all of
these. Read the code for implementation details — here is a summary of
the patterns the agent should preserve when adapting:

- **Two-row timeline** — CLIENT (top) and SERVER (bottom) per agent,
  with a sticky left gutter and a time ruler. Each row is `ROW_H = 48`
  px tall.
- **View mode toggle** — Global segmented control in the header plus a
  per-agent toggle in each agent header. Global switch clears per-agent
  overrides and re-renders all agents. Per-agent switch overrides the
  global for that agent only and re-renders just its timeline.
- **Duration bars vs. instant markers (playback mode)** — Audio renders
  as wide bars proportional to duration; everything else renders as thin
  2 px vertical lines.
- **Fixed-width bars (message mode)** — Every message renders as a
  fixed-width bar (`MESSAGE_BAR_W = 4` px) positioned at `wire_ms`.
  All bars go through `applyClusterBands()` for same-time stacking.
- **Paint order** — Duration bars appended longest-first so shorter bars
  stay on top. Instants have high `z-index`.
- **Lane packing for overlapped bars** — Overlapping bars are placed
  into the **minimum number of vertical lanes** such that no two bars
  in the same lane overlap on x. Implemented as interval-graph coloring
  (`packLanes()`): sort by `left`, then for each bar pick the
  lowest-indexed lane whose previously-assigned bars all end before the
  current bar's `left`. The lane count equals the **maximum number of
  bars overlapping at any single x**, not the size of the transitively
  connected group. This matters for chains: if A overlaps B and B
  overlaps C but A and C are disjoint, only **2 lanes** are used (A
  and C share lane 0, B takes lane 1) — not 3. Lane height is
  `ROW_H / numLanes`, clamped to `MIN_BAND_H = 4` px **only while the
  lanes still fit within `ROW_H`** (i.e., if `numLanes * MIN_BAND_H
  <= ROW_H`); otherwise the clamp is dropped so total lane height
  cannot exceed the row.
- **Zigzag lane ordering** — Within a packed component, lanes are
  placed top, bottom, then fill inward (`zigzagPermutation()`):
  `n=2 -> [0,1]`, `n=3 -> [0,2,1]`, `n=4 -> [0,3,1,2]`, etc. This
  spreads adjacent lanes to opposite sides of the row instead of
  always stacking downward, producing a visually balanced layout.
- **Connected components** — `findOverlapComponents()` first splits
  bars into x-disjoint components by sweep-line on
  `[left, left+width]`. Lane packing happens **per component**, so
  unrelated overlap clusters elsewhere in the row don't inflate each
  other's lane count.
- **Where this is applied** — `applyOverlapBands()` for playback-mode
  duration bars and `applyClusterBands()` for instants (which inflate
  each marker to width `CLUSTER_PX = 6` px so close-but-not-touching
  instants are also de-stacked) and all message-mode bars. Tagged
  with `data-band-*` attributes for the fisheye code. So e.g.
  interrupted server audio overlapping with newly generated server
  audio splits into separate lanes rather than stacking on top of
  each other.
- **Fisheye magnification** — macOS-dock-style: bars near the cursor
  grow wider via a non-uniform x-mapping (`fisheyeMap`), instant markers
  additionally `scaleX`. Cluster bands redistribute vertically near the
  cursor. Restores exactly on `mouseleave`.
- **Pinnable tooltip** — Hover shows a summary; click pins it with a
  close button, full proto detail `<pre>`, a "Play audio" button (when
  the message has audio), and a "View image" button (when the message
  has any `image_chunks[]`).
- **Per-chunk audio playback** — Uses Web Audio API
  (`BufferSource.start(0, offset, duration)`) on a lazily-decoded
  per-agent `AudioBuffer` cache. Always uses playback-mode timestamps.
- **Replay popup** (`frontend/recordings/replay.js`, `ReplayPopup`) —
  Per-agent "▶ Replay session" button opens an overlay with an
  `<audio controls>` playing the mixed stereo WAV alongside a
  slideshow of the client's sampled video frames. Frames are
  pre-fetched as object URLs (`URL.createObjectURL`), and a
  `requestAnimationFrame` loop binary-searches the per-agent
  `frame_ms[]` against `audio.currentTime * 1000` to decide which
  frame to show. Closing the popup cancels the rAF loop and revokes
  every object URL. Loading a new recording bumps a `loadVersion`
  cache-buster appended to every `/api/audio` and `/api/frame` URL.
- **Per-message image popup** (`frontend/recordings/replay.js`,
  `ImagePopup`) — Pinned tooltips on messages with `image_chunks[]`
  expose a "View image" button that opens an overlay containing one
  `<img>` per chunk, loaded from `/api/image/<agent>/<msg>/<chunk>`
  as an object URL. Useful for inspecting individual `realtime_input`
  video frames or server-emitted `inlineData` image parts.
- **Per-agent zoom** — `[- level% + Reset]` widget. `ZOOM_STEP = sqrt(2)`.
  Re-renders only the affected timeline and preserves the viewport center.
- **Interrupted bars** — Striped pattern + strike-through. Excluded from
  WAV and chunk playback.

---

## Reproducing in another stack

- **Server**: any HTTP framework is fine. The hard part is the
  reconstruction pipeline (cursor pushing + interrupt semantics) and
  WAV mixing.
- **Frontend**: adapt the `frontend/recordings/` reference modules
  and the recordings page in `frontend/index_combined.html`. CSS
  tokens are shared with the chat surface via `frontend/style.css`.

The contract between server and frontend is the JSON shape above plus
the WAV endpoint.
