import { describe, expect, it } from 'vitest';
import { parseClientMessage, parseServerMessage } from '@pct/shared';

describe('protocol parsing', () => {
  it('accepts a valid hello', () => {
    const msg = parseClientMessage(
      JSON.stringify({ type: 'hello', protocol: 1, secret: 'x', name: ' Martin ', kind: 'human' }),
    );
    expect(msg).toEqual({ type: 'hello', protocol: 1, secret: 'x', name: 'Martin', kind: 'human' });
  });

  it('rejects malformed or unknown messages', () => {
    expect(parseClientMessage('{oops')).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'nuke' }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: 'hello', protocol: 1, secret: 'x', name: '', kind: 'human' }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: 'pong' }))).toBeNull();
  });
});
