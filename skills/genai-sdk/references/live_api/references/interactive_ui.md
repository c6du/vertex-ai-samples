---
name: live-api-interactive-ui
description: >-
  Reference implementation for a single-page browser playground for the
  Gemini Live API over WebSockets. The agent should adapt the provided
  reference frontend rather than building from scratch.
---

# Live API Interactive UI

The reference frontend lives at `references/frontend/`. It is a
TypeScript ES-module app with a **single** entry point (`index.html`)
that talks to the companion backend bridge (specified in
`backend_bridge.md` — the agent implements it in the user's chosen
language) over HTTP (`/start`, `/models`, `/project_info`, optional
`/recording/...`) and a JSON-text WebSocket (`/ws?session_id=<uuid>`).

YOU SHOULD REUSE THE EXISTING REFERENCE, DO NOT IMPLEMENT FROM SCRATCH.

```
frontend/
├── index.html                  single entry — chat playground
├── style.css                   styles
├── script.ts                   bootstrap / DOM wiring
├── settings_modal.ts           settings form + setup-JSON builder
├── config_loader.ts            /models loader
├── project_info.ts             /project_info loader (project_id only)
├── proto_api.ts                JSON wire-format helpers (no proto deps)
├── websocket_client.ts         /ws bridge (+ shared EventQueue)
├── audio.ts                    PlaybackController + MicCaptureController
├── audio_worklet_processor.ts  PCM16 capture worklet
├── video.ts                    camera / screen frame capture
├── conversation_view.ts        chat-bubble rendering
├── status_view.ts              status indicator + transient toasts
├── constants.ts                audio/video constants + endpoint computation
└── recording_viewer.ts         (optional) in-app recordings viewer
```

The agent should adapt this to the target project's build system and
module format. The browser has **no proto dependency**: every wire
frame is a JSON text frame in the proto3 JSON shape of
`BidiGenerateContent{Client,Server}Message`. The backend bridge owns
the JSON ↔ proto translation (see `backend_bridge.md`). Do not
generate the UI from scratch — adapt the reference.

## Backend scope (websocket only)

The reference targets ONE backend: the public Vertex AI Live API
WebSocket (`wss://[<location>-]aiplatform.googleapis.com/ws/.../
BidiGenerateContent`).

## Recordings (when enabled)

If the user picked the recordings feature in `SKILL.md` Step 1, the
sidebar in `index.html` switches between a Chat tab and a Recordings tab
that talks to the viewer endpoints described in `recording_viewer.md`.
The Chat tab also shows a transient "Session ended" toast pointing the
user at the Recordings tab when a session closes (no save/discard
modal).

If the user did NOT pick recordings, strip the sidebar (or hide the
Recordings tab), drop `recording_viewer.ts` from the build, and remove
the recorder wiring from the backend per `references/README.md`.

## Computed endpoint URL (Environment + Location)

The user does **not** type the WebSocket endpoint URL directly. They
pick an **Environment** and a **Location**; the UI computes the
endpoint and displays it as **read-only**.

```
HOST_SUFFIX = {
  prod: "aiplatform.googleapis.com",
}

host = HOST_SUFFIX[environment]                          # if location == "global"
host = f"{location}-{HOST_SUFFIX[environment]}"          # otherwise

endpoint = f"wss://{host}/ws/google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent"
```

The endpoint updates **live** as the user changes Environment or
Location and is mirrored into the sidebar config summary.

## Model name reconstruction

The frontend collects the **short** model ID (e.g.
`gemini-live-2.5-flash-native-audio`) from the user. Before sending it
on the wire, the frontend prepends the project / location prefix so the
final `setup.model` is
`projects/<project_id>/locations/<location>/publishers/google/models/<short_id>`.

- `project_id` comes from `GET /project_info` (the backend's
  `--project_id` flag).
- `location` comes from the WebSocket Location selector.
- `<short_id>` is the value from the model dropdown / `models_config.yaml`.

If a YAML `value:` already starts with `projects/` or `publishers/`, the
frontend forwards it as-is.

## What to adapt

When integrating the reference into a new project, the agent should:

