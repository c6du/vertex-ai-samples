---
name: live-api-backend-bridge
description: >-
  Contract for the HTTP + WebSocket server that sits between the reference
  browser frontend and the user's LiveAPI service class. Implement in the
  language the user picked in SKILL.md Step 1.
---

# Backend bridge (HTTP + WebSocket)

The reference frontend (`references/frontend/`) is language-agnostic —
it only speaks HTTP + WebSocket to a server on the **same origin**.
This file specifies that server. The agent should implement it in the
language chosen for the service class (Step 4) so the same proto
bindings, auth, and recorder can be reused.

There is intentionally no reference `server.py` in the kit. Any
runnable reference would lock the agent into Python.

## Wire format (browser leg)

**The browser ↔ bridge leg uses JSON text frames** shaped as proto3
JSON encoding of the LiveAPI client / server messages (see
`references/client_server_messages.md`). The reference frontend never
emits or expects a binary WebSocket frame on this leg.

The bridge's only obligation is to translate between (a) the JSON it
exchanges with the browser and (b) whatever shape its
`LiveSessionManagerWebsocket` expects (typically a parsed proto
object). Per-language pointers:

| Language | JSON ↔ proto helpers |
| --- | --- |
| Python | `google.protobuf.json_format.Parse` / `MessageToJson` (set `preserving_proto_field_name=False` to get camelCase). |
| Go | `google.golang.org/protobuf/encoding/protojson` — `Unmarshal` / `Marshal`. Defaults already produce camelCase. |
| Java / Kotlin | `com.google.protobuf.util.JsonFormat.parser().merge(...)` / `JsonFormat.printer().print(...)`. |
| C# / .NET | `Google.Protobuf.JsonParser.Default.Parse<T>(json)` / `JsonFormatter.Default.Format(msg)`. |
| TypeScript / Node | Prefer `@bufbuild/protobuf` (`fromJsonString` / `toJsonString`) or `ts-proto` (`fromJSON` / `toJSON`). Avoid `protobufjs`'s default JSON helpers — they do **not** strictly follow proto3 JSON encoding (camelCase, base64 bytes, enum-by-name). |
| Rust | `prost` for binary, `pbjson` + `pbjson-build` for proto3 JSON. |
| Ruby | `Google::Protobuf.encode_json` / `decode_json`. |

Whatever helper you pick, verify it: parse a JSON `setup` payload
that exercises a nested field, serialize the parsed proto back to
JSON, and compare to the input. A silent field drop on round-trip is
the most common bridge bug.

The upstream Vertex AI WebSocket also speaks JSON text frames in the
same proto3 JSON shape (see
`references/client_server_messages.md` § *Connection*), so a bridge
that wants to may forward frames between browser and upstream nearly
verbatim — though parsing each frame into a proto on the bridge
remains valuable because it (a) catches malformed frames early and
(b) lets the recorder see fully-typed messages.

## Process model

A single process listens on one port and serves:

- **Static files** for the frontend (`index.html`, the bundled JS, and
  `style.css`).
- **HTTP JSON endpoints** for configuration and lifecycle.
- **One WebSocket route** that bridges the browser to a per-session
  `LiveSessionManagerWebsocket` instance (per `session_manager.md`).
- *(Optional, only when recordings are enabled)* the recording
  endpoints described in `recording_viewer.md`, mounted on the same
  app and port.

Sessions are keyed by a UUID the **browser** generates and sends on
both `POST /start` and `GET /ws`. The server holds an in-memory map
`session_id -> SessionState`.

## Endpoints

### `POST /start`

Creates a session manager, calls its `__aenter__` (or the language
equivalent), and stores it under `session_id`. Returns once the
upstream connection is established.

Request body (JSON):

```json
{
  "session_id": "<uuid>",
  "endpoint_url": "wss://<location>-aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent",
  "setup": { "setup": { /* BidiGenerateContentSetup */ } }
}
```

- `setup` is the wire-shape `BidiGenerateContentClientMessage`
  payload (`{"setup": {...}}`) ready to be parsed by the proto
  library.
- `endpoint_url` is computed by the frontend from Environment +
  Location (see `interactive_ui.md`); the server forwards it as-is to
  the session manager.

Behaviour:

1. Validate `session_id`, `endpoint_url`, `setup` are present. 400
   on missing.
2. If a session already exists under this id, tear it down first
   (close the existing WebSocket handler with code `1012`, await
   `__aexit__`, close the recorder, delete the partial recording).
3. Parse `setup` into a `BidiGenerateContentClientMessage` proto. 400
   on parse failure.
4. *(Recordings)* allocate a recording file path and start the
   recorder.
5. Construct the session manager and await its `__aenter__`. If it
   fails, close the recorder, delete the partial recording, and
   re-raise as 500.
6. Store the new state. Respond `{"status": "started", "session_id": "..."}`.

### `GET /ws?session_id=<uuid>`

WebSocket upgrade. Rejects (close code `1008`) if `session_id` is
unknown or already has a connected handler.

**Wire format on this leg is JSON text frames** in the proto3 JSON
shape of `BidiGenerateContentClientMessage` /
`BidiGenerateContentServerMessage` (see
`references/client_server_messages.md` § *Browser ↔ backend bridge:
same JSON shape*). The reference frontend `websocket_client.ts` sends
and receives **only text frames**; the bridge must not send binary on
this leg. (If a downstream project needs binary on this leg, flip
both ends — see the note at the top of `frontend/proto_api.ts`.)

