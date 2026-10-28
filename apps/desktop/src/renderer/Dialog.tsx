import { useEffect, useRef, useState, type RefObject } from 'react';

// In-app confirm and notice dialogs (issue #66). Native confirm()/alert() look
// foreign, and on Windows text fields can stop taking focus after one closes
// until the window is refocused. Call ask() or tell() from anywhere; the one
// DialogHost mounted in App shows them one at a time.

type Request = {
  id: number;
  message: string;
  detail?: string;
  confirm: string;
  /** null for a notice with only an OK button. */
  cancel: string | null;
  danger: boolean;
  resolve: (ok: boolean) => void;
};

const queue: Request[] = [];
let wake: (() => void) | null = null;
let nextId = 1;

function open(request: Omit<Request, 'id'>) {
  queue.push({ ...request, id: nextId++ });
  wake?.();
}

/** Asks a yes/no question in the app; resolves true when confirmed. */
export function ask(
  message: string,
  options: { detail?: string; confirm?: string; cancel?: string; danger?: boolean } = {},
): Promise<boolean> {
  return new Promise((resolve) =>
    open({
      message,
      detail: options.detail,
      confirm: options.confirm ?? 'OK',
      cancel: options.cancel ?? 'Cancel',
      danger: options.danger ?? false,
      resolve,
    }),
  );
}

/** Shows a message with an OK button. */
export function tell(message: string, detail?: string): Promise<void> {
  return new Promise((resolve) => open({ message, detail, confirm: 'OK', cancel: null, danger: false, resolve: () => resolve() }));
}

// Escape closes the innermost open thing only: a dialog over a popover over the
// task panel. Each open thing pushes its handler; Escape runs the last one.
const escapeStack: { current: () => void }[] = [];
let listening = false;

function onKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const top = escapeStack[escapeStack.length - 1];
  if (!top) return;
  event.preventDefault();
  top.current();
}

/** Calls onEscape when Escape is pressed and nothing opened later is still open. */
export function useEscape(onEscape: () => void, active = true) {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    if (!active) return;
    const entry = { current: () => handler.current() };
    escapeStack.push(entry);
    if (!listening) {
      window.addEventListener('keydown', onKey);
      listening = true;
    }
    return () => {
      const at = escapeStack.indexOf(entry);
      if (at >= 0) escapeStack.splice(at, 1);
    };
  }, [active]);
}

/** Calls onOutside on a mouse press outside the element (and outside any open dialog). */
export function useClickOutside(ref: RefObject<HTMLElement | null>, onOutside: () => void, active = true) {
  const handler = useRef(onOutside);
  handler.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const down = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || ref.current?.contains(target)) return;
      if ((target as Element).closest?.('.dialog-backdrop')) return;
      handler.current();
    };
    document.addEventListener('mousedown', down);
    return () => document.removeEventListener('mousedown', down);
  }, [ref, active]);
}

export function DialogHost() {
  const [request, setRequest] = useState<Request | null>(queue[0] ?? null);
  useEffect(() => {
    wake = () => setRequest((current) => current ?? queue[0] ?? null);
    wake();
    return () => {
      wake = null;
    };
  }, []);
  if (!request) return null;
  const close = (ok: boolean) => {
    queue.shift();
    request.resolve(ok);
    setRequest(queue[0] ?? null);
  };
  return <ConfirmDialog key={request.id} request={request} onClose={close} />;
}

function ConfirmDialog({ request, onClose }: { request: Request; onClose: (ok: boolean) => void }) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const restore = useRef<Element | null>(document.activeElement);
  useEscape(() => onClose(false));
  useEffect(() => {
    confirmRef.current?.focus();
    const previous = restore.current;
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose(false)}>
      <div className="dialog card" role="alertdialog" aria-modal="true" aria-labelledby="dialog-message">
        <p id="dialog-message" className="dialog-message">
          {request.message}
        </p>
        {request.detail && <p className="dialog-detail muted">{request.detail}</p>}
        <div className="row dialog-actions">
          {request.cancel !== null && (
            <button className="secondary" onClick={() => onClose(false)}>
              {request.cancel}
            </button>
          )}
          <button ref={confirmRef} className={request.danger ? 'danger-solid' : undefined} onClick={() => onClose(true)}>
            {request.confirm}
          </button>
        </div>
      </div>
    </div>
  );
}
