import type { ParticipantKind, PresenceStatus } from '@pct/shared';

/** People are circles, agents dashed squares (as in the mockup). */
export function Avatar({
  name,
  kind,
  status,
  small,
  title,
}: {
  name: string;
  kind: ParticipantKind;
  status: PresenceStatus | 'offline';
  small?: boolean;
  /** Hover text; defaults to the name and presence. */
  title?: string;
}) {
  const initials = name
    .split(/\s+/)
    .map((part) => part[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <span
      className={`avatar avatar-${kind} presence-${status}${small ? ' avatar-small' : ''}`}
      title={title ?? `${name} (${status})`}
    >
      {initials}
    </span>
  );
}
