import { Notification } from 'electron';
import { NOTICE_KINDS, NoticeTracker, type NeedTarget, type Notice, type NoticeInput, type NoticeKind } from '@pct/shared';
import { mutedNotices, saveMutedNotice } from './settings';

// Windows toasts for what needs you while the app is in the background (issue
// #35). While the window has focus nothing pops up: the Home count shows it.

/** More new things than this at once become one summary toast. */
const MAX_TOASTS = 3;

export interface NotifierHooks {
  /** Whether the person is looking at the app right now. */
  focused(): boolean;
  /** Brings the window forward and opens what the toast was about. */
  open(target: NeedTarget | null): void;
}

export class Notifier {
  private tracker = new NoticeTracker();
  /** Toasts still on screen; Windows drops click handlers of collected ones. */
  private live = new Set<Notification>();

  constructor(private hooks: NotifierHooks) {}

  muted(): NoticeKind[] {
    const kinds = new Set(NOTICE_KINDS.map((k) => k.kind));
    return mutedNotices().filter((k): k is NoticeKind => kinds.has(k as NoticeKind));
  }

  setMuted(kind: unknown, muted: unknown) {
    if (!NOTICE_KINDS.some((k) => k.kind === kind) || typeof muted !== 'boolean') return;
    saveMutedNotice(kind as NoticeKind, muted);
  }

  /** Call on every session change; new things become toasts. */
  update(input: NoticeInput, joiner: boolean) {
    const fresh = this.tracker.update(input, { joiner });
    if (fresh.length === 0 || this.hooks.focused() || !Notification.isSupported()) return;
    const muted = new Set(this.muted());
    const shown = fresh.filter((n) => !muted.has(n.kind));
    for (const notice of shown.slice(0, MAX_TOASTS)) this.show(notice);
    const rest = shown.length - MAX_TOASTS;
    if (rest > 0) {
      this.show({ key: 'more', kind: 'approval', title: `${rest} more ${rest === 1 ? 'thing needs' : 'things need'} you`, body: 'See Home in the app.', target: null });
    }
  }

  test() {
    this.show({ key: 'test', kind: 'approval', title: 'Notifications work', body: 'This is how the app tells you when something needs you.', target: null });
  }

  private show(notice: Notice) {
    const toast = new Notification({ title: notice.title, body: notice.body });
    this.live.add(toast);
    toast.on('click', () => {
      this.live.delete(toast);
      this.hooks.open(notice.target);
    });
    toast.on('close', () => this.live.delete(toast));
    toast.show();
  }
}
