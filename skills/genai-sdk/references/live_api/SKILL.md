---
name: liveapi-service
description: Generates a LiveAPI client service class in the user's chosen programming language. Use when the user wants to build, scaffold, or integrate a client that connects to the Gemini Enterprise LiveAPI websocket endpoint, handles session setup/resumption, bearer token refresh, and sending/receiving `ClientMessage`/`ServerMessage` protos.
---

# LiveAPI Service Skill

## References

Files in `references/`:

-   `client_server_messages.md` + `client_server_messages.proto` —
    Public LiveAPI proto definitions and the generated proto file.
-   `support_models.md` — Snapshot of the Gemini Enterprise Live API
    model lineup (model ids, regions, modality limits, deprecation
    dates). Re-fetch the upstream page noted at the top of that file
    before changing any model default to make sure the snapshot is
    still current.
-   `session_manager.md` — Session handling spec (setup, resumption,
    bearer token refresh).
-   `interactive_ui.md` — Spec + reference frontend for the test UI
    (Step 7). Also describes how the **Recordings** tab is folded into
    the same single-page app when the recordings feature is enabled.
-   `requirements.md` — **Cross-cutting requirements that apply at
    every step.** Re-read before declaring any step complete.
-   `message_recorder.md` + `recording_viewer.md` — **Optional, paired.**
    These two files describe a single combined feature
    ("**recordings**"): the async non-blocking recorder of bidirectional
    Live API traffic, and the in-app viewer that renders the produced
    recordings. They are always enabled or disabled together.
-   `frontend/` — **Reference frontend.** TypeScript ES-module
    playground with a single `index.html` entry. Talks to the
    backend bridge over `/start`, `/models`, `/project_info`, and
    `/ws`. The browser has **no proto dependency**: every WebSocket
    frame is a JSON text frame in proto3 JSON shape; the bridge owns
    the JSON ↔ proto translation. See
    `frontend/proto_api.ts` for the (tiny) wire-format module.
-   `backend_bridge.md` — **Backend contract.** Endpoint shapes,
    per-session state, error semantics, CLI flags, and per-language
    JSON ↔ proto helpers for the HTTP + WebSocket server that sits
    between the frontend and the user's `LiveSessionManagerWebsocket`.
    The kit does **not** ship a runnable reference server because
    that would lock the agent into one language; implement it in the
    language picked in Step 1. The bridge is the only component that
    touches the proto library.
-   `models_config.yaml` — Sample contents for the frontend model
    dropdown (served by `GET /models`).


## Class contract

The generated service class is initialized with:

| Field | Notes |
| --- | --- |
| `project_id` | Runtime input. |
| `location` | Runtime input. |
| `model_id` | Runtime input. |
| `config` | A `ClientMessage` whose `setup` field is populated. |
| `agent_name` (optional) | String identifier; **required** when a recorder is shared across multiple service instances. |
| `recorder` (optional) | A `MessageRecorder` instance. Only when the recorder feature was selected. |

The class exposes:

-   `[async] send_realtime_data(data: ClientMessage)` — send realtime
    input.
-   `[async] send_client_content(data: ClientMessage)` — send
    non-realtime context / turns.
-   `[async] receive() -> ServerMessage` — receive one server frame.

The class always authenticates against Gemini Enterprise: fetch and
refresh the bearer token (ADC) and attach it to every websocket
connection (including session resumption). API-key auth is not
supported.

## Workflow

Every step ends with a **Definition of done** — explicit criteria that
must be true before the agent moves on. The cross-cutting rules in
`references/requirements.md` apply throughout.

### Step 1 — Interview the user

Collect upfront, do not assume:

-   Destination folder for the generated project.
-   Target programming language.
-   Whether to enable the **recordings** feature (optional, single
    yes/no — **recommended: yes**). When enabled, the project gets
    BOTH the message recorder (per `message_recorder.md`) AND the
    in-app recording viewer (per `recording_viewer.md`) — they are not
    separately togglable. The agent SHOULD recommend enabling this
    feature because it makes debugging, replaying, and sharing
    sessions dramatically easier with minimal extra setup; only skip
    it if the user explicitly declines or has a strict reason (e.g.
    privacy / disk-write constraints).
-   The Google Cloud `project_id` to use for testing. The deployment
    always targets **Gemini Enterprise** (Vertex AI's
    `LlmBidiService.BidiGenerateContent` WebSocket endpoint), so no
    backend toggle is needed.
-   Which **Live API model** the user wants as the project default.
    Cross-check the choice against `references/support_models.md`
    (the snapshot of the upstream model lineup) — reject deprecated
    ids, warn on Preview ids, and verify the user's chosen region is
    in the model's "Supported regions" list. **If the id the agent
    is about to recommend is not listed in the "Available models —
    quick reference" table at the top of `support_models.md`, STOP
    and re-fetch the upstream page referenced in that file — do not
    fall back to ids from training data, and do not invent ids.**

**Definition of done:** every choice above is captured in the agent's
plan; no implicit defaults remain.

### Step 2 — Copy references

Copy the the whole references folder to the destination. 

**Definition of done:** All files and folders are copied to the destination

### Step 3 — Sync the proto

Reconcile `client_server_messages.md` against the public source
documents it cites. If there is drift:

