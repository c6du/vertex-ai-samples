/**
 * AudioWorkletProcessor that runs on the audio thread, converts Float32 mic
 * samples to Int16 PCM, accumulates them into fixed-size chunks and posts
 * each chunk to the main thread for forwarding to the model.
 *
 * Bundled as a separate standalone module loaded via
 *   audioContext.audioWorklet.addModule(audioWorkletUrl)
 * where `audioWorkletUrl` is obtained at build time with vite's
 * `?worker&url` or `new URL('./audio_worklet_processor.ts', import.meta.url)`
 * idiom (see audio.ts).
 *
 * NOTE: AudioWorkletGlobalScope is a separate JS realm from the main
 * window. It has no DOM, no `window`, no `XMLHttpRequest`. Keep this file
 * dependency-free and free of imports from other src/ modules.
 */

// AudioWorkletProcessor / registerProcessor / sampleRate are part of the
// AudioWorkletGlobalScope and not exposed by the default `lib.dom.d.ts`.
interface AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputList: Float32Array[][],
    outputList: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

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
 * chunks of `samplesPerChunk` Int16 samples each (transferred as the
 * underlying ArrayBuffer of an Int16Array).
 */
class PCMRecorderProcessor extends AudioWorkletProcessor {
  private readonly chunkAccumulator: Int16Array;
  private accumulatorIndex = 0;

  constructor(options: PCMRecorderProcessorOptions) {
    super();
    const opts = options.processorOptions;
    const samplesPerChunk = opts?.samplesPerChunk || 4096;
    this.chunkAccumulator = new Int16Array(samplesPerChunk);
  }

  override process(
    inputs: Float32Array[][],
    _outputs: Float32Array[][],
    _parameters: Record<string, Float32Array>,
  ): boolean {
    const inputChannel = inputs[0]?.[0];
    if (!inputChannel || inputChannel.length === 0) return true;
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
    const int16Copy = this.chunkAccumulator.slice(0);
    // The main thread identifies audio chunks by `data instanceof ArrayBuffer`.
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
