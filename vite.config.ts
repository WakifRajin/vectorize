import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works on GitHub Pages (https://<user>.github.io/<repo>/) and any sub-path.
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  optimizeDeps: {
    exclude: ['@imagemagick/magick-wasm'],
  },
});
