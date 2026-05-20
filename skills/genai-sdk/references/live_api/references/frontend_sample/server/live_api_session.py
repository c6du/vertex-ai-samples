"""WebSocket session to the public Vertex Live API endpoint.

Implements the lifecycle described in ../session_manager.md:
  - bidirectional concurrent send/receive
  - transparent session resumption (SessionResumptionConfig.transparent=true)
  - reconnect on close codes 1000 / 1006 and on `goAway`
  - message buffering + replay (indexing starts at 1; 0 reserved for setup)
  - bearer-token refresh on each reconnect (Vertex mode)
  - api-key auth (non-Vertex mode)

Wire format upstream is JSON-serialized protobuf per the public Live API
documentation. We do not deserialize each frame here: the proxy passes the
raw JSON to the browser as binary (after re-encoding through proto so the
browser can decode with @bufbuild/protobuf). The reason is to keep the
browser <-> server WebSocket schema-typed without the browser needing to
know about proto-JSON's quirks (int64 as string, etc).
"""

from __future__ import annotations

import asyncio
import json
import logging
import urllib.parse
from typing import Awaitable, Callable

from google.protobuf import json_format
import websockets

from gen import client_server_messages_pb2 as pb

_LOG = logging.getLogger(__name__)

# Maximum number of reconnect attempts in a row before giving up. Each attempt
# uses exponential backoff (1s, 2s, 4s, ..., capped at 30s).
_MAX_RECONNECT_ATTEMPTS = 6


class FatalSessionError(Exception):
    """Raised when the upstream session cannot be recovered."""


