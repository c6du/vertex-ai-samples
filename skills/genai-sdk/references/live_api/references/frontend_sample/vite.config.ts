/**
 * Vite config for the Live API reference frontend.
 *
 * Two bundles are produced:
 *   - `index.html` + `assets/*`: the main app, code-split.
 *   - `audio_worklet_processor.js`: a standalone worklet bundle loaded at
 *     runtime via `audioContext.audioWorklet.addModule(...)`. AudioWorklets
 *     must be a single self-contained script, so we build it as a separate
 *     IIFE entry without code splitting.
 */
import {defineConfig} from 'vite';
import {resolve} from 'node:path';

export default defineConfig({
  root: '.',
  publicDir: false,
  server: {
    port: 5173,
    // Proxy /models, /project_info, /start, /api/*, /ws to the Python backend
    // during `npm run dev`. The Python server runs on :8008 by default.
    proxy: {
      '/models': 'http://localhost:8008',
      '/project_info': 'http://localhost:8008',
      '/start': 'http://localhost:8008',
      '/stop': 'http://localhost:8008',
      '/api': 'http://localhost:8008',
      '/ws': {
        target: 'ws://localhost:8008',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
  worker: {
    format: 'es',
  },
});
