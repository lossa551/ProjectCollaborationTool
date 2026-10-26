import { useEffect, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';
import { spliceOf } from '@pct/shared';

// A textarea bound to text in a shared document. Each edit is sent with the
// text it was made on, so it lands in the right place even if someone else's
// edit got there first. Others' edits show up here without moving your cursor.

/** Live text edits this window has sent; compared with AppState.textEdits. */
let sent = 0;

type Props = {
  value: string;
  /** AppState.textEdits: how many of the window's edits the shared documents have taken. */
  applied: number;
  onEdit: (next: string, base: string) => void;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>;

export function LiveText({ value, applied, onEdit, ...rest }: Props) {
  // After a window reload the count starts over; edits sent before it are long applied.
  if (sent < applied) sent = applied;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(value);
  /** What the next edit is made on: our last edit, or the last shared text we took in. */
  const base = useRef(value);
  const selection = useRef<[number, number] | null>(null);

  useEffect(() => {
    // While our own edits are on the way, the shared text is behind what is on
    // screen; wait for them, since the text after them has others' edits too.
    if (applied < sent || value === text) return;
    const el = ref.current;
    if (el && document.activeElement === el) {
      const edit = spliceOf(text, value);
      const shift = (pos: number) =>
        pos <= edit.start ? pos : pos >= edit.start + edit.removed ? pos + edit.inserted.length - edit.removed : edit.start + edit.inserted.length;
      selection.current = [shift(el.selectionStart), shift(el.selectionEnd)];
    }
    base.current = value;
    setText(value);
    // Only a new shared value matters here; `text` is what was on screen when it arrived.
  }, [value, applied]);

  useLayoutEffect(() => {
    if (selection.current && ref.current) ref.current.setSelectionRange(...selection.current);
    selection.current = null;
  }, [text]);

  return (
    <textarea
      ref={ref}
      value={text}
      onChange={(e) => {
        const next = e.target.value;
        sent++;
        onEdit(next, base.current);
        base.current = next;
        setText(next);
      }}
      {...rest}
    />
  );
}