1. **Confirm the wire format choice.** The reference ships with
   **JSON text frames** on the browser ↔ bridge leg (no proto
   library in the browser). If the project instead wants binary
   protobuf in the browser (e.g. to avoid the ~33% base64 overhead
   on audio), swap the bodies of `proto_api.ts` for a binary
   encode/decode, flip the WebSocket to binary in
   `websocket_client.ts`, and update the bridge accordingly. The
   default is JSON because it removes a whole codegen step in the
   browser and is what almost every adapter actually wants.

2. **Update Environment / Location defaults** in `constants.ts`
   (`WEBSOCKET_DEFAULT_ENV`, `WEBSOCKET_DEFAULT_LOCATION`,
   `WEBSOCKET_HOST_SUFFIX_BY_ENV`, `WEBSOCKET_LOCATIONS`) to match
   the target deployment.

3. **Wire the build / bundler** of the target project around the
   `.ts` sources. The reference is written as plain TS modules so any
   modern bundler (Vite, esbuild, webpack, parcel, etc.) can compile
   it without changes.

4. **Confirm the companion HTTP server** exposes these endpoints on
   the same origin:

    | Method | Path | Purpose |
    | --- | --- | --- |
    | `POST` | `/start` | Body: `{session_id, endpoint_url, setup}`. `setup` is `{"setup": <BidiGenerateContentSetup>}`. Returns `{"status": "started"}`. |
    | `WS` | `/ws?session_id=<UUID>` | Bidirectional bridge. **JSON text frames** in both directions, shaped as proto3 JSON encoding of `BidiGenerateContentClientMessage` (browser → bridge) and `BidiGenerateContentServerMessage` (bridge → browser). Out-of-band JSON text frames `{"type": "tool_response", ...}` carry bridge-executed tool responses. |
    | `GET` | `/models` | Returns `{"models": [{"name", "value"}, ...]}`. |
    | `GET` | `/project_info` | Returns `{"project_id": "..."}`. |
    | `GET` | `/recording/download?session_id=...` | Streams the session recording (optional). |
    | `POST` | `/recording/discard?session_id=...` | Deletes the recording file (optional). |

5. **Remove the recording UI / toast** if the recordings feature was
   not selected.

## File-by-file: what the coding agent should modify

Use this table as a checklist while adapting the reference. Files
marked **leave alone** are normally adapted only by changing them
through the touch points listed elsewhere in this document — editing
them in place is a smell.

