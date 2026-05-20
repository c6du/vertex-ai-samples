/**
 * @fileoverview WebSocket client. Connects to `/ws`, exchanges JSON
 * text frames with the backend bridge, and pushes the resulting events
 * onto a playback queue (audio, transcription, tool call/response/
 * cancellation). Lifecycle hooks notify the caller about open/close so
 * the rest of the UI (status indicator, button state) can react.
 *
 * Wire format
 * -----------
 * Every frame on this WebSocket is a JSON text frame:
 *
 *   - Browser -> bridge: proto3-JSON-encoded
 *     `BidiGenerateContentClientMessage` (see `proto_api.ts`).
 *   - Bridge -> browser: proto3-JSON-encoded
 *     `BidiGenerateContentServerMessage` (the bridge converts the
 *     binary upstream frames to JSON) PLUS out-of-band
 *     `{type: 'tool_response', ...}` events emitted by the bridge
 *     when it executes a tool locally.
 *
 * The browser never sees a protobuf binary; the bridge owns the
 * binary <-> JSON translation. See `references/backend_bridge.md`
 * and `references/client_server_messages.md`.
 */

import * as protoApi from './proto_api';

interface WebSocketHooks {
  onOpen: () => void;
  /** Receives whether a session was active when the close fired. */
  onClose: (hadActiveSession: boolean) => void;
}

/**
 * Minimal FIFO queue. The playback drain loop reads from this queue
 * and pushes events back into the UI / audio output.
 */
// tslint:disable-next-line:no-any structurally-typed event payloads
export class EventQueue<T = any> {
  private readonly items: T[] = [];

  enqueue(item: T) {
    this.items.push(item);
  }

  dequeue(): T | undefined {
    return this.items.shift();
  }

  peek(): T | undefined {
    return this.items[0];
  }

  clear() {
    this.items.length = 0;
  }

  isEmpty(): boolean {
    return this.items.length === 0;
  }

  getCount(): number {
    return this.items.length;
  }
}

/** WebSocket bridge between the browser and the LiveAPI backend bridge. */
export class WebSocketClient {
  private ws: WebSocket | null = null;
  private sessionStarted = false;

  /**
   * @param buffer Shared queue audio/transcription drain off.
   */
  constructor(
    private readonly sessionId: string,
    private readonly buffer: EventQueue,
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
   * Sends a realtime input frame (audio/video/text) as a JSON text
   * frame. Silently no-ops if the socket isn't open.
   */
  sendRealtime(
    kind: 'audio' | 'video' | 'text',
    payload: protoApi.RealtimePayload,
  ) {
    if (!this.isOpen()) return;
    this.ws!.send(protoApi.buildRealtimeInputMessage(kind, payload));
  }

  /** Opens the websocket and wires up event handlers. */
  connect() {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ws?session_id=${
      this.sessionId
    }`;
    this.ws = new WebSocket(wsUrl);
    this.sessionStarted = true;
    this.ws.onopen = () => {
      this.showStatus('Session connected.', false);
      this.hooks.onOpen();
    };
    this.ws.onmessage = (event) => {
      this.onMessage(event);
    };
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
    // Every frame is a JSON text frame. Binary frames are not expected
    // and are silently dropped.
    if (typeof event.data !== 'string') {
      console.warn('Dropping unexpected binary WS frame');
      return;
    }
    // Out-of-band bridge events have a `type` discriminator and are
    // not proto-shaped (e.g. tool responses executed by the bridge).
    // Real server messages have no `type` field — they are proto3
    // JSON encodings of `BidiGenerateContentServerMessage`.
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch (e) {
      console.error('Failed to parse WS text frame:', e);
      return;
    }
    if (this.handleBridgeEvent(parsed)) return;
    this.handleServerMessage(parsed as protoApi.ServerMessage);
  }

  /**
   * Handles out-of-band events emitted by the backend bridge. Returns
   * true if the frame was a bridge event (and thus consumed).
   */
  private handleBridgeEvent(parsed: unknown): boolean {
    if (!parsed || typeof parsed !== 'object') return false;
    const obj = parsed as {type?: string; [k: string]: unknown};
    if (typeof obj.type !== 'string') return false;
    if (obj.type === 'tool_response') {
      this.buffer.enqueue({
        type: 'toolResponse',
        name: obj['name'],
        id: obj['id'] ?? null,
        response: obj['response'],
      });
      return true;
    }
    // Unknown discriminator -> ignore.
    return true;
  }

  /**
   * Handles a proto3-JSON-encoded `BidiGenerateContentServerMessage`.
   * See `proto_api.ts` for the shape; the field accessors below
   * mirror the proto field names in camelCase.
   */
  private handleServerMessage(msg: protoApi.ServerMessage) {
    try {
      if (msg.toolCall) {
        for (const fc of msg.toolCall.functionCalls ?? []) {
          this.buffer.enqueue({
            type: 'toolCall',
            name: fc.name,
            id: fc.id ?? null,
            args: fc.args ?? null,
          });
        }
      }
      if (msg.toolCallCancellation) {
        this.buffer.enqueue({
          type: 'toolCallCancellation',
          ids: msg.toolCallCancellation.ids ?? [],
        });
      }

      const sc = msg.serverContent;
      if (!sc) return;

      if (sc.modelTurn) {
        for (const part of sc.modelTurn.parts ?? []) {
          const inline = part.inlineData;
          if (
            inline &&
            typeof inline.mimeType === 'string' &&
            inline.mimeType.startsWith('audio/') &&
            typeof inline.data === 'string'
          ) {
            // `inline.data` is base64 per proto3 JSON encoding. The
            // playback controller handles base64 -> PCM16 decode.
            this.buffer.enqueue({type: 'audio', data: inline.data});
          }
        }
      }
      if (sc.inputTranscription) {
        this.buffer.enqueue({
          type: 'transcription',
          role: 'user',
          text: sc.inputTranscription.text ?? '',
          finished: !!sc.inputTranscription.finished,
        });
      }
      if (sc.outputTranscription) {
        this.buffer.enqueue({
          type: 'transcription',
          role: 'model',
          text: sc.outputTranscription.text ?? '',
          finished: !!sc.outputTranscription.finished,
        });
      }
      if (sc.interrupted) {
        this.buffer.clear();
      }
      if (sc.turnComplete) {
        this.buffer.enqueue({type: 'newTranscriptionSignal', role: 'model'});
        this.buffer.enqueue({type: 'newTranscriptionSignal', role: 'user'});
      }
    } catch (e) {
      console.error('Failed to handle server message:', e);
    }
  }
}