class LiveApiSession:
    """Owns the upstream WebSocket; exposes typed send / receive.

    Lifecycle:
        s = LiveApiSession(...)
        await s.start(setup_message_binary)   # bytes of ClientMessage{setup}
        # then concurrently:
        await s.send(binary_client_message)   # browser -> upstream
        msg = await s.receive()               # upstream -> browser (bytes)
        await s.close()
    """

    def __init__(
        self,
        *,
        endpoint_url: str,
        use_vertex: bool,
        bearer_token_provider: Callable[[], Awaitable[str]] | None = None,
        api_key: str | None = None,
    ):
        if use_vertex and bearer_token_provider is None:
            raise ValueError(
                'bearer_token_provider is required when use_vertex=True.'
            )
        if not use_vertex and not api_key:
            raise ValueError('api_key is required when use_vertex=False.')
        self._endpoint_url = endpoint_url
        self._use_vertex = use_vertex
        self._bearer_token_provider = bearer_token_provider
        self._api_key = api_key

        self._ws: websockets.WebSocketClientProtocol | None = None
        self._setup_bytes: bytes | None = None
        # Buffer of (index, raw_proto_bytes) for messages we still need to
        # replay if we have to reconnect. Indexing starts at 1 (the server
        # reserves index 0 for the setup message).
        self._next_index = 1
        self._buffer: list[tuple[int, bytes]] = []
        self._resumption_handle: str = ''
        self._fatal: FatalSessionError | None = None
        self._closed = False
        self._receive_queue: asyncio.Queue[bytes | None] = asyncio.Queue()
        self._reader_task: asyncio.Task[None] | None = None

    @property
    def closed(self) -> bool:
        return self._closed

    async def start(self, setup_message_binary: bytes) -> None:
        """Connects and sends the initial setup message.

        `setup_message_binary` is a binary-serialized ClientMessage whose
        `setup` field is populated. We patch in `transparent=true` on the
        session resumption config so we can prune the replay buffer.
        """
        self._setup_bytes = self._patched_setup(setup_message_binary)
        await self._connect_and_send_setup()
        self._reader_task = asyncio.create_task(self._reader_loop())

    async def send(self, client_message_binary: bytes) -> None:
        """Sends a binary ClientMessage to the upstream session.

        Buffers the message for replay until the upstream confirms it has
        consumed it (via SessionResumptionUpdate.last_consumed_client_message_index).
        """
        if self._fatal is not None:
            raise self._fatal
        if self._closed:
            raise RuntimeError('Session is closed.')
        # Add to buffer first; if the send fails we'll resend during reconnect.
        idx = self._next_index
        self._next_index += 1
        self._buffer.append((idx, client_message_binary))
        json_str = self._proto_bytes_to_json_str(client_message_binary, pb.ClientMessage)
        try:
            assert self._ws is not None
            await self._ws.send(json_str)
        except (websockets.ConnectionClosed, OSError) as e:
            _LOG.warning('Send failed (will reconnect): %s', e)
            await self._reconnect_with_replay()

    async def receive(self) -> bytes | None:
        """Returns the next ServerMessage as binary bytes, or None on EOF."""
        if self._fatal is not None:
            raise self._fatal
        item = await self._receive_queue.get()
        return item

    async def close(self) -> None:
        """Closes the upstream WebSocket and stops the reader loop."""
        self._closed = True
        if self._ws is not None:
            try:
                await self._ws.close()
            except Exception:  # pylint: disable=broad-except
                pass
            self._ws = None
        if self._reader_task is not None:
            self._reader_task.cancel()
            try:
                await self._reader_task
            except (asyncio.CancelledError, Exception):  # pylint: disable=broad-except
                pass
            self._reader_task = None
        # Signal any waiting receive() call.
        await self._receive_queue.put(None)

    # ----- internals -----

    def _patched_setup(self, setup_bytes: bytes) -> bytes:
        """Returns the setup message with `session_resumption.transparent=true`.

        Necessary for the replay-buffer pruning logic.
        """
        msg = pb.ClientMessage()
        msg.ParseFromString(setup_bytes)
        if msg.WhichOneof('message_type') != 'setup':
            raise ValueError('First message must be a setup message.')
        msg.setup.session_resumption.transparent = True
        if self._resumption_handle:
            msg.setup.session_resumption.handle = self._resumption_handle
        return msg.SerializeToString()

    def _build_url(self) -> str:
        if self._use_vertex:
            return self._endpoint_url
        # Non-Vertex (Google AI) uses ?key= for auth.
        sep = '&' if '?' in self._endpoint_url else '?'
        return f'{self._endpoint_url}{sep}key={urllib.parse.quote(self._api_key or "")}'

    async def _build_headers(self) -> dict[str, str]:
        if self._use_vertex:
            assert self._bearer_token_provider is not None
            token = await self._bearer_token_provider()
            return {'Authorization': f'Bearer {token}'}
        return {}

    async def _connect_and_send_setup(self) -> None:
        """One-shot connect + send setup; raises on failure."""
        url = self._build_url()
        headers = await self._build_headers()
        _LOG.info('Connecting to upstream: %s', url)
        # Tell websockets to use the headers we built (works across versions
        # via the additional_headers kwarg added in v12).
        connect_kwargs = {'additional_headers': list(headers.items())}
        try:
            self._ws = await websockets.connect(url, **connect_kwargs)
        except TypeError:
            # Older websockets versions used `extra_headers`.
            self._ws = await websockets.connect(
                url, extra_headers=list(headers.items())
            )
        # Always send setup first; this is the new connection's index-0 message.
        assert self._setup_bytes is not None
        await self._ws.send(
            self._proto_bytes_to_json_str(self._setup_bytes, pb.ClientMessage)
        )

    async def _reconnect_with_replay(self) -> None:
        """Reconnects and resends every buffered message (index resets to 1)."""
        if self._closed:
            return
        # Reset the per-connection index: the buffer holds messages that the
        # NEW upstream hasn't seen, so they'll be sent with fresh indices
        # starting at 1 again. The buffer entries' original indices are
        # discarded; we only care about ORDER.
        self._next_index = 1
        relayed: list[tuple[int, bytes]] = []
        for backoff_n in range(_MAX_RECONNECT_ATTEMPTS):
            try:
                if self._ws is not None:
                    try:
                        await self._ws.close()
                    except Exception:  # pylint: disable=broad-except
                        pass
                    self._ws = None
                await self._connect_and_send_setup()
                # Replay buffered messages with fresh indices.
                for _old_idx, payload in self._buffer:
                    idx = self._next_index
                    self._next_index += 1
                    relayed.append((idx, payload))
                    await self._ws.send(  # type: ignore[union-attr]
                        self._proto_bytes_to_json_str(payload, pb.ClientMessage)
                    )
                # Buffer is updated (only) after a clean replay.
                self._buffer = relayed
                return
            except Exception as e:  # pylint: disable=broad-except
                wait = min(30.0, 1.0 * (2**backoff_n))
                _LOG.warning(
                    'Reconnect attempt %d failed: %s (sleeping %.1fs)',
                    backoff_n + 1,
                    e,
                    wait,
                )
                relayed.clear()
                await asyncio.sleep(wait)
        self._fatal = FatalSessionError(
            'Unable to reconnect to upstream Live API after several attempts.'
        )
        await self._receive_queue.put(None)

    async def _reader_loop(self) -> None:
        """Forwards upstream frames into the receive queue.

        Handles `goAway` (proactive reconnect) and intercepts
        `sessionResumptionUpdate` to update the replay buffer + handle.
        """
        try:
            while not self._closed:
                if self._ws is None:
                    await asyncio.sleep(0.1)
                    continue
                try:
                    frame = await self._ws.recv()
                except websockets.ConnectionClosedOK:
                    _LOG.info('Upstream closed cleanly (1000).')
                    await self._reconnect_with_replay()
                    continue
                except websockets.ConnectionClosed as e:
                    if e.code in (1000, 1006):
                        _LOG.warning('Upstream closed with %s; reconnecting.', e.code)
                        await self._reconnect_with_replay()
                        continue
                    self._fatal = FatalSessionError(
                        f'Upstream closed unexpectedly: code={e.code} reason={e.reason}'
                    )
                    await self._receive_queue.put(None)
                    return
                # Convert JSON text -> binary ServerMessage.
                try:
                    server_bytes = self._json_str_to_proto_bytes(frame, pb.ServerMessage)
                except Exception as e:  # pylint: disable=broad-except
                    _LOG.warning('Failed to parse upstream JSON frame: %s', e)
                    continue
                # Intercept lifecycle messages.
                msg = pb.ServerMessage()
                try:
                    msg.ParseFromString(server_bytes)
                except Exception:  # pylint: disable=broad-except
                    pass
                else:
                    which = msg.WhichOneof('message_type')
                    if which == 'go_away':
                        _LOG.info(
                            'Got goAway (time_left=%.1fs); reconnecting.',
                            msg.go_away.time_left.ToTimedelta().total_seconds(),
                        )
                        # Forward to client, then proactively reconnect.
                        await self._receive_queue.put(server_bytes)
                        await self._reconnect_with_replay()
                        continue
                    if which == 'session_resumption_update':
                        upd = msg.session_resumption_update
                        if upd.resumable and upd.new_handle:
                            self._resumption_handle = upd.new_handle
                        # Prune buffer: drop everything up to and including
                        # last_consumed_client_message_index.
                        cutoff = upd.last_consumed_client_message_index
                        if cutoff > 0:
                            self._buffer = [
                                (i, p) for (i, p) in self._buffer if i > cutoff
                            ]
                        # Also surface to the browser for visibility.
                        await self._receive_queue.put(server_bytes)
                        continue
                await self._receive_queue.put(server_bytes)
        except asyncio.CancelledError:
            return
        except Exception as e:  # pylint: disable=broad-except
            _LOG.exception('Reader loop crashed.')
            self._fatal = FatalSessionError(str(e))
            await self._receive_queue.put(None)

    @staticmethod
    def _proto_bytes_to_json_str(payload: bytes, msg_cls) -> str:
        msg = msg_cls()
        msg.ParseFromString(payload)
        return json_format.MessageToJson(
            msg,
            preserving_proto_field_name=False,
            including_default_value_fields=False,
        )

    @staticmethod
    def _json_str_to_proto_bytes(text: str | bytes, msg_cls) -> bytes:
        if isinstance(text, (bytes, bytearray)):
            text = text.decode('utf-8')
        msg = msg_cls()
        json_format.Parse(text, msg, ignore_unknown_fields=True)
        return msg.SerializeToString()
