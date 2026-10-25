// Starts the renderer dev server with live reload, then launches Electron
// pointed at it. Changes to main or preload need a restart.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));

await import('./build.mjs');
const vite = await createServer({ configFile: `${root}vite.config.ts` });
await vite.listen();
const url = vite.resolvedUrls?.local[0] ?? 'http://localhost:5173/';

const child = spawn(electronPath, ['.', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});
child.on('exit', async (code) => {
  await vite.close();
  process.exit(code ?? 0);
});
