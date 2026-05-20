/**
 * @fileoverview Microphone capture (PCM16 @ 16 kHz) and queued playback of
 * model audio chunks (PCM16 @ 24 kHz). Capture pushes proto frames out
 * through a sender callback; playback pulls audio from a queue that other
 * modules also enqueue transcription / tool events into.
 */

import * as constants from './constants';
import {EventQueue} from './websocket_client';

/** Int16 PCM -> Float32 [-1, 1]. */
function pcm16ToFloat32(int16Array: Int16Array): Float32Array {
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768.0;
  }
  return float32Array;
}

/**
 * Base64-encodes raw bytes. Used to wrap PCM16 / JPEG payloads in the
 * proto3-JSON `bytes` shape the bridge expects (see
 * `client_server_messages.md`).
 */
export function bytesToBase64(bytes: Uint8Array): string {
  // Chunk to stay well under the per-call argument count limit; large
  // typed arrays passed straight into `String.fromCharCode(...)` blow
  // the stack in some browsers.
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, Math.min(i + CHUNK, bytes.length)),
    );
  }
  return btoa(binary);
}

/** Inverse of `bytesToBase64` — decodes the proto3-JSON `bytes` shape. */
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Handlers invoked by the playback drain loop. */
export interface PlaybackHandlers {
  transcription: (role: string, text: string, finished: boolean) => void;
  newTranscriptionSignal: (role: string) => void;
  toolCall: (name: string, id: string | null, args: unknown) => void;
  toolCallCancellation: (ids: string[]) => void;
  toolResponse: (name: string, id: string | null, response: unknown) => void;
}

/**
 * Owns the playback queue and the AudioContext used for model output. The
 * queue mixes audio with transcription/tool events so the renderer can keep
 * everything in temporal order.
 */
export class PlaybackController {
  private audioContext: AudioContext | null = null;
  private nextBufferStartTime = 0;
  private readonly playbackBuffer: EventQueue = new EventQueue();

  /** @return The shared playback/event queue. */
  buffer(): EventQueue {
    return this.playbackBuffer;
  }

  /** Lazily creates the playback AudioContext at the model output rate. */
  ensureContext() {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({
        sampleRate: constants.AUDIO_OUTPUT_SAMPLE_RATE,
      });
    }
  }

  /** Drops all queued events and audio (on interrupt). */
  flush() {
    this.playbackBuffer.clear();
  }

  /**
   * Schedules a single decoded audio chunk for back-to-back playback.
   * `audioBase64` is the proto3-JSON `bytes` payload as it arrived on
   * the wire (base64-encoded PCM16 samples).
   */
  private playChunk(audioBase64: string) {
    if (!this.audioContext) return;
    const rawBytes = base64ToBytes(audioBase64);
    // PCM16 samples are aligned at 2 bytes; wrap the underlying buffer
    // honoring the byteOffset/length we got out of the base64 decode.
    const pcmData = new Int16Array(
      rawBytes.buffer,
      rawBytes.byteOffset,
      rawBytes.byteLength / 2,
    );
    const floatData = pcm16ToFloat32(pcmData);
    const audioBuffer = this.audioContext.createBuffer(
      1,
      floatData.length,
      constants.AUDIO_OUTPUT_SAMPLE_RATE,
    );
    audioBuffer.copyToChannel(floatData, 0);
    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);
    const startTime = Math.max(
      this.audioContext.currentTime,
      this.nextBufferStartTime,
    );
    source.start(startTime);
    this.nextBufferStartTime = startTime + audioBuffer.duration;
  }

  /**
   * Begins draining the queue on a 10 ms tick. Audio is rate-limited to keep
   * at most 0.5 s of buffered playback so interrupts feel responsive.
   */
  startDrainLoop(handlers: PlaybackHandlers) {
    setInterval(() => {
      while (!this.playbackBuffer.isEmpty()) {
        const item = this.playbackBuffer.peek();
        if (item.type === 'audio') {
          if (
            this.audioContext &&
            this.nextBufferStartTime > this.audioContext.currentTime + 0.5
          ) {
            return;
          }
          this.playChunk(this.playbackBuffer.dequeue().data);
        } else if (item.type === 'transcription') {
          const t = this.playbackBuffer.dequeue();
          handlers.transcription(t.role, t.text, t.finished);
        } else if (item.type === 'newTranscriptionSignal') {
          handlers.newTranscriptionSignal(this.playbackBuffer.dequeue().role);
        } else if (item.type === 'toolCall') {
          const tc = this.playbackBuffer.dequeue();
          handlers.toolCall(tc.name, tc.id, tc.args);
        } else if (item.type === 'toolCallCancellation') {
          handlers.toolCallCancellation(this.playbackBuffer.dequeue().ids);
        } else if (item.type === 'toolResponse') {
          const tr = this.playbackBuffer.dequeue();
          handlers.toolResponse(tr.name, tr.id, tr.response);
        } else {
          this.playbackBuffer.dequeue();
        }
      }
    }, 10);
  }
}

