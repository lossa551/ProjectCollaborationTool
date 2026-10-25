import { defineConfig, defaultClientConditions } from 'vite';

// Builds the renderer (the window's UI). The main and preload scripts are
// bundled separately by scripts/build.mjs.
export default defineConfig({
  root: 'src/renderer',
  base: './',
  esbuild: { jsx: 'automatic' },
  resolve: { conditions: ['@pct/source', ...defaultClientConditions] },
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
  },
  server: { port: 5173, strictPort: true },
});
