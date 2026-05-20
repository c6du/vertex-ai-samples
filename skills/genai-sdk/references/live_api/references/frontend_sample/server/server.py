"""Tornado server for the Live API reference playground.

Endpoints (HTTP, JSON):
    GET  /project_info        -> {project_id}
    GET  /models              -> {models: {websocket: [{name, value}]}}
    POST /start               -> {status} (binds a session id to a setup msg)
    POST /stop                -> {status} (idempotent teardown)
    GET  /api/recordings      -> {recordings: [{name, size, mtime}]}
    POST /api/load            -> {frames: [{timestamp_ms, direction, decoded}]}
    POST /api/upload          -> {name}
    GET  /                    -> built frontend (vite build output)

WebSocket:
    GET  /ws?session_id=...   -> binary <ClientMessage>/<ServerMessage>
                                 frames proxied to the public Live API endpoint.

Per-session lifecycle:
    1. Browser POSTs /start with {session_id, endpoint_url, setup}
    2. Server stashes the setup proto-JSON for the session id.
    3. Browser opens /ws?session_id=... .
    4. WS handler connects to the upstream Live API session, sends the setup
       as the first message, then bridges binary frames in both directions.
    5. Every frame in both directions is appended to a per-session
       recording file (portable binary format).

Public Vertex Live API only. No MCP, no internal-only backends.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
import shutil
import sys
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

# Ensure `from gen import ...` works for the generated proto modules.
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

import tornado.escape  # noqa: E402
import tornado.web  # noqa: E402
import tornado.websocket  # noqa: E402
import yaml  # noqa: E402
from google.protobuf import json_format  # noqa: E402

from gen import client_server_messages_pb2 as pb  # noqa: E402
from live_api_session import FatalSessionError, LiveApiSession  # noqa: E402
from recording import RecordingWriter, iter_frames  # noqa: E402

_LOG = logging.getLogger(__name__)

DEFAULT_PORT = 8008
DEFAULT_FRONTEND_DIST = os.path.normpath(os.path.join(_HERE, '..', 'dist'))
DEFAULT_MODELS_CONFIG = os.path.join(_HERE, 'models_config.yaml')
DEFAULT_RECORDINGS_DIR = os.path.normpath(
    os.path.join(_HERE, '..', '.recordings')
)


# ---------------------------------------------------------------------------
# Auth providers
# ---------------------------------------------------------------------------

class _BearerTokenProvider:
    """Refreshes a Google Cloud bearer token on demand.

    Uses Application Default Credentials. Run `gcloud auth application-default
    login` once to set them up.
    """

    def __init__(self):
        from google.auth import default  # pylint: disable=g-import-not-at-top
        from google.auth.transport.requests import (
            Request,
        )  # pylint: disable=g-import-not-at-top

        self._credentials, self._project = default(
            scopes=['https://www.googleapis.com/auth/cloud-platform']
        )
        self._request_cls = Request

    def project_id(self) -> str:
        return self._project or ''

    async def __call__(self) -> str:
        # google-auth refresh is sync; offload to a thread so we don't block
        # the Tornado event loop.
        def _refresh():
            if not self._credentials.valid:
                self._credentials.refresh(self._request_cls())
            return self._credentials.token

        return await asyncio.to_thread(_refresh)


# ---------------------------------------------------------------------------
# Per-session state
# ---------------------------------------------------------------------------

@dataclass
class SessionState:
    session_id: str
    setup_message_binary: bytes
    endpoint_url: str
    recording_path: str
    upstream: LiveApiSession | None = None
    recorder: RecordingWriter | None = None
    ws_handler: tornado.websocket.WebSocketHandler | None = None
    reader_task: asyncio.Task[None] | None = None
    # Extra metadata kept around for the recording's file header.
    metadata: dict[str, str] = field(default_factory=dict)


sessions: dict[str, SessionState] = {}


# ---------------------------------------------------------------------------
# Models config loader
# ---------------------------------------------------------------------------

def _load_models_config(path: str) -> dict[str, list[dict[str, str]]]:
    """Loads models_config.yaml and returns the dict shape the frontend wants."""
    if not os.path.exists(path):
        return {}
    with open(path, 'r', encoding='utf-8') as fh:
        raw = yaml.safe_load(fh) or {}
    out: dict[str, list[dict[str, str]]] = {}
    for backend, entries in (raw or {}).items():
        if not isinstance(entries, list):
            continue
        norm: list[dict[str, str]] = []
        for e in entries:
            if not isinstance(e, dict):
                continue
            label = str(e.get('label') or e.get('name') or e.get('value') or '')
            value = str(e.get('value') or '')
            if label and value:
                norm.append({'name': label, 'value': value})
        out[backend] = norm
    return out


# ---------------------------------------------------------------------------
# HTTP handlers
# ---------------------------------------------------------------------------

class ProjectInfoHandler(tornado.web.RequestHandler):
    """GET /project_info -> {project_id}."""

    project_id: str

    def initialize(self, project_id: str) -> None:  # pylint: disable=arguments-differ
        self.project_id = project_id

    def get(self) -> None:
        self.set_header('Cache-Control', 'no-store')
        self.write({'project_id': self.project_id})


class ModelsHandler(tornado.web.RequestHandler):
    """GET /models -> per-backend list of selectable models."""

    config_path: str

    def initialize(self, config_path: str) -> None:  # pylint: disable=arguments-differ
        self.config_path = config_path

    def get(self) -> None:
        self.set_header('Cache-Control', 'no-store')
        self.write({'models': _load_models_config(self.config_path)})


class StartHandler(tornado.web.RequestHandler):
    """POST /start: binds a session id to a setup message + endpoint URL."""

    recordings_dir: str

    def initialize(self, recordings_dir: str) -> None:  # pylint: disable=arguments-differ
        self.recordings_dir = recordings_dir

    async def post(self) -> None:
        try:
            body = tornado.escape.json_decode(self.request.body)
        except Exception as e:
            raise tornado.web.HTTPError(400, f'Invalid JSON: {e}') from e
        session_id = body.get('session_id')
        endpoint_url = body.get('endpoint_url')
        setup_json = body.get('setup')
        if not session_id:
            raise tornado.web.HTTPError(400, 'session_id missing')
        if not endpoint_url:
            raise tornado.web.HTTPError(400, 'endpoint_url missing')
        if not setup_json:
            raise tornado.web.HTTPError(400, 'setup missing')

        # Validate the setup JSON against the proto schema. Field-name
        # mismatches surface here as a 400 with a helpful message.
        try:
            client_msg = pb.ClientMessage()
            json_format.ParseDict(
                setup_json, client_msg, ignore_unknown_fields=False
            )
        except json_format.ParseError as e:
            raise tornado.web.HTTPError(400, f'Invalid setup JSON: {e}') from e
        if client_msg.WhichOneof('message_type') != 'setup':
            raise tornado.web.HTTPError(
                400, 'setup JSON must populate the `setup` field.'
            )
        setup_binary = client_msg.SerializeToString()

        # Tear down any pre-existing session under this id.
        existing = sessions.pop(session_id, None)
        if existing is not None:
            await _teardown_session(existing, reason='restart')

        os.makedirs(self.recordings_dir, exist_ok=True)
        recording_path = os.path.join(
            self.recordings_dir,
            f'{int(time.time())}_{session_id}.pb',
        )
        sessions[session_id] = SessionState(
            session_id=session_id,
            setup_message_binary=setup_binary,
            endpoint_url=endpoint_url,
            recording_path=recording_path,
            metadata={
                'endpoint_url': endpoint_url,
                'model': client_msg.setup.model,
            },
        )
        self.write({'status': 'started', 'session_id': session_id})


class StopHandler(tornado.web.RequestHandler):
    """POST /stop?session_id=...: idempotent teardown."""

    async def post(self) -> None:
        session_id = self.get_argument('session_id', None)
        if not session_id:
            raise tornado.web.HTTPError(400, 'session_id missing')
        state = sessions.pop(session_id, None)
        if state is not None:
            await _teardown_session(state, reason='explicit_stop')
        self.write({'status': 'stopped'})


# ---------------------------------------------------------------------------
# Recording endpoints
# ---------------------------------------------------------------------------

class RecordingsListHandler(tornado.web.RequestHandler):
    """GET /api/recordings -> {recordings: [{name, size, mtime}]}."""

    recordings_dir: str

    def initialize(self, recordings_dir: str) -> None:  # pylint: disable=arguments-differ
        self.recordings_dir = recordings_dir

    def get(self) -> None:
        items: list[dict[str, Any]] = []
        if os.path.isdir(self.recordings_dir):
            for name in sorted(os.listdir(self.recordings_dir), reverse=True):
                if not name.endswith('.pb'):
                    continue
                path = os.path.join(self.recordings_dir, name)
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                items.append({
                    'name': name,
                    'size': st.st_size,
                    'mtime': int(st.st_mtime),
                })
        self.set_header('Cache-Control', 'no-store')
        self.write({'recordings': items})


class RecordingLoadHandler(tornado.web.RequestHandler):
    """POST /api/load {name} -> {frames: [...]} decoded to JSON for the UI."""

    recordings_dir: str

    def initialize(self, recordings_dir: str) -> None:  # pylint: disable=arguments-differ
        self.recordings_dir = recordings_dir

    def post(self) -> None:
        try:
            body = tornado.escape.json_decode(self.request.body)
        except Exception as e:
            raise tornado.web.HTTPError(400, f'Invalid JSON: {e}') from e
        name = body.get('name', '')
        if not name or '/' in name or '\\' in name:
            raise tornado.web.HTTPError(400, 'Bad name')
        path = os.path.join(self.recordings_dir, name)
        if not os.path.exists(path):
            raise tornado.web.HTTPError(404, 'Recording not found')

        frames_json: list[dict[str, Any]] = []
        for frame in iter_frames(path):
            decoded = _decode_frame_payload(
                frame.payload,
                is_client=frame.direction == pb.ClientMessage.DESCRIPTOR.full_name  # never true
                or False,
                direction_enum=frame.direction,
            )
            frames_json.append({
                'timestamp_ms': frame.timestamp_ms,
                'direction': _direction_to_string(frame.direction),
                'decoded': decoded,
            })
        self.set_header('Cache-Control', 'no-store')
        self.write({'frames': frames_json})


class RecordingUploadHandler(tornado.web.RequestHandler):
    """POST /api/upload (multipart) -> {name}; saves uploaded file."""

    recordings_dir: str

    def initialize(self, recordings_dir: str) -> None:  # pylint: disable=arguments-differ
        self.recordings_dir = recordings_dir

    def post(self) -> None:
        files = self.request.files.get('file', [])
        if not files:
            raise tornado.web.HTTPError(400, 'Missing file')
        os.makedirs(self.recordings_dir, exist_ok=True)
        f = files[0]
        # Use the user-supplied filename if it's safe, else generate one.
        original = os.path.basename(f.filename or '')
        if (
            not original
            or '/' in original
            or '\\' in original
            or not original.endswith('.pb')
        ):
            original = f'upload_{uuid.uuid4().hex}.pb'
        dest = os.path.join(self.recordings_dir, original)
        with open(dest, 'wb') as fh:
            fh.write(f.body)
        self.write({'name': original})


def _direction_to_string(d: int) -> str:
    from gen.recorded_frame_pb2 import RecordedFrame  # local import to avoid cycles
    return RecordedFrame.Direction.Name(d)


def _decode_frame_payload(
    payload: bytes,
    *,
    is_client: bool,
    direction_enum: int,
) -> Any:
    """Parses the payload as the appropriate top-level message and returns
    a dict (proto-JSON shape) the frontend can render.
    """
    from gen.recorded_frame_pb2 import RecordedFrame  # local import
    msg_cls = (
        pb.ClientMessage
        if direction_enum == RecordedFrame.CLIENT_TO_SERVER
        else pb.ServerMessage
    )
    _ = is_client  # parameter kept for clarity; direction_enum is authoritative.
    msg = msg_cls()
    try:
        msg.ParseFromString(payload)
    except Exception as e:  # pylint: disable=broad-except
        return {'__decode_error__': str(e)}
    return json_format.MessageToDict(
        msg,
        preserving_proto_field_name=False,
        including_default_value_fields=False,
    )


# ---------------------------------------------------------------------------
# WebSocket bridge
# ---------------------------------------------------------------------------

class ChatWebSocket(tornado.websocket.WebSocketHandler):
    """Bridges the browser <-> upstream Live API session."""

    bearer_token_provider: _BearerTokenProvider | None
    use_vertex: bool
    api_key: str | None

    def initialize(  # pylint: disable=arguments-differ
        self,
        bearer_token_provider: _BearerTokenProvider | None,
        use_vertex: bool,
        api_key: str | None,
    ) -> None:
        self.bearer_token_provider = bearer_token_provider
        self.use_vertex = use_vertex
        self.api_key = api_key
        self._session_id: str = ''
        self._state: SessionState | None = None
        self._reader_task: asyncio.Task[None] | None = None

    def check_origin(self, origin: str) -> bool:  # pylint: disable=unused-argument
        # Local-only reference server: allow vite dev origin too.
        return True

    async def open(self, *_args, **_kwargs) -> None:  # type: ignore[override]
        session_id = self.get_query_argument('session_id', '')
        if not session_id or session_id not in sessions:
            self.close(1008, 'Unknown session_id')
            return
        self._session_id = session_id
        self._state = sessions[session_id]
        self._state.ws_handler = self

        # Recorder + upstream session.
        try:
            self._state.recorder = RecordingWriter(
                self._state.recording_path,
                metadata=self._state.metadata,
            )
            self._state.recorder.open()
            self._state.upstream = LiveApiSession(
                endpoint_url=self._state.endpoint_url,
                use_vertex=self.use_vertex,
                bearer_token_provider=(
                    self.bearer_token_provider
                    if self.use_vertex
                    else None
                ),
                api_key=self.api_key,
            )
            # Record the setup as the first client->server frame.
            self._state.recorder.append_client_to_server(
                self._state.setup_message_binary
            )
            await self._state.upstream.start(self._state.setup_message_binary)
        except FatalSessionError as e:
            _LOG.exception('Failed to start upstream session.')
            self.close(1011, f'Upstream start failed: {e}')
            return
        except Exception as e:  # pylint: disable=broad-except
            _LOG.exception('Failed to open upstream session.')
            self.close(1011, f'Upstream open failed: {e}')
            return

        self._reader_task = asyncio.create_task(self._reader_loop())

    async def on_message(self, message: bytes | str) -> None:  # type: ignore[override]
        if isinstance(message, str):
            _LOG.warning('Ignoring unexpected text frame on /ws.')
            return
        state = self._state
        if state is None or state.upstream is None:
            return
        # Record client-to-server frame.
        if state.recorder is not None:
            try:
                state.recorder.append_client_to_server(message)
            except Exception:  # pylint: disable=broad-except
                _LOG.exception('Failed to record outgoing frame.')
        try:
            await state.upstream.send(message)
        except FatalSessionError as e:
            _LOG.warning('Upstream send failed fatally: %s', e)
            self.close(1011, f'Upstream send failed: {e}')

    async def _reader_loop(self) -> None:
        state = self._state
        if state is None or state.upstream is None:
            return
        try:
            while True:
                msg = await state.upstream.receive()
                if msg is None:
                    self.close(1000, 'Upstream EOF')
                    return
                if state.recorder is not None:
                    try:
                        state.recorder.append_server_to_client(msg)
                    except Exception:  # pylint: disable=broad-except
                        _LOG.exception('Failed to record incoming frame.')
                try:
                    await self.write_message(msg, binary=True)
                except tornado.websocket.WebSocketClosedError:
                    return
        except asyncio.CancelledError:
            return
        except Exception as e:  # pylint: disable=broad-except
            _LOG.exception('Reader loop crashed.')
            try:
                self.close(1011, f'Reader crashed: {e}')
            except Exception:  # pylint: disable=broad-except
                pass

    def on_close(self) -> None:
        if self._reader_task is not None:
            self._reader_task.cancel()
            self._reader_task = None
        state = sessions.pop(self._session_id, None)
        if state is not None:
            # Fire-and-forget; we're already on close.
            asyncio.create_task(_teardown_session(state, reason='ws_closed'))


async def _teardown_session(state: SessionState, *, reason: str) -> None:
    _LOG.info('Tearing down session %s (%s)', state.session_id, reason)
    if state.upstream is not None:
        try:
            await state.upstream.close()
        except Exception:  # pylint: disable=broad-except
            _LOG.exception('Error closing upstream session.')
        state.upstream = None
    if state.recorder is not None:
        try:
            state.recorder.close()
        except Exception:  # pylint: disable=broad-except
            _LOG.exception('Error closing recorder.')
        state.recorder = None


# ---------------------------------------------------------------------------
# App wiring
# ---------------------------------------------------------------------------

def make_app(
    *,
    project_id: str,
    use_vertex: bool,
    api_key: str | None,
    bearer_token_provider: _BearerTokenProvider | None,
    models_config_path: str,
    recordings_dir: str,
    frontend_dist: str,
) -> tornado.web.Application:
    handlers: list[Any] = [
        (r'/project_info', ProjectInfoHandler, {'project_id': project_id}),
        (r'/models', ModelsHandler, {'config_path': models_config_path}),
        (r'/start', StartHandler, {'recordings_dir': recordings_dir}),
        (r'/stop', StopHandler),
        (
            r'/ws',
            ChatWebSocket,
            {
                'bearer_token_provider': bearer_token_provider,
                'use_vertex': use_vertex,
                'api_key': api_key,
            },
        ),
        (
            r'/api/recordings',
            RecordingsListHandler,
            {'recordings_dir': recordings_dir},
        ),
        (
            r'/api/load',
            RecordingLoadHandler,
            {'recordings_dir': recordings_dir},
        ),
        (
            r'/api/upload',
            RecordingUploadHandler,
            {'recordings_dir': recordings_dir},
        ),
    ]
    if os.path.isdir(frontend_dist):
        handlers.append((
            r'/(.*)',
            tornado.web.StaticFileHandler,
            {'path': frontend_dist, 'default_filename': 'index.html'},
        ))
    else:
        _LOG.warning(
            'Frontend dist directory not found at %s; HTTP static serving '
            'disabled. (Run `npm run build` to populate it, or use '
            '`npm run dev` to serve the frontend on :5173 with a proxy.)',
            frontend_dist,
        )
    return tornado.web.Application(handlers, websocket_max_message_size=64 << 20)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s %(levelname)s %(name)s: %(message)s',
    )
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument(
        '--use-vertex',
        action='store_true',
        default=True,
        help='Use Vertex AI bearer-token auth (default).',
    )
    parser.add_argument(
        '--no-vertex',
        dest='use_vertex',
        action='store_false',
        help='Use Gemini Developer API key auth (--api-key required).',
    )
    parser.add_argument(
        '--api-key',
        default=os.environ.get('GEMINI_API_KEY'),
        help='Gemini Developer API key (required iff --no-vertex). '
        'Defaults to $GEMINI_API_KEY.',
    )
    parser.add_argument(
        '--project-id',
        default=None,
        help='Override Cloud project id. Defaults to ADC project.',
    )
    parser.add_argument('--models-config', default=DEFAULT_MODELS_CONFIG)
    parser.add_argument('--recordings-dir', default=DEFAULT_RECORDINGS_DIR)
    parser.add_argument('--frontend-dist', default=DEFAULT_FRONTEND_DIST)
    args = parser.parse_args()

    bearer_token_provider: _BearerTokenProvider | None = None
    project_id = args.project_id or ''
    if args.use_vertex:
        bearer_token_provider = _BearerTokenProvider()
        if not project_id:
            project_id = bearer_token_provider.project_id()
        if not project_id:
            _LOG.error(
                'No Cloud project id resolved. Pass --project-id or run '
                '`gcloud config set project <id>`.'
            )
            sys.exit(2)
    else:
        if not args.api_key:
            _LOG.error('--api-key (or $GEMINI_API_KEY) required with --no-vertex.')
            sys.exit(2)

    # Best-effort: warn if vite dist is missing so the user knows what's up.
    if not os.path.isdir(args.frontend_dist):
        _LOG.warning(
            'Frontend not built. Run `npm install && npm run build` in %s.',
            os.path.dirname(args.frontend_dist),
        )
    elif not shutil.which('node'):
        pass  # we don't need node at runtime; only at build.

    app = make_app(
        project_id=project_id,
        use_vertex=args.use_vertex,
        api_key=args.api_key,
        bearer_token_provider=bearer_token_provider,
        models_config_path=args.models_config,
        recordings_dir=args.recordings_dir,
        frontend_dist=args.frontend_dist,
    )
    app.listen(args.port)
    _LOG.info('Serving on http://localhost:%d', args.port)
    _LOG.info('Recordings directory: %s', args.recordings_dir)
    _LOG.info(
        'Auth mode: %s', 'Vertex bearer-token' if args.use_vertex else 'API key'
    )
    asyncio.get_event_loop().run_forever()


if __name__ == '__main__':
    main()
