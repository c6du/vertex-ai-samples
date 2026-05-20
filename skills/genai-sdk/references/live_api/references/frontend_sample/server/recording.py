"""Portable session-recording reader/writer.

On-disk layout (see ../proto/recorded_frame.proto):

  [4-byte big-endian uint32 length][N-byte serialized FileHeader]   (optional)
  [4-byte big-endian uint32 length][N-byte serialized RecordedFrame]
  [4-byte big-endian uint32 length][N-byte serialized RecordedFrame]
  ...

The writer is append-only and synchronous-friendly (each write is one
length-prefix + one serialized proto, atomic at the OS-level for typical
payload sizes).
"""

from __future__ import annotations

import io
import struct
import time
from typing import Iterator

from gen import recorded_frame_pb2

# 4-byte big-endian length prefix. Chosen for human readability in hex dumps
# and so a single record cannot exceed 4 GiB (way larger than any audio frame
# we ever produce).
_LENGTH_STRUCT = struct.Struct('>I')

# Magic recognised in the optional FileHeader record so readers can detect
# format mismatches. Must match the literal in recorded_frame.proto's docs.
_FILE_HEADER_MAGIC = 'LIVEREC1'
_FORMAT_VERSION = 1


class RecordingWriter:
    """Append-only writer for the length-prefixed RecordedFrame stream."""

    def __init__(self, path: str, *, metadata: dict[str, str] | None = None):
        self._path = path
        self._fh: io.BufferedWriter | None = None
        self._metadata = dict(metadata or {})

    def __enter__(self) -> 'RecordingWriter':
        self.open()
        return self

    def __exit__(self, *_exc) -> None:
        self.close()

    def open(self) -> None:
        """Opens the file and writes the FileHeader record."""
        if self._fh is not None:
            return
        self._fh = open(self._path, 'wb', buffering=0)
        header = recorded_frame_pb2.FileHeader(
            magic=_FILE_HEADER_MAGIC,
            version=_FORMAT_VERSION,
            started_at_ms=int(time.time() * 1000),
            metadata=self._metadata,
        )
        self._write_record(header.SerializeToString())

    def close(self) -> None:
        if self._fh is not None:
            try:
                self._fh.flush()
            finally:
                self._fh.close()
                self._fh = None

    def append_client_to_server(self, payload_bytes: bytes) -> None:
        """Records a frame originating at the browser (binary ClientMessage)."""
        self._append_frame(
            payload_bytes,
            recorded_frame_pb2.RecordedFrame.CLIENT_TO_SERVER,
        )

    def append_server_to_client(self, payload_bytes: bytes) -> None:
        """Records a frame originating at the Live API server (binary ServerMessage)."""
        self._append_frame(
            payload_bytes,
            recorded_frame_pb2.RecordedFrame.SERVER_TO_CLIENT,
        )

    def _append_frame(self, payload_bytes: bytes, direction: int) -> None:
        if self._fh is None:
            raise RuntimeError('RecordingWriter is closed.')
        frame = recorded_frame_pb2.RecordedFrame(
            timestamp_ms=int(time.time() * 1000),
            direction=direction,
            payload=payload_bytes,
        )
        self._write_record(frame.SerializeToString())

    def _write_record(self, payload: bytes) -> None:
        assert self._fh is not None
        self._fh.write(_LENGTH_STRUCT.pack(len(payload)))
        self._fh.write(payload)


def iter_frames(
    path: str,
) -> Iterator[recorded_frame_pb2.RecordedFrame]:
    """Yields each RecordedFrame in the file.

    Transparently skips the optional FileHeader if it's present (detected by
    magic). Older files without a header are accepted too: any record whose
    first parsed FileHeader has an empty/non-matching magic is reinterpreted
    as a RecordedFrame.
    """
    with open(path, 'rb') as fh:
        first = True
        while True:
            prefix = fh.read(_LENGTH_STRUCT.size)
            if not prefix:
                return
            if len(prefix) != _LENGTH_STRUCT.size:
                raise ValueError(
                    f'Truncated length prefix at offset {fh.tell()}'
                )
            (length,) = _LENGTH_STRUCT.unpack(prefix)
            payload = fh.read(length)
            if len(payload) != length:
                raise ValueError(
                    f'Truncated record at offset {fh.tell()} '
                    f'(expected {length} bytes)'
                )
            if first:
                first = False
                # Try parsing as FileHeader; if it's not one, fall through to
                # treating it as a RecordedFrame.
                header = recorded_frame_pb2.FileHeader()
                try:
                    header.ParseFromString(payload)
                except Exception:  # pylint: disable=broad-except
                    header = None
                if header is not None and header.magic == _FILE_HEADER_MAGIC:
                    if header.version != _FORMAT_VERSION:
                        raise ValueError(
                            f'Unsupported recording format version: {header.version}'
                        )
                    continue
            frame = recorded_frame_pb2.RecordedFrame()
            frame.ParseFromString(payload)
            yield frame
