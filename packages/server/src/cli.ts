#!/usr/bin/env node
import './quiet-warnings.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SOCKET_PATH, encodeInvite } from '@pct/shared';
import { tokenFromGitHubCli } from './github.js';
import { findShareableAddress } from './network.js';
import { startServer } from './server.js';
import { SqliteStorage } from './sqlite.js';

// Standalone server, for a hosted machine or running without the desktop app.
// Configured through environment variables:
//   PCT_PORT (7420), PCT_HOST (0.0.0.0),
//   PCT_DB (SQLite file, default data/session.sqlite; ":memory:" keeps nothing),
//   PCT_SECRET (default: generated once and saved in the database),
//   PCT_SESSION_NAME, PCT_PUBLIC_HOST (address put in the invite code),
//   PCT_TLS_KEY / PCT_TLS_CERT (paths to PEM files, enables wss://)
//   PCT_GITHUB_TOKEN or GITHUB_TOKEN (default: the GitHub CLI's token, if signed in)

const env = process.env;
const tls =
  env.PCT_TLS_KEY && env.PCT_TLS_CERT
    ? { key: readFileSync(env.PCT_TLS_KEY), cert: readFileSync(env.PCT_TLS_CERT) }
    : undefined;

const dbPath = env.PCT_DB === ':memory:' ? ':memory:' : resolve(env.PCT_DB ?? 'data/session.sqlite');
const storage = new SqliteStorage(dbPath);

const githubToken = env.PCT_GITHUB_TOKEN || env.GITHUB_TOKEN || (await tokenFromGitHubCli());

const server = await startServer({
  storage,
  port: env.PCT_PORT ? Number(env.PCT_PORT) : undefined,
  host: env.PCT_HOST,
  secret: env.PCT_SECRET,
  sessionName: env.PCT_SESSION_NAME,
  tls,
  github: { token: githubToken },
  log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
});

const shareable = env.PCT_PUBLIC_HOST
  ? { address: env.PCT_PUBLIC_HOST, source: 'configured' }
  : findShareableAddress();
const url = `${tls ? 'wss' : 'ws'}://${shareable.address}:${server.port}${SOCKET_PATH}`;

console.log(`Session "${server.session.name}" listening on port ${server.port}`);
console.log(`Saved in ${dbPath === ':memory:' ? 'memory only (nothing is kept)' : dbPath}`);
console.log(`Address for invites: ${url} (${shareable.source})`);
console.log(`Invite code:\n\n  ${encodeInvite({ url, secret: server.secret, sessionName: server.session.name, sessionId: server.session.id })}\n`);
console.log(
  githubToken
    ? 'GitHub: using a token.'
    : 'GitHub: no token, so status updates every 10 minutes and private repositories are not visible. Set PCT_GITHUB_TOKEN.',
);
if (shareable.source === 'loopback') {
  console.log('No network address found; only this machine can connect. Is Tailscale running?');
}

const shutdown = () => {
  console.log('Shutting down');
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
