// Bundles the Electron main and preload scripts into CommonJS. Workspace
// packages are pulled straight from their TypeScript sources.
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

const common = {
  absWorkingDir: root,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  conditions: ['@pct/source'],
  // ws optionally loads these native speedups; they are not installed.
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  logLevel: 'info',
};

await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.cjs' }),
  build({ ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload.cjs' }),
]);
