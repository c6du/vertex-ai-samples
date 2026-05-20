# Live API Frontend Sample

A runnable reference frontend + Python backend for the **public Gemini Live API**.
The frontend uses [`@bufbuild/protobuf`](https://www.npmjs.com/package/@bufbuild/protobuf)
for typed wire access; the backend is a Tornado WebSocket proxy that does the
JSON ↔ binary-proto translation against the public Vertex Live API.

This sample is intentionally focused: **WebSocket backend only, no tools, no
MCP, no internal-only paths.** Use it as either a working reference (clone &
run) or a code-level reference (read the modules).

```
.
├── client_server_messages.proto      <- the Live API wire schema (in parent dir)
├── frontend_sample/                  <- this directory
│   ├── package.json                  <- TS deps (@bufbuild/protobuf, vite)
│   ├── buf.gen.yaml                  <- proto codegen config
│   ├── codegen.sh                    <- runs TS + Python codegen
│   ├── vite.config.ts                <- dev server + build
│   ├── tsconfig.json
│   ├── index.html
│   ├── style.css
│   ├── proto/
│   │   ├── client_server_messages.proto   (staged copy of the parent file)
│   │   └── recorded_frame.proto      <- portable recording wrapper
│   ├── src/                          <- TypeScript frontend
│   │   ├── main.ts                   entry point
│   │   ├── audio.ts                  mic capture + playback
│   │   ├── audio_worklet_processor.ts
│   │   ├── video.ts                  camera/screen capture
│   │   ├── websocket_client.ts       binary proto bridge
│   │   ├── settings_modal.ts         setup JSON builder
│   │   ├── config_loader.ts          /models loader
│   │   ├── project_info.ts           /project_info loader
│   │   ├── conversation_view.ts      chat bubbles
│   │   ├── status_view.ts            status indicator + toasts
│   │   ├── recording_viewer.ts       recordings page
│   │   ├── constants.ts
│   │   └── vite-env.d.ts
│   ├── gen/                          <- GENERATED TS bindings (commit if you want)
│   │   └── client_server_messages_pb.ts
│   └── server/
│       ├── server.py                 Tornado HTTP + WS server
│       ├── live_api_session.py       upstream WS proxy + session resumption
│       ├── recording.py              portable recording writer/reader
│       ├── models_config.yaml        models dropdown contents
│       ├── requirements.txt
│       └── gen/                      <- GENERATED Python bindings
│           ├── client_server_messages_pb2.py
│           └── recorded_frame_pb2.py
└── (recordings land in .recordings/ next to the server)
```

## What's in here vs. what's not

Included:
- Chat UI: sample audio/video/text, receive audio + transcription, handle interrupt.
- WebSocket proxy to the public Vertex Live API.
- Portable session recording format (length-prefixed binary proto).
- Recording viewer page.

Intentionally not included (deletions vs. internal app):
- `beyond`, `groot` backends (internal-only).
- MCP servers / tool execution. The model is not given any tools.
- Tool-call rendering on the frontend.
- The `recordio` (google3) recording format — replaced by a portable one.

## Wire model

| Channel | Direction | Encoding | Schema |
|---|---|---|---|
| HTTP `/project_info`, `/models`, `/start`, `/stop` | both | JSON | hand-rolled |
| HTTP `/api/recordings`, `/api/load`, `/api/upload` | both | JSON | hand-rolled |
| WebSocket `/ws` (browser ↔ this server) | both | **binary protobuf** | `ClientMessage` / `ServerMessage` |
| WebSocket to public Vertex Live API (this server ↔ Google) | both | **JSON protobuf** | `ClientMessage` / `ServerMessage` |

The server translates between binary and JSON in both directions, so the
browser never deserializes proto-JSON (avoids the int64-as-string and
camelCase/snake_case footguns on hot paths).

## Quick start

### Prerequisites
- Node.js 20+, npm 9+
- Python 3.11+
- For Vertex auth: `gcloud auth application-default login` once. Otherwise
  set `GEMINI_API_KEY` and use `--no-vertex`.

### Build & run

```bash
# 1) Install JS + Python deps
npm install
pip install -r server/requirements.txt   # or use a venv

# 2) Generate proto bindings (TS + Python)
npm run gen        # equivalent to: bash codegen.sh

# 3a) For development with auto-reload, run both:
npm run dev                  # vite on http://localhost:5173 (proxies /ws, /api etc.)
python3 server/server.py     # tornado on http://localhost:8008

# 3b) For a single-port production-style run, build then serve from python:
npm run build
python3 server/server.py     # serves dist/ + handles /ws + /api on :8008
```

Then open <http://localhost:8008> (or <http://localhost:5173> for dev mode).

### CLI flags

| Flag | Default | Notes |
|---|---|---|
| `--port` | `8008` | HTTP + WebSocket listen port. |
| `--use-vertex` / `--no-vertex` | `--use-vertex` | Vertex bearer-token auth vs. Google AI API-key auth. |
| `--api-key` | `$GEMINI_API_KEY` | Gemini Developer API key; required with `--no-vertex`. |
| `--project-id` | auto-resolved from ADC | Cloud project id (Vertex mode). |
| `--models-config` | `server/models_config.yaml` | YAML list of selectable models. |
| `--recordings-dir` | `../.recordings` | Where session recordings land. |
| `--frontend-dist` | `../dist` | Path to the vite build output. |

## Recording format

Each session is recorded to `<recordings_dir>/<unix_ts>_<session_id>.pb`. The
format is **portable, language-agnostic, and self-describing**:

```
[4-byte BE uint32 length][N-byte serialized FileHeader]      # optional
[4-byte BE uint32 length][N-byte serialized RecordedFrame]
[4-byte BE uint32 length][N-byte serialized RecordedFrame]
...
```

Each `RecordedFrame.payload` is a binary-serialized `ClientMessage` or
`ServerMessage`, tagged with `direction` and `timestamp_ms`. See
`proto/recorded_frame.proto` for the wrapper schema and `server/recording.py`
for the reader/writer. The Recordings page displays each frame's proto-JSON
projection.

## Interrupt handling

The audio/transcription playback is queue-based. When
`ServerMessage.serverContent.interrupted` is set, the queue is cleared
immediately so user input takes priority over any model audio still in flight.
See `src/audio.ts` (`PlaybackController.flush`) and `src/websocket_client.ts`
(handling of `sc.interrupted`).

## Session resumption

The server enables transparent session resumption (sets
`SessionResumptionConfig.transparent = true` in the setup) and maintains a
replay buffer of unconfirmed client messages. On disconnect (close codes
1000/1006 or `goAway`), it reconnects using the latest handle, replays the
buffer, and updates the handle from `sessionResumptionUpdate`. See
`server/live_api_session.py` and `../session_manager.md` for the full spec.

## Regenerating proto bindings

After editing `../client_server_messages.proto` or `proto/recorded_frame.proto`,
run:

```bash
npm run gen
```

This regenerates both the TypeScript (`gen/*_pb.ts`) and Python
(`server/gen/*_pb2.py`) bindings.

## See also

- [`AGENTS.md`](AGENTS.md) — conventions for future agents working in this folder.
- [`../client_server_messages.md`](../client_server_messages.md) — the
  authoritative Live API wire-protocol documentation.
- [`../session_manager.md`](../session_manager.md) — session resumption spec.
