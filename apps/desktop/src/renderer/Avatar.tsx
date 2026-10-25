import type { ParticipantKind, PresenceStatus } from '@pct/shared';

/** People are circles, agents dashed squares (as in the mockup). */
export function Avatar({
  name,
  kind,
  status,
  small,
}: {
  name: string;
  kind: ParticipantKind;
  status: PresenceStatus | 'offline';
  small?: boolean;
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
      title={`${name} (${status})`}
    >
      {initials}
    </span>
  );
}
