/**
 * Shared frontend constants: audio/video parameters and per-environment
 * defaults for the public Vertex Live API WebSocket endpoint.
 */

/** Microphone capture sample rate (Hz). Matches the model input format. */
export const AUDIO_INPUT_SAMPLE_RATE = 16000;
/** Model audio output sample rate (Hz). */
export const AUDIO_OUTPUT_SAMPLE_RATE = 24000;
/** Target capture chunk size in milliseconds. */
export const AUDIO_CHUNK_INTERVAL_MS = 20;
/** Mono capture / playback. */
export const AUDIO_CHANNEL_COUNT = 1;

const IDEAL_AUDIO_BUFFER_SIZE =
  (AUDIO_CHUNK_INTERVAL_MS / 1000) *
  AUDIO_INPUT_SAMPLE_RATE *
  AUDIO_CHANNEL_COUNT;
/**
 * Number of Int16 samples per chunk emitted by the recorder AudioWorklet.
 * Rounded up to the nearest power of two.
 */
export const AUDIO_BUFFER_SIZE = Math.pow(
  2,
  Math.ceil(Math.log2(IDEAL_AUDIO_BUFFER_SIZE)),
);

/** Interval between sampled video frames sent to the model (ms). */
export const VIDEO_FRAME_INTERVAL_MS = 1000;
/** Max width/height (px) for video frames before downscale. */
export const VIDEO_MAX_DIMENSION = 768;

/**
 * WebSocket backend: hostname suffix per environment. The location prefix
 * (e.g. `us-central1-`) is prepended unless the location is `global`.
 *
 * Matches the public Vertex AI Live API documented at:
 *   https://cloud.google.com/vertex-ai/generative-ai/docs/model-reference/multimodal-live
 */
export const WEBSOCKET_HOST_SUFFIX_BY_ENV: {[key: string]: string} = {
  'prod': 'aiplatform.googleapis.com',
  // Staging is not public; kept as an example for googlers running this
  // reference inside the corp network. Remove if you don't need it.
  'staging': 'staging-aiplatform.sandbox.googleapis.com',
};

/** WebSocket backend: locations users can pick from in the settings modal. */
export const WEBSOCKET_LOCATIONS: string[] = [
  'global',
  'us-central1',
  'us-east1',
  'us-east4',
  'us-east5',
  'us-west1',
  'us-west4',
  'europe-west1',
  'europe-west4',
  'europe-west9',
  'asia-northeast1',
  'asia-southeast1',
  'australia-southeast1',
];

/** Default WebSocket environment selected on first load. */
export const WEBSOCKET_DEFAULT_ENV = 'prod';
/** Default WebSocket location selected on first load. */
export const WEBSOCKET_DEFAULT_LOCATION = 'us-central1';

/**
 * Computes the WebSocket BidiGenerateContent endpoint URL.
 *
 *   wss://[{location}-]{host_suffix}/ws/
 *       google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent
 */
export function computeWebsocketEndpoint(env: string, location: string): string {
  const suffix = WEBSOCKET_HOST_SUFFIX_BY_ENV[env] || '';
  if (!suffix) return '';
  const host =
    location && location !== 'global' ? `${location}-${suffix}` : suffix;
  return (
    `wss://${host}/ws/` +
    'google.cloud.aiplatform.v1beta1.LlmBidiService/BidiGenerateContent'
  );
}