1.  Update the markdown in the copied folder.
2.  Update `client_server_messages.proto` to match.
3.  Regenerate the language-specific bindings the service class will
    import.

**Definition of done:** markdown, `.proto`, and generated bindings all
agree, and the bindings compile in the target language.

### Step 4 — Implement the LiveAPI service class

Implement per the **Class contract** section, importing the generated
proto. If the language requires an isolated environment (Python, Node,
etc.), provision it inside the destination folder and provide a
one-line activation script. Do **not** modify the user's system
environment.

If the recordings feature was selected, wire the recorder hook into
both send paths and the receive path per the recorder integration
rules in `references/requirements.md`.

**Definition of done:** the class compiles / imports, exposes all
methods listed in the contract, accepts the optional `recorder` /
`agent_name` arguments, and raises a clear error when required
credentials are missing.

### Step 5 — Smoke check

Write a minimal end-to-end script that opens a session, sends one text
turn, receives one response, and exits cleanly.

-   Reads credentials / project_id / location / model from environment
    variables or CLI flags so it is runnable without code edits.
-   Prints a clear pass / fail line and exits non-zero on failure.
-   No baked-in secrets.

**Definition of done:** the script runs to completion against a real
endpoint, prints `PASS`, and exits 0.

### Step 6 — Backend bridge

Implement the HTTP + WebSocket server specified in
`references/backend_bridge.md` in the same language as the service
class (Step 4). It exposes `/start`, `/ws`, `/models`,
`/project_info`, and (when recordings are enabled) the recording and
viewer endpoints — all on one port, same origin as the frontend.

The bridge wraps the `LiveSessionManagerWebsocket` built in Step 4 and
(if recordings were selected) the `MessageRecorder` from Step 5. It
does NOT speak to the Live API directly; it only translates HTTP/WS
frames to/from the session manager.

If the recordings feature was selected, the recording-viewer HTTP
endpoints (per `recording_viewer.md`) MUST be served by the **same
process on the same port** as the chat backend — do not introduce a
second service.

**Definition of done:** backend starts on the configured port, the
WebSocket endpoint accepts a connection, and (if recordings were
selected) the viewer endpoints (`/api/recordings`, `/api/agents`,
`/api/audio/<idx>.wav`, `/api/frame/<idx>/<frame_idx>`,
`/api/image/<idx>/<msg>/<chunk>`, `/api/load` for cache-directory
entries, `/api/upload` for user-supplied files) respond on the same
port. The frame / image endpoints back the Replay popup and the
per-message image popup. Note: the viewer intentionally does NOT
expose a "load by arbitrary filesystem path" endpoint — recordings
are reachable only via the in-process cache directory list or
upload.

### Step 7 — Frontend UI

Adapt `interactive_ui.md`'s reference frontend (DO NOT generate from
scratch). The UI MUST allow the user to:

-   Start a new connection / close the current connection.
-   Select the model.
-   Select input sources (audio and / or video — camera or screenshot)
    and stream them to the model.
-   Send text messages.
-   Hear model audio and see model + user transcription / conversation
    history.

Start from `references/frontend/index.html` (single entry point) and
the sibling `.ts` modules:

-   Recordings **disabled** → strip the sidebar (or hide the
    Recordings tab) and drop `recording_viewer.ts` from the build.
-   Recordings **enabled** → keep the sidebar and render the chat
    playground and recording viewer as **two tabs of the same SPA**
    (sidebar entries: "Chat" and "Recordings"), served from the same
    origin. Do NOT open the viewer in a separate browser tab or as a
    separate service. When a chat session ends, surface a transient
    toast pointing the user to the Recordings tab (no save/discard
    modal).

The frontend has no proto codegen step — every WebSocket frame is a
JSON text frame in proto3 JSON shape (camelCase fields, base64
`bytes`, enum-by-name, int64-as-string). See
`references/client_server_messages.md` § *Browser ↔ backend bridge:
same JSON shape* for the encoding rules and `frontend/proto_api.ts`
for the helpers. If a project specifically needs binary protobuf on
the browser leg, swap the bodies of `proto_api.ts` per the comment
at the top of that file.

**Definition of done:** the page renders all required controls;
clicking through the UI exercises every required interaction listed
above; when recordings are enabled, the sidebar has both a Chat tab
and a Recordings tab and switching between them does not reload the
page.

### Step 8 — Verify

Run the verification protocol in `references/requirements.md` (smoke
checks + end-to-end interactions for every produced service).

**Definition of done:** every applicable verification passed; failures
have been fixed and re-verified, not merely reported.

### Step 9 — Documentation

Produce in the destination folder:

-   `README.md` — orientation + quick start: install, run the smoke
    check from Step 5, programmatic usage of the service class with
    full examples of building a `ClientMessage` for each modality and
    consuming `ServerMessage`s.
-   `how_to_test_with_ui.md` — how to start the test UI service, the
    URL to open, and how to interact with the model through it.
-   `how_to_use_recordings.md` — only if the recordings feature was
    enabled. Covers how recordings are produced automatically by the
    chat session, how to switch to the Recordings tab in the same
    page, loading a recording (recent list or upload — no path
    input), switching between Playback / Message modes (global +
    per-agent),
    and inspecting / playing back individual messages. Defer to
    `recording_viewer.md` for what each mode shows.

**Definition of done:** all expected docs exist, the commands they
print actually run, and the URLs they cite resolve.
