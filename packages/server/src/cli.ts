#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { SOCKET_PATH, encodeInvite } from '@pct/shared';
import { findShareableAddress } from './network.js';
import { startServer } from './server.js';

// Standalone server, for a hosted machine or running without the desktop app.
// Configured through environment variables:
//   PCT_PORT (7420), PCT_HOST (0.0.0.0), PCT_SECRET (generated),
//   PCT_SESSION_NAME, PCT_PUBLIC_HOST (address put in the invite code),
//   PCT_TLS_KEY / PCT_TLS_CERT (paths to PEM files, enables wss://)

const env = process.env;
const tls =
  env.PCT_TLS_KEY && env.PCT_TLS_CERT
    ? { key: readFileSync(env.PCT_TLS_KEY), cert: readFileSync(env.PCT_TLS_CERT) }
    : undefined;

const server = await startServer({
  port: env.PCT_PORT ? Number(env.PCT_PORT) : undefined,
  host: env.PCT_HOST,
  secret: env.PCT_SECRET,
  sessionName: env.PCT_SESSION_NAME,
  tls,
  log: (line) => console.log(`[${new Date().toISOString()}] ${line}`),
});

const shareable = env.PCT_PUBLIC_HOST
  ? { address: env.PCT_PUBLIC_HOST, source: 'configured' }
  : findShareableAddress();
const url = `${tls ? 'wss' : 'ws'}://${shareable.address}:${server.port}${SOCKET_PATH}`;

console.log(`Session "${server.session.name}" listening on port ${server.port}`);
console.log(`Address for invites: ${url} (${shareable.source})`);
console.log(`Invite code:\n\n  ${encodeInvite({ url, secret: server.secret, sessionName: server.session.name })}\n`);
if (shareable.source === 'loopback') {
  console.log('No network address found; only this machine can connect. Is Tailscale running?');
}

const shutdown = () => {
  console.log('Shutting down');
  void server.close().then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
