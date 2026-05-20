/**
 * @fileoverview AudioWorkletProcessor that runs on the audio thread, converts
 * Float32 mic samples to Int16 PCM, accumulates them into fixed-size chunks
 * and posts each chunk to the main thread for forwarding to the model.
 *
 * This module is bundled as a standalone JS file (`audio_worklet_bundle.js`)
 * and loaded into the AudioContext via `audioWorklet.addModule(...)`.
 */

// AudioWorkletGlobalScope has no `window` and no `self`, but closure-compiled
// code references `self` to find the global object. Establish it here, before
// any other top-level code runs, so the bundle loads inside the worklet.
// tslint:disable-next-line:no-any  Intentional global property assignment.
(globalThis as any).self = globalThis;

// AudioWorkletProcessor / registerProcessor / sampleRate are part of the
// AudioWorkletGlobalScope and not exposed by the default `lib.dom.d.ts`. See
// https://github.com/microsoft/TypeScript/issues/28308 for context.
interface AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputList: Float32Array[][],
    outputList: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

// tslint:disable-next-line:enforce-name-casing  AudioWorkletGlobalScope global.
declare var AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  new (options?: AudioWorkletNodeOptions): AudioWorkletProcessor;
};

declare function registerProcessor(
  name: string,
  processorCtor: new (
    options?: AudioWorkletNodeOptions,
  ) => AudioWorkletProcessor,
): void;

interface PCMRecorderProcessorOptions extends AudioWorkletNodeOptions {
  // The processorOptions object crosses a Closure-bundle boundary (the
  // worklet is compiled separately from the main script bundle), so the
  // `samplesPerChunk` key must be accessed via bracket notation to avoid
  // property-name renaming. The interface is kept for documentation only;
  // the constructor reads the value with `(options as any)['samplesPerChunk']`.
  processorOptions: {samplesPerChunk: number};
}

/** Float32 [-1, 1] -> Int16 PCM, clamped. */
function floatTo16BitPCM(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

/**
 * Captures audio on the audio thread, converts to L16 PCM and emits buffered
 * chunks of `samplesPerChunk` Int16 samples each (transferred as a Uint8Array
 * view of the underlying buffer).
 */
class PCMRecorderProcessor extends AudioWorkletProcessor {
  private readonly chunkAccumulator: Int16Array;
  private accumulatorIndex = 0;

  constructor(options: PCMRecorderProcessorOptions) {
    super();
    // Read the option with a quoted key so Closure does not rename it:
    // this bundle and the main script bundle are compiled separately, and
    // the main thread sets the option using the literal key
    // 'samplesPerChunk'. Falls back to a sane default if absent.
    // tslint:disable-next-line:no-any closure-safe property access
    const opts = options.processorOptions as any;
    const samplesPerChunk = (opts['samplesPerChunk'] as number) || 4096;
    this.chunkAccumulator = new Int16Array(samplesPerChunk);
  }

  override process(
    inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    // Mono recording: first input, first channel.
    const inputChannel = inputs[0]?.[0];
    if (!inputChannel || inputChannel.length === 0) {
      return true;
    }
    const pcm = floatTo16BitPCM(inputChannel);
    for (let i = 0; i < pcm.length; i++) {
      this.chunkAccumulator[this.accumulatorIndex++] = pcm[i];
      if (this.accumulatorIndex >= this.chunkAccumulator.length) {
        this.emitChunk();
      }
    }
    return true;
  }

  private emitChunk(): void {
    // Copy the accumulator so we can keep writing into it for the next frame.
    // `.slice(0)` on a TypedArray creates a deep copy of the data.
    const int16Copy = this.chunkAccumulator.slice(0);
    // Send the raw ArrayBuffer as the message payload (transferred). The
    // main thread identifies audio chunks by `data instanceof ArrayBuffer`.
    // We avoid a wrapper object because this worklet bundle and the main
    // script bundle are compiled separately by Closure, which renames
    // object properties to different mangled names in each bundle and
    // breaks key-based dispatch.
    this.port.postMessage(int16Copy.buffer, [int16Copy.buffer]);
    this.accumulatorIndex = 0;
  }
}

registerProcessor(
  'pcm-recorder-worklet-processor',
  PCMRecorderProcessor as unknown as new (
    options?: AudioWorkletNodeOptions,
  ) => AudioWorkletProcessor,
);
