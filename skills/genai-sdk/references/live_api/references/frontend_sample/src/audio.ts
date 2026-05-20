/**
 * Microphone capture (PCM16 @ 16 kHz) and queued playback of model audio
 * chunks (PCM16 @ 24 kHz). Capture pushes raw PCM frames out through a
 * sender callback; playback pulls audio (and transcription events) from a
 * typed queue that other modules also enqueue into.
 */

import * as constants from './constants.js';
// Vite resolves this URL at build time to the bundled worklet asset, so we
// can load it via `audioContext.audioWorklet.addModule(...)`.
import audioWorkletUrl from './audio_worklet_processor.ts?worker&url';

/** Int16 PCM -> Float32 [-1, 1]. */
function pcm16ToFloat32(int16Array: Int16Array): Float32Array {
  const float32Array = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    float32Array[i] = int16Array[i] / 32768.0;
  }
  return float32Array;
}

/**
 * Items the playback drain loop knows how to handle.
 * Replaces the internal Closure `Queue` with a plain array + typed
 * discriminated union for safety.
 */
export type PlaybackItem =
  | {type: 'audio'; data: Uint8Array}
  | {type: 'transcription'; role: string; text: string; finished: boolean}
  | {type: 'newTranscriptionSignal'; role: string};

/** Handlers invoked by the playback drain loop. */
export interface PlaybackHandlers {
  transcription: (role: string, text: string, finished: boolean) => void;
  newTranscriptionSignal: (role: string) => void;
}

/** Simple FIFO. */
class Queue<T> {
  private readonly items: T[] = [];
  enqueue(item: T): void {
    this.items.push(item);
  }
  dequeue(): T | undefined {
    return this.items.shift();
  }
  peek(): T | undefined {
    return this.items[0];
  }
  isEmpty(): boolean {
    return this.items.length === 0;
  }
  clear(): void {
    this.items.length = 0;
  }
}

/**
 * Owns the playback queue and the AudioContext used for model output. The
 * queue mixes audio with transcription events so the renderer can keep
 * everything in temporal order.
 */
export class PlaybackController {
  private audioContext: AudioContext | null = null;
  private nextBufferStartTime = 0;
  private readonly playbackBuffer = new Queue<PlaybackItem>();

  /** @return The shared playback/event queue. */
  buffer(): Queue<PlaybackItem> {
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
    // Reset the scheduling cursor so audio that arrives after a flush plays
    // immediately rather than after the previously-scheduled tail.
    if (this.audioContext) {
      this.nextBufferStartTime = this.audioContext.currentTime;
    }
  }

  /** Schedules a single decoded audio Uint8Array for back-to-back playback. */
  private playChunk(audioBytes: Uint8Array) {
    if (!this.audioContext) return;
    // Wrap in a fresh buffer view so alignment is guaranteed (Uint8Array may
    // alias bytes from a sub-region of a larger ArrayBuffer).
    const aligned = new Uint8Array(audioBytes);
    const pcmData = new Int16Array(
      aligned.buffer,
      aligned.byteOffset,
      aligned.byteLength / 2,
    );
    const floatData = pcm16ToFloat32(pcmData);
    const audioBuffer = this.audioContext.createBuffer(
      1,
      floatData.length,
      constants.AUDIO_OUTPUT_SAMPLE_RATE,
    );
    // copyToChannel's TS overload is strict about the ArrayBuffer-backed
    // Float32Array variant; create a fresh view to satisfy it.
    audioBuffer.copyToChannel(new Float32Array(floatData), 0);
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
        if (!item) return;
        if (item.type === 'audio') {
          if (
            this.audioContext &&
            this.nextBufferStartTime > this.audioContext.currentTime + 0.5
          ) {
            return;
          }
          const popped = this.playbackBuffer.dequeue();
          if (popped && popped.type === 'audio') this.playChunk(popped.data);
        } else if (item.type === 'transcription') {
          const t = this.playbackBuffer.dequeue();
          if (t && t.type === 'transcription') {
            handlers.transcription(t.role, t.text, t.finished);
          }
        } else if (item.type === 'newTranscriptionSignal') {
          const t = this.playbackBuffer.dequeue();
          if (t && t.type === 'newTranscriptionSignal') {
            handlers.newTranscriptionSignal(t.role);
          }
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
 * Uses an `AudioWorkletNode` that runs PCM conversion on the audio thread
 * (see `audio_worklet_processor.ts`) and posts fixed-size Int16 chunks back
 * over its `MessagePort`.
 */
export class MicCaptureController {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

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
      if (this.context.state === 'suspended') {
        await this.context.resume();
      }
      await this.context.audioWorklet.addModule(audioWorkletUrl);

      this.sourceNode = this.context.createMediaStreamSource(this.stream);
      this.workletNode = new AudioWorkletNode(
        this.context,
        'pcm-recorder-worklet-processor',
        {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 1,
          processorOptions: {
            samplesPerChunk: constants.AUDIO_BUFFER_SIZE,
          },
        },
      );
      // Audio chunks are sent from the worklet as raw transferred
      // ArrayBuffers (one per `samplesPerChunk` Int16 samples).
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
      void this.context.close();
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
