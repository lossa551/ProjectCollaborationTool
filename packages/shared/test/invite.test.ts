import { describe, expect, it } from 'vitest';
import { decodeInvite, encodeInvite } from '@pct/shared';

describe('invite codes', () => {
  it('round-trips address, secret and session name', () => {
    const invite = { url: 'ws://100.64.1.2:7420/ws', secret: 's3cr-et_', sessionName: 'Spelprojekt åäö' };
    const code = encodeInvite(invite);
    expect(code.startsWith('pct1.')).toBe(true);
    expect(decodeInvite(`  ${code}\n`)).toEqual(invite);
  });

  it('rejects text that is not an invite', () => {
    expect(decodeInvite('hello')).toBeNull();
    expect(decodeInvite('pct1.not-base64!!')).toBeNull();
    expect(decodeInvite('pct1.' + btoa('{"url":"nope","secret":"x"}'))).toBeNull();
  });
});
