import { networkInterfaces } from 'node:os';

// Picks the address a friend should use to reach this PC. A Tailscale address
// (100.64.0.0/10) wins, since that is how the friend reaches the host.

export interface ShareableAddress {
  address: string;
  source: 'tailscale' | 'lan' | 'loopback';
}

export function isTailscaleAddress(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}

export function findShareableAddress(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): ShareableAddress {
  const ipv4 = Object.values(interfaces)
    .flatMap((list) => list ?? [])
    .filter((info) => info.family === 'IPv4' && !info.internal)
    .map((info) => info.address);

  const tailscale = ipv4.find(isTailscaleAddress);
  if (tailscale) return { address: tailscale, source: 'tailscale' };
  const lan = ipv4[0];
  if (lan) return { address: lan, source: 'lan' };
  return { address: '127.0.0.1', source: 'loopback' };
}
