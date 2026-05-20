---
name: liveapi-cross-cutting-requirements
description: >-
  Cross-cutting requirements for the LiveAPI service skill. These rules
  apply to every step of the workflow (class implementation, backend,
  frontend, recorder, viewer) and must be re-read before declaring any
  deliverable complete.
---

# Cross-cutting requirements

These rules apply at every step of the LiveAPI service skill workflow.
The agent should re-read this file before declaring any step complete.

## Reuse the proto types

All client / server traffic — in the service class, the backend bridge,
and the frontend — MUST use the `ClientMessage` and `ServerMessage`
defined in `client_server_messages.proto`. No ad-hoc parallel structs,
no hand-rolled JSON shapes for messages already defined in the proto.

## Optional features integration

### Recordings (recorder + viewer; per `message_recorder.md` and `recording_viewer.md`)

The recorder and the viewer are a **single combined feature**: the
agent asks the user about them exactly once ("enable recordings?"),
and both are produced together or not at all. The recorder writes the
on-disk artefacts; the viewer loads them. Shipping one without the
other is not supported.

When the recordings feature is enabled:

-   The service class accepts the recorder as an **optional**
    constructor argument. When omitted (i.e. the user disabled
    recordings entirely), recording is disabled with zero runtime
    overhead.
-   The class owns building each record before calling
    `recorder.record(...)`: set the appropriate `payload` oneof arm
    (client or server message), the `timestamp`, and the `agent_name`.
-   The class MUST NOT call `recorder.start()` or `recorder.close()`.
    The recorder's lifecycle belongs to the caller so a single recorder
    can be shared across multiple sessions.
-   Recorder errors are best-effort and must never interrupt the
    session.
-   On-disk format: length-prefixed serialized protobuf (recommended)
    or JSON Lines. Do **not** use Google-internal formats (e.g.
    recordio). Write **one record per message** — never batch.
-   The viewer is served from the **same process and same port** as
    the chat backend, and is rendered as a second sidebar tab
    ("Recordings") in the same single-page app as the chat playground
    (see `interactive_ui.md`). It is not a separate service.
-   Recordings produced by completed chat sessions appear in the
    Recordings tab's "Recent recordings" list automatically; the user
    can also load a file by server path or by uploading from their
    machine.

## Audio / transcription playback

Follow the public best-practices guide:
https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/best-practices

For interrupt handling and streaming transcription bubbles, follow the
spec in `interactive_ui.md` (single playback FIFO queue, flush on
`serverContent.interrupted`, close bubble on `finished` /
`turnComplete`).

## Responsive layout

All web frontends produced by this skill (test UI, recording viewer)
MUST fit within the browser viewport at common laptop resolutions
(≥ 1366×768) without page-level scrolling.

-   Page-level layout sized to `100vh` / `100vw`; `body` is not
    scrollable.
-   Inner panels (chat transcript, timeline, log panel) use
    `overflow: auto`; long content scrolls **inside** its panel rather
    than pushing the rest of the UI off-screen.
-   Top-level containers use relative units (`vh`, `vw`, `%`, `fr`),
    not fixed pixels.
-   Verify at 1366×768 and 1920×1080 — header, primary action buttons,
    preview, and at least part of the transcript / timeline must be
    visible without scrolling the page.

This rule applies even when there are multiple panels — split the
viewport between them with scrollable inner regions instead of
stacking them into a tall page.

## Verification (run during Step 8)

For every web service produced, the agent MUST start it, open it in a
(headless) browser, and verify all of the following:

### Smoke checks (every service)

1.  Process starts without error and binds to the expected port.
2.  Page loads (HTTP 200) and primary content renders.
3.  Core controls are visible without page-level scrolling at
    1366×768.

### End-to-end interactions

-   **Test UI**: open a connection → send a text message → receive a
    response. Trigger an interrupt scenario and confirm playback is
    flushed.
-   **Recordings** (if the recordings feature is enabled, covering BOTH
    recorder and viewer together):
    -   *Recorder leg:* run a session that records → close the
        recorder → the resulting file is non-empty and parseable as
        the chosen on-disk format.
    -   *Setup coverage (recorder):* after a smoke session, the
        resulting recording file MUST begin with exactly one
        `client` / `setup` record followed by one `server` /
        `setupComplete` record. Assert this in the recorder smoke
        test — it catches the common "send-path records, but the
        setup bypass forgets" bug where the manager's separate
        connect-time code path skips `recorder.record(...)`.
    -   *Two-tab integration:* the chat tab and the Recordings tab are
        served from the same origin/port and switching between them in
        the sidebar does not reload the page; the just-recorded
        session appears in the Recordings tab's "Recent recordings"
        list (refreshing the list may be required).
    -   *Viewer leg:* the checks below.
    1.  Load the shipped fixture
        `references/sample_recording.jsonl` by **uploading** it
        through the Recordings tab. (The viewer no longer accepts an
        arbitrary filesystem path; recordings are loaded either from
        the in-process cache directory via the "Recent recordings"
        list or by upload.) Upload it a second time to confirm
        idempotency.
    2.  Switch the global toggle and at least one per-agent toggle
        between Playback and Message modes.
    3.  Click a server audio bar and pin its tooltip; confirm the
        proto detail renders.
    4.  **Playback ≠ Message assertion** — fetch `/api/agents` for the
        loaded fixture and verify, programmatically or by direct
        inspection, that **all** of these hold:
        -   For every agent, `total_ms(playback) >= total_ms(message)`.
        -   At least one server-audio message satisfies
            `end_ms - start_ms >= 50` ms (i.e., it renders as a wide
            duration bar in playback mode, not as a 2 px instant
            marker).
        -   For the fixture's interrupt section, at least one
            server-audio message has `start_ms != wire_ms` (the
            interrupt rewind shifted at least one subsequent chunk).
        -   No message with `modality == "audio"` has
            `end_ms == start_ms` (the audio-duration invariant from
            `recording_viewer.md` § Audio duration).
    5.  If any of these fails, the bug is in the viewer server's
        reconstruction pipeline, not the frontend. See
        `recording_viewer.md` § Diagnostics for the five known
        failure modes.
    6.  **Replay popup** — click "▶ Replay session" on any agent that
        has streamed client video frames; confirm the popup opens,
        `<audio controls>` plays the mixed WAV, and the displayed
        video frame updates as `audio.currentTime` advances. Closing
        the popup (Esc / × / backdrop click) revokes the cached
        object URLs (no console errors).
    7.  **Per-message image popup** — pin a tooltip on any message
        whose `image_chunks[]` is non-empty (a client `realtime_input`
        video frame or a server-emitted `inlineData` image part);
        click "View image"; confirm the image renders. If no such
        message exists in the fixture, the path is exercised by an
        empty-state ("No image chunks attached to this message.")
        rather than skipped silently.
-   **Recordings end-to-end** (if the feature is enabled): record a
    live session in the Chat tab → after the session toast appears,
    switch to the Recordings tab (no page reload) → the new recording
    is present in the "Recent recordings" list → click it to load →
    server audio bars appear in playback mode as **wide duration
    bars** (not instant markers); the same bars in message mode
    collapse to the 4 px fixed-width form; "▶ Replay session" plays
    the audio with the slideshow advancing in sync.

Report any failures and fix them before declaring the implementation
complete.
