# Live API reference kit

Browser playground + specs for the public Vertex AI **Live API**
WebSocket (`LlmBidiService.BidiGenerateContent`). The agent adapts
these files to the language and project layout the user picked in
`SKILL.md` Step 1.

```
references/
├── client_server_messages.{md,proto}   Public wire-format proto + spec
├── interactive_ui.md                   Frontend contract / what to adapt
├── backend_bridge.md                   Backend HTTP+WS server contract
├── session_manager.md                  LiveAPI service-class contract
├── message_recorder.md                 (Optional) recorder contract
├── recording_viewer.md                 (Optional) viewer contract
├── support_models.md                   Snapshot of the model lineup
├── requirements.md                     Cross-cutting requirements
├── models_config.yaml                  Sample model dropdown contents
└── frontend/                           Browser frontend (TypeScript ESM)
    ├── index.html
    ├── style.css
    └── *.ts                            Modular sources; script.ts is the entry
```

## Language scope

- **Frontend** — always TypeScript / ES modules. The browser is the
  only fixed runtime in this kit. The browser has **no proto
  dependency**: every WebSocket frame is JSON text in proto3 JSON
  shape.
- **Backend bridge** — *not* shipped as a runnable reference. It is
  specified in `backend_bridge.md` and the agent implements it in the
  same language as the service class (Step 4), so the same proto
  bindings, auth, and recorder can be reused. Earlier drafts of this
  kit shipped a Python `server.py`; that was removed because it
  implied Python was mandatory. The bridge is the only component
  that touches the proto library.
- **Service class** — whatever language the user picked in Step 1
  (see `session_manager.md`).

## Placeholders the coding agent MUST replace

| Placeholder | Where | What to do |
| --- | --- | --- |
| Backend proto bindings | Server (in the picked language) | Generate from `client_server_messages.proto`. The bridge needs `BidiGenerateContentClientMessage`, `BidiGenerateContentServerMessage`, `BidiGenerateContentToolResponse`, and `FunctionResponse`, plus a proto3 JSON parser/printer (see `backend_bridge.md` § *Wire format*). |
| `LiveSessionManagerWebsocket` | Server | Build per `session_manager.md`. |
| `MessageRecorder` *(optional)* | Server | Build per `message_recorder.md`. Skip if the recordings feature is disabled. |

## Backend wire shape (`/start` + `/ws`)

`POST /start` body:

```json
{
  "session_id": "<uuid>",
  "endpoint_url": "wss://<location>-aiplatform.googleapis.com/ws/...",
  "setup": {"setup": { /* BidiGenerateContentSetup */ }}
}
```

`GET /ws?session_id=<uuid>` then carries **JSON text frames** in both
directions, shaped as proto3 JSON encoding of
`BidiGenerateContentClientMessage` (browser → bridge) and
`BidiGenerateContentServerMessage` (bridge → browser). Out-of-band
JSON text frames `{"type": "tool_response", ...}` carry tool
responses executed by the bridge. See the comment at the top of
`frontend/websocket_client.ts`.

Full endpoint contract, per-session state, error semantics, CLI
flags, and per-language JSON ↔ proto helpers: see
`backend_bridge.md`.

## Models

Edit `models_config.yaml` to change what's in the dropdown:

```yaml
models:
  - name: Gemini live 2.5 flash native audio
    value: gemini-live-2.5-flash-native-audio
```

`value` is the bare model id; the frontend prepends
`projects/<project_id>/locations/<location>/publishers/google/models/`.
