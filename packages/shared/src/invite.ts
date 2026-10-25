import { z } from 'zod';

// An invite code bundles the server address and the session secret into one
// string the host can paste to a friend. It is a credential: anyone holding it
// can join the session.

const PREFIX = 'pct1.';

const InvitePayload = z.object({
  /** WebSocket URL of the session server, e.g. ws://100.101.102.103:7420/ws */
  url: z.string().url(),
  secret: z.string().min(1),
  sessionName: z.string().optional(),
});
export type Invite = z.infer<typeof InvitePayload>;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(encoded: string): string {
  const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

export function encodeInvite(invite: Invite): string {
  return PREFIX + toBase64Url(JSON.stringify(InvitePayload.parse(invite)));
}

/** Returns null when the text is not a valid invite code. */
export function decodeInvite(code: string): Invite | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith(PREFIX)) return null;
  try {
    const result = InvitePayload.safeParse(JSON.parse(fromBase64Url(trimmed.slice(PREFIX.length))));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