/**
 * Captures the user's microphone and forwards PCM16 chunks via `sendFrame`.
 *
 * Uses an `AudioWorkletNode` that runs the PCM conversion on the audio thread
 * (see `audio_worklet_processor.ts`) and posts fixed-size Int16 chunks back
 * over its `MessagePort`.
 */
export class MicCaptureController {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  /**
   * @param canSend Returns true while it's safe to forward audio
   *     (session active and websocket open).
   * @param sendFrame Called with raw PCM16 bytes to be wrapped/sent by the
   *     caller.
   */
  constructor(
    private readonly canSend: () => boolean,
    private readonly sendFrame: (audioBytes: Uint8Array) => void,
    private readonly showStatus: (msg: string, isError?: boolean) => void,
  ) {}

  async start(deviceId: string) {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: {exact: deviceId},
          sampleRate: constants.AUDIO_INPUT_SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      this.context = new AudioContext({
        sampleRate: constants.AUDIO_INPUT_SAMPLE_RATE,
      });
      // Chrome's autoplay policy can leave the context in `suspended` state
      // until an explicit resume; nothing flows through the worklet
      // otherwise.
      if (this.context.state === 'suspended') {
        await this.context.resume();
      }
      // Load the worklet bundle. The path is the static URL served by the
      // backend (see `frontend_files` in BUILD).
      await this.context.audioWorklet.addModule('audio_worklet_bundle.js');

      this.sourceNode = this.context.createMediaStreamSource(this.stream);
      // We give the node 1 output channel and connect it to the destination
      // even though we don't actually want to play the mic back to the
      // speakers: a worklet with `numberOfOutputs: 0` is treated as a sink
      // and may not be pulled by the audio graph in all browsers. The
      // worklet's `process()` returns silence on its output, so connecting
      // to `destination` is inaudible.
      this.workletNode = new AudioWorkletNode(
        this.context,
        'pcm-recorder-worklet-processor',
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          // Quoted key so Closure does not rename it: the worklet is
          // compiled into a separate bundle and reads this with bracket
          // notation.
          processorOptions: {
            // tslint:disable-next-line:enforce-name-casing closure-safe key
            ['samplesPerChunk']: constants.AUDIO_BUFFER_SIZE,
          },
        },
      );
      // Audio chunks are sent from the worklet as raw transferred
      // ArrayBuffers (one per `samplesPerChunk` Int16 samples). We avoid a
      // wrapper object because this worklet bundle and the main script
      // bundle are compiled separately by Closure, which renames object
      // properties to different mangled names in each bundle.
      this.workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        if (!(event.data instanceof ArrayBuffer)) return;
        if (!this.canSend()) return;
        this.sendFrame(new Uint8Array(event.data));
      };
      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.context.destination);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('Failed to start audio streaming:', err);
      this.showStatus(`Audio error: ${message}`, true);
      this.stop();
      throw err;
    }
  }

  /** Tears down the capture pipeline; safe to call when nothing is running. */
  stop() {
    if (this.workletNode) {
      this.workletNode.port.onmessage = null;
      this.workletNode.disconnect();
      this.workletNode = null;
    }
    if (this.sourceNode) {
      this.sourceNode.disconnect();
      this.sourceNode = null;
    }
    if (this.context) {
      this.context.close();
      this.context = null;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) {
        t.stop();
      }
      this.stream = null;
    }
  }
}