| File | Edit posture | Things to look for / change |
| --- | --- | --- |
| `index.html` | **Edit freely.** | Re-skin to match the host product's design. Add / remove form controls in the settings modal to match every field on `BidiGenerateContentSetup` (see § *Settings page coverage* — this is mandatory). If you add a control, give it a stable `id` and wire it in `script.ts` + `settings_modal.ts`. Drop the entire sidebar + Recordings tab if recordings are disabled. Do NOT delete the `id`s that `script.ts` calls `getElementById` on without also updating `script.ts`. |
| `style.css` | **Edit freely.** | Re-theme. Keep the class names referenced by `settings_modal.ts`, `conversation_view.ts`, `status_view.ts`, and `recording_viewer.ts` (e.g. `is-active`, `backend-only`, `session-toast`, `mcp-row-*`, `kv-*`) or rename them in both places. |
| `constants.ts` | **Edit.** | Update `WEBSOCKET_HOST_SUFFIX_BY_ENV`, `WEBSOCKET_LOCATIONS`, `WEBSOCKET_DEFAULT_ENV`, `WEBSOCKET_DEFAULT_LOCATION` to the regions the project actually deploys to. Adjust `AUDIO_*` / `VIDEO_*` constants only if the upstream model changes its accepted formats — most projects leave these alone. |
| `proto_api.ts` | **Edit only if changing the wire format.** | The default JSON path needs no edits. Edit the body of `buildRealtimeInputMessage` / `parseServerMessage` only if swapping to binary protobuf in the browser (see Step 1 above), or if `BidiGenerateContentRealtimeInput` gains a new arm the project needs to send. Field names sent here must match the proto3 JSON shape exactly. |
| `websocket_client.ts` | **Edit only for new server-message arms.** | The default already handles `serverContent` (`modelTurn`, transcriptions, `interrupted`, `turnComplete`), `toolCall`, and `toolCallCancellation`. Add a new branch in `handleServerMessage` if the project consumes additional `BidiGenerateContentServerMessage` fields (e.g. `usageMetadata`, `goAway`, `sessionResumptionUpdate`). New out-of-band bridge events go in `handleBridgeEvent`. Do NOT change the WebSocket framing unless you are coordinating with the bridge. |
| `settings_modal.ts` | **Edit aggressively.** | This is where § *Settings page coverage* is enforced. For every proto field you add a UI control for, also add: (a) the element ref on `SettingsModalElements`, (b) the JSON assignment inside `buildInnerSetup()` (or `buildSetupJson()` for outer-envelope fields). Pay attention to proto3 JSON encoding: `bytes` → base64, `int64` → JSON string, enums → string names, field names → camelCase. |
| `script.ts` | **Edit.** | Mirror every change you make in `index.html` and `settings_modal.ts`: register each new `id` via `inp()` / `sel()` / `txta()` and forward it through the `SettingsModalElements` literal. If recordings are disabled, also delete the `initRecordingViewer()` and sidebar wiring at the bottom. |
| `config_loader.ts` | **Leave alone.** | Only edit if `/models` changes shape on the bridge side (e.g. additional metadata per entry). |
| `project_info.ts` | **Leave alone** unless `/project_info` returns more fields. | If the project surfaces additional info (e.g. region), extend `ProjectInfo` here and read it from `settings_modal.ts` / `script.ts`. |
| `conversation_view.ts` | **Edit for new bubble types.** | Add a new render method if the project emits something the current `transcription` / `toolCall` / `toolResponse` / `toolCallCancellation` taxonomy doesn't cover (e.g. inline images in model turns). |
| `status_view.ts` | **Edit freely.** | Cosmetic — status text, toast styling, transient-message timing. |
| `audio.ts` | **Leave alone** in the default JSON path. | Edit only if the project changes the input sample rate / format. If you do, update both `pcm-recorder-worklet-processor` constants and `MicCaptureController.start()`'s `getUserMedia` constraints, and confirm the model accepts the new MIME. |
| `audio_worklet_processor.ts` | **Leave alone.** | Self-contained PCM16 capture worklet. Edit only if `AUDIO_BUFFER_SIZE` semantics change. |
| `video.ts` | **Edit for capture changes.** | Adjust `VIDEO_FRAME_INTERVAL_MS` / `VIDEO_MAX_DIMENSION` if the host product needs a different frame cadence or resolution. Add new sources (screen, file) by extending `populateMediaDevices` + the source-selection branch. |
| `recording_viewer.ts` | **Delete** if recordings are disabled, **edit** if the viewer API shape changes. | Otherwise leave alone. |

### Mandatory coordination points

These cross-file invariants are easy to break and not caught by the
compiler. Audit them before sending the change for review.

1. **DOM id ↔ TS lookup parity.** Every `id="..."` referenced in
   `index.html` must be looked up via `getElementById` in `script.ts`
   if the rest of the code depends on it, and every `byId('...')` /
   `sel('...')` / `inp('...')` / `txta('...')` / `btn('...')` call in
   `script.ts` must point at an existing `id` in `index.html`. A
   stale lookup returns `null` and the page silently breaks on first
   interaction.
2. **Settings field ↔ proto field parity.** Every UI control added
   in `index.html` must be (a) listed in `SettingsModalElements`,
   (b) read in `script.ts`'s element literal, (c) consumed in
   `settings_modal.ts`'s `buildInnerSetup()` / `buildSetupJson()`,
   and (d) named with the exact camelCase the proto expects.
   Missing any of these silently drops the field.
3. **Wire-format symmetry.** If you flip `proto_api.ts` and
   `websocket_client.ts` to binary, the backend bridge must flip
   too. Mixed framing produces a WebSocket that opens, sends one
   frame, and dies with no useful console output.
