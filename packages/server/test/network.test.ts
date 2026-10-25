import { describe, expect, it } from 'vitest';
import { findShareableAddress, isTailscaleAddress } from '@pct/server';

const iface = (address: string, internal = false) => ({
  address,
  internal,
  family: 'IPv4' as const,
  netmask: '255.255.255.0',
  mac: '00:00:00:00:00:00',
  cidr: null,
});

describe('findShareableAddress', () => {
  it('prefers the Tailscale address', () => {
    expect(
      findShareableAddress({ lo: [iface('127.0.0.1', true)], eth0: [iface('192.168.1.10')], ts: [iface('100.101.1.2')] }),
    ).toEqual({ address: '100.101.1.2', source: 'tailscale' });
  });

  it('falls back to LAN, then loopback', () => {
    expect(findShareableAddress({ eth0: [iface('192.168.1.10')] }).source).toBe('lan');
    expect(findShareableAddress({ lo: [iface('127.0.0.1', true)] }).source).toBe('loopback');
  });

  it('knows the Tailscale range', () => {
    expect(isTailscaleAddress('100.64.0.1')).toBe(true);
    expect(isTailscaleAddress('100.127.255.254')).toBe(true);
    expect(isTailscaleAddress('100.128.0.1')).toBe(false);
    expect(isTailscaleAddress('10.0.0.1')).toBe(false);
  });
});
