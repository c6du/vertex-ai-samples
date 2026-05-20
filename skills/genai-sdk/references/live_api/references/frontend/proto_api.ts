/**
 * @fileoverview Browser-side wire format helpers.
 *
 * The browser <-> backend bridge channel uses JSON text frames shaped
 * exactly as the proto3 JSON encoding of the LiveAPI client / server
 * messages. The backend bridge is responsible for translating these
 * JSON frames to/from binary protobuf for the upstream Vertex AI
 * WebSocket (the upstream leg is always binary and is not negotiable).
 *
 * The browser does NOT depend on any proto library — this module just
 * builds plain JS objects and parses incoming JSON. Specifically:
 *
 *   - `bytes` fields are base64-encoded strings (proto3 JSON rule).
 *   - field names are camelCase (proto3 JSON rule).
 *   - enums are encoded as their string names (proto3 JSON rule).
 *   - int64 fields are JSON strings, not numbers (proto3 JSON rule).
 *
 * If a project needs binary protobuf on the browser leg instead, swap
 * the body of `buildRealtimeInputMessage` for a binary encoder, swap
 * `parseServerMessage` for a binary decoder, and flip
 * `websocket_client.ts` to use `ws.binaryType = 'arraybuffer'` and
 * binary `WebSocket.send(...)`. This is the inverse of the
 * JSON-by-default migration; the backend bridge would then forward
 * the binary frames straight through to upstream.
 */

/** Realtime input payload (audio/video/text) the caller hands in. */
export interface RealtimePayload {
  /** For 'audio' and 'video': the IANA mime type, e.g. 'audio/pcm;rate=16000'. */
  mimeType?: string;
  /** For 'audio' and 'video': base64-encoded raw bytes. */
  data?: string;
  /** For 'text': the user-typed text. */
  text?: string;
}

/**
 * Builds a `BidiGenerateContentClientMessage` shaped as proto3 JSON for
 * a single realtime-input frame (audio / video / text).
 *
 * Wire shape:
 *   {"realtimeInput": {"audio": {"mimeType": "...", "data": "<base64>"}}}
 *   {"realtimeInput": {"video": {"mimeType": "image/jpeg", "data": "<base64>"}}}
 *   {"realtimeInput": {"text": "hello"}}
 */
export function buildRealtimeInputMessage(
  kind: 'audio' | 'video' | 'text',
  payload: RealtimePayload,
): string {
  const realtimeInput: Record<string, unknown> = {};
  if (kind === 'audio') {
    realtimeInput['audio'] = {mimeType: payload.mimeType, data: payload.data};
  } else if (kind === 'video') {
    realtimeInput['video'] = {mimeType: payload.mimeType, data: payload.data};
  } else if (kind === 'text') {
    realtimeInput['text'] = payload.text;
  } else {
    throw new Error(`Unsupported realtime input kind: ${kind}`);
  }
  return JSON.stringify({realtimeInput});
}

/**
 * Top-level shape of a `BidiGenerateContentServerMessage` after proto3
 * JSON decoding. All fields are optional — exactly one of the three
 * outer arms (`serverContent`, `toolCall`, `toolCallCancellation`) is
 * populated for any given frame.
 *
 * Only the fields the rest of the frontend actually reads are typed
 * here; the proto carries more.
 */
export interface ServerMessage {
  serverContent?: {
    modelTurn?: {
      parts?: Array<{
        inlineData?: {
          // Base64-encoded bytes per proto3 JSON encoding.
          data?: string;
          mimeType?: string;
        };
        text?: string;
      }>;
    };
    inputTranscription?: {text?: string; finished?: boolean};
    outputTranscription?: {text?: string; finished?: boolean};
    interrupted?: boolean;
    turnComplete?: boolean;
  };
  toolCall?: {
    functionCalls?: Array<{
      name?: string;
      id?: string | null;
      args?: unknown;
    }>;
  };
  toolCallCancellation?: {ids?: string[]};
}

/** Parses an incoming text frame as a `BidiGenerateContentServerMessage`. */
export function parseServerMessage(text: string): ServerMessage {
  return JSON.parse(text) as ServerMessage;
}
