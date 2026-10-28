// Bundles the Electron main and preload scripts into CommonJS. Workspace
// packages are pulled straight from their TypeScript sources.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
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

// Claude Code runs this hook script itself (through Electron as Node), so it
// ships as a plain file next to main.cjs rather than inside the bundle.
mkdirSync(`${root}dist`, { recursive: true });
copyFileSync(`${root}../../packages/agents/bin/pct-hook.cjs`, `${root}dist/pct-hook.cjs`);

// Window and tray icons, loaded from disk at runtime. The installer icon is
// picked up by electron-builder from build/ directly.
for (const file of ['icon.png', 'tray.png', 'tray@2x.png']) copyFileSync(`${root}build/${file}`, `${root}dist/${file}`);
