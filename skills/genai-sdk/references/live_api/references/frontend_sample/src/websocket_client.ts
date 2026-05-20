/**
 * WebSocket client. Connects to /ws on the local server, encodes outgoing
 * ClientMessage frames as binary protobuf, decodes incoming ServerMessage
 * frames, and pushes the resulting events onto a typed playback queue.
 *
 * Wire format on /ws (browser <-> local server):
 *   binary protobuf frames, both directions
 *   - browser sends `ClientMessage` (binary)
 *   - server sends `ServerMessage` (binary)
 *
 * The local server translates these to/from the public Vertex Live API's
 * JSON-over-WebSocket format. Doing binary here keeps the schema typed and
 * the JSON parsing cost off the browser hot path.
 */

import {fromBinary, toBinary, create} from '@bufbuild/protobuf';
import {
  ClientMessageSchema,
  ServerMessageSchema,
  BlobSchema,
} from '../gen/client_server_messages_pb.js';
import type {PlaybackItem} from './audio.js';

/** Realtime input payload variants the caller may send. */
export type RealtimePayload =
  | {kind: 'audio'; mimeType: string; data: Uint8Array}
  | {kind: 'video'; mimeType: string; data: Uint8Array}
  | {kind: 'text'; text: string};

interface WebSocketHooks {
  onOpen: () => void;
  /** Receives whether a session was active when the close fired. */
  onClose: (hadActiveSession: boolean) => void;
}

/** FIFO interface as exposed by `PlaybackController.buffer()`. */
interface Buffer {
  enqueue(item: PlaybackItem): void;
  clear(): void;
}

/** WebSocket bridge between the browser and the local proxy server. */
export class WebSocketClient {
  private ws: WebSocket | null = null;
  private sessionStarted = false;

  constructor(
    private readonly sessionId: string,
    private readonly buffer: Buffer,
    private readonly showStatus: (msg: string, isError?: boolean) => void,
    private readonly hooks: WebSocketHooks,
  ) {}

  /** Returns whether the underlying WebSocket is currently OPEN. */
  isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** Returns whether a session has been started (socket may still connect). */
  isSessionActive(): boolean {
    return this.sessionStarted;
  }

  /**
   * Sends a realtime input frame (audio/video/text). Silently no-ops if the
   * socket isn't open. The wire encoding follows the public Live API's
   * `BidiGenerateContentRealtimeInput` shape with typed `audio` / `video` /
   * `text` fields (rather than the older `media_chunks` form).
   */
  sendRealtime(payload: RealtimePayload) {
    if (!this.isOpen() || !this.ws) return;
    const msg = create(ClientMessageSchema, {
      messageType: {
        case: 'realtimeInput',
        value:
          payload.kind === 'text'
            ? {text: payload.text}
            : payload.kind === 'audio'
              ? {audio: create(BlobSchema, {mimeType: payload.mimeType, data: payload.data})}
              : {video: create(BlobSchema, {mimeType: payload.mimeType, data: payload.data})},
      },
    });
    this.ws.send(toBinary(ClientMessageSchema, msg));
  }

  /** Opens the websocket and wires up event handlers. */
  connect() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl =
      `${wsProtocol}//${window.location.host}/ws?session_id=` +
      encodeURIComponent(this.sessionId);
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';
    this.sessionStarted = true;
    this.ws.onopen = () => {
      this.showStatus('Session connected.', false);
      this.hooks.onOpen();
    };
    this.ws.onmessage = (event) => this.onMessage(event);
    this.ws.onerror = (error) => {
      console.error('WebSocket error:', error);
      this.showStatus('WebSocket error.', true);
    };
    this.ws.onclose = () => {
      const hadActiveSession = this.sessionStarted;
      if (this.sessionStarted && this.ws) {
        this.showStatus('WebSocket closed unexpectedly.', true);
      }
      this.ws = null;
      this.sessionStarted = false;
      this.hooks.onClose(hadActiveSession);
    };
  }

  /** Closes the socket, if open. */
  close() {
    if (this.ws) this.ws.close();
  }

  private onMessage(event: MessageEvent) {
    if (!(event.data instanceof ArrayBuffer)) {
      // The server never sends text frames; ignore unexpected ones.
      console.warn('Ignoring unexpected non-binary WS frame.');
      return;
    }
    let decoded;
    try {
      decoded = fromBinary(ServerMessageSchema, new Uint8Array(event.data));
    } catch (e) {
      console.error('Failed to decode incoming ServerMessage:', e);
      return;
    }

    const mt = decoded.messageType;
    if (mt.case !== 'serverContent') {
      // setupComplete, usageMetadata, goAway, sessionResumptionUpdate,
      // toolCall and toolCallCancellation are surfaced by the server but
      // not consumed by the chat UI in this reference build.
      return;
    }
    const sc = mt.value;

    // Stream model audio: walk modelTurn.parts and enqueue inline audio.
    if (sc.modelTurn) {
      for (const part of sc.modelTurn.parts) {
        if (
          part.data.case === 'inlineData' &&
          part.data.value.mimeType.startsWith('audio/')
        ) {
          this.buffer.enqueue({type: 'audio', data: part.data.value.data});
        }
      }
    }
    if (sc.inputTranscription) {
      this.buffer.enqueue({
        type: 'transcription',
        role: 'user',
        text: sc.inputTranscription.text,
        // The reconstructed proto's Transcription message has no `finished`
        // field (the public docs don't expose one); use turnComplete /
        // generationComplete on the enclosing serverContent as the bubble
        // boundary signal below.
        finished: false,
      });
    }
    if (sc.outputTranscription) {
      this.buffer.enqueue({
        type: 'transcription',
        role: 'model',
        text: sc.outputTranscription.text,
        finished: false,
      });
    }
    if (sc.interrupted) {
      // Drop queued audio so playback yields to the user immediately.
      this.buffer.clear();
    }
    if (sc.turnComplete) {
      // End both bubbles so the next exchange starts fresh.
      this.buffer.enqueue({type: 'newTranscriptionSignal', role: 'model'});
      this.buffer.enqueue({type: 'newTranscriptionSignal', role: 'user'});
    }
  }
}