4. **AudioWorklet module URL.** `MicCaptureController.start()` calls
   `audioWorklet.addModule('audio_worklet_bundle.js')`. If your
   bundler emits the worklet under a different filename (e.g. with a
   hash), update that string or load it via
   `new URL('./audio_worklet_processor.ts', import.meta.url)`.
5. **Removing the Recordings tab.** If recordings are disabled,
   delete the Recordings tab in `index.html`, remove
   `recording_viewer.ts` from the build, drop the `initRecordingViewer()`
   import + call in `script.ts`, and remove `showRecordingToast`'s
   "view on the Recordings page" hint text. Leaving any of these in
   produces dead UI that points at a 404.

## Settings page coverage (IMPORTANT)

The settings page MUST expose a control for **every field** defined on
the `BidiGenerateContentSetup` proto message (and on every message
transitively reachable from it). The reference `settings_modal.ts` is
a starting point, not an exhaustive surface — the proto is the source
of truth and may have evolved since this reference was written.

Before shipping, the agent MUST:

1. **Read the proto.** Open `references/client_server_messages.proto`
   and walk the full `BidiGenerateContentSetup` definition, including
   every nested / referenced message (`GenerationConfig`,
   `SpeechConfig`, `VoiceConfig`, `RealtimeInputConfig`,
   `AutomaticActivityDetection`, `AudioTranscriptionConfig`,
   `ContextWindowCompressionConfig`, `SessionResumptionConfig`,
   `ProactivityConfig`, `Tool` / function-declaration fields, etc.).
   Do not rely on the field list in this skill — it is illustrative
   and may be incomplete.
2. **Inventory every field.** For each field at every nesting level,
   decide on the right UI control (text input, number input,
   checkbox, `<select>` for enums, repeated/list editor for `repeated`
   fields, nested `<details>` for sub-messages, etc.). `oneof` arms
   should be surfaced as a single picker that toggles which sub-form
   is visible.
3. **Wire each control into `buildSetupJson()`.** The output JSON
   must use proto3 JSON encoding (camelCase field names mapping to
   the proto's snake_case names; enum values as their string names
   unless the proto specifies otherwise). The server parses the JSON
   directly with the proto library, so any name mismatch silently
   drops the field.
4. **Diff against the reference.**
   -   Add UI for fields the proto has but the reference doesn't.
   -   Remove UI for fields the proto no longer defines.
   -   Update every enum `<option>` list against the current proto
       enum values.
5. **Verify round-trip.** After building, sanity-check that a setup
   JSON containing one non-default value for every leaf field
   parses cleanly into the proto on the server side and the parsed
   message round-trips back to the same JSON.

If a field is intentionally omitted from the UI (e.g. it's
deployment-internal and should never be user-controlled), leave an
explicit `// SKIPPED: <field> — <reason>` comment in
`settings_modal.ts` so the omission is auditable. Silent gaps are not
acceptable.

## Key architecture patterns (preserve when adapting)

- **Single playback FIFO queue** (`EventQueue` in `websocket_client.ts`)
  — audio chunks, transcription events, and tool-call events share one
  queue to preserve arrival order.
- **Drain loop with backpressure** — a ~10 ms timer peeks at the queue
  head; audio chunks are held if the playback lookahead exceeds ~500 ms.
- **Interrupt handling** — on `serverContent.interrupted` the queue is
  flushed immediately.
- **Streaming transcription bubbles** — a `currentBubbles` map keyed by
  role tracks the active bubble; close on `finished` / `turnComplete`.
- **PCM scheduling** — 24 kHz / 16-bit / mono model audio is converted
  to Float32 and scheduled back-to-back via
  `AudioBufferSourceNode.start(nextBufferStartTime)` for gap-free
  playback.
- **Audio capture** — 16 kHz / mono microphone input captured via an
  AudioWorklet, converted to PCM16, base64-encoded (see
  `bytesToBase64` in `audio.ts`), and wrapped in
  `realtimeInput.audio.data` per proto3 JSON `bytes` encoding.
- **Video frame capture** — camera or screen frames at 1 fps, drawn to a
  hidden canvas (max 768 px), JPEG-encoded, sent as `realtimeInput.video`.