Once open the server runs two loops concurrently for the lifetime of
the socket:

- **Browser → upstream.** Each text frame is a JSON-encoded
  `BidiGenerateContentClientMessage`. Parse it (e.g. Python
  `json_format.Parse`, Go `protojson.Unmarshal`, Java
  `JsonFormat.parser().merge`, C# `JsonParser.Default.Parse`) and
  forward via `session_manager.send(message)`. On parse / send
  failure, close the socket with `1011`.
- **Upstream → browser.** Iterate `session_manager.receive()`; for
  each `BidiGenerateContentServerMessage`, serialize it to JSON (e.g.
  `MessageToJson`, `protojson.Marshal`, `JsonFormat.printer()`,
  `JsonFormatter.Default.Format`) using **proto3 JSON encoding rules
  with `preserving_proto_field_name=false`** so output field names
  are camelCase. Send as a text frame. Stop if the socket has closed.

Out-of-band JSON text frames (e.g.
`{"type": "tool_response", "name": "...", "id": "...", "response": ...}`)
MAY also be sent by the bridge when it executes a local tool — the
frontend distinguishes them from real server messages by the presence
of a `type` field.

On socket close, cancel both loops, await `session_manager.__aexit__`,
flush + close the recorder, move the recording file into a
`pending_recordings` map keyed by `session_id`, and remove the entry
from `sessions`.

### `GET /models`

Reads `models_config.yaml` (see the file's comments for shape) and
returns:

```json
{"models": [{"name": "Display label", "value": "bare-model-id"}, ...]}
```

Re-read the YAML on every request so the frontend's Refresh button
picks up edits without restarting.

### `GET /project_info`

Returns the GCP project id the server was launched with (so the
frontend can build the fully-qualified model resource name):

```json
{"project_id": "<value of --project_id>"}
```

Do **not** try to resolve a project number here — the public reference
does not need it, and any internal lookup binary would leak Google-only
plumbing into the user's project.

### `GET /recording/download?session_id=...&filename=...` *(optional)*

Streams the recordio (or equivalent) file for the session as
`application/octet-stream` with `Content-Disposition: attachment`.
Sanitize `filename` (strip path components, `\r`, `\n`, `"`, `\`).
Stream in chunks (e.g. 64 KB) so large recordings don't load into RAM.
Returns 404 if no recording exists for that `session_id`.

### `POST /recording/discard?session_id=...` *(optional)*

Idempotently deletes the recording file for the session. Returns
`{"status": "discarded", "session_id": "..."}`.

### Recording viewer endpoints *(optional)*

When the recordings feature is enabled, also serve the routes listed
in `recording_viewer.md` (`/api/recordings`, `/api/agents`,
`/api/audio/<idx>.wav`, `/api/frame/<idx>/<frame_idx>`, `/api/load`,
`/api/upload`, `/api/download`) from the **same app and port**. They
are not a separate service.

## Per-session state

Minimal shape the server must keep around (one entry per
`session_id`):

| Field | Notes |
| ----- | ----- |
| `session_manager` | The `LiveSessionManagerWebsocket` instance. |
| `recorder` | The optional `MessageRecorder` instance. |
| `recording_path` | Where the recorder is writing. Needed to expose / delete the file after close. |
| `ws_handler` | Currently-connected browser handler, or null. |
| `reader_task` | Handle to the upstream→browser loop so it can be cancelled on close. |

After a session closes (browser disconnect), keep `recording_path` in
a separate `pending_recordings: dict[session_id -> path]` so
`/recording/download` and `/recording/discard` still work.

## CLI / configuration

The server should accept (at minimum):

| Flag | Default | Notes |
| ---- | ------- | ----- |
| `--port` | `8008` | HTTP / WebSocket listen port. |
| `--project_id` | *(required)* | GCP project id surfaced via `/project_info`. The server is not responsible for ADC fetch — the session manager handles bearer tokens (per `session_manager.md`). |
| `--agent_name` | `Gemini Assistant` | Display name written into recorded conversations (only used when recordings are enabled). |

Print the bound URL to stdout on startup (e.g.
`Server started on http://<hostname>:<port>`).

## Static file root

Serve the frontend from `references/frontend/` (or wherever the agent
relocates / bundles it). The static handler must be registered LAST
so it doesn't shadow the API routes.

## Error semantics

- 400 on malformed request body, missing required fields, or
  unparseable `setup` JSON.
- 404 when a `session_id` has no recording or no live session for the
  endpoint that needs one.
- 500 on internal failures (proto build, session-manager init, file
  IO). Always log a stack trace server-side; never leak it to the
  client beyond a short message.
- WebSocket close codes: `1008` for bad/duplicate session id, `1011`
  for upstream send/receive failure, `1012` when an existing session
  is torn down by a new `/start` with the same id.

## What the agent must NOT add

- A separate "viewer" service or port. Recordings live on the same
  origin or not at all.
- A "load by filesystem path" endpoint that takes a user-supplied
  path. Recordings are reachable only via the cache directory list
  (`/api/recordings`) or upload (`/api/upload`).
- Any backend other than the public Vertex AI WebSocket. The
  reference frontend exposes no UI for picking a backend.
