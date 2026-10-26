import { useEffect, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react';
import { spliceOf } from '@pct/shared';

// A textarea bound to text in a shared document. Each edit is sent with the
// text it was made on, so it lands in the right place even if someone else's
// edit got there first; their edits show up here without moving your cursor.

type Props = {
  value: string;
  onEdit: (next: string, base: string) => void;
} & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'>;

export function LiveText({ value, onEdit, ...rest }: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState(value);
  /** The text the next edit is made on: our last edit, or the last shared version we took in. */
  const base = useRef(value);
  /** Our edits on their way through the shared document; they come back as `value`. */
  const echoes = useRef<string[]>([]);
  const selection = useRef<[number, number] | null>(null);

  useEffect(() => {
    const echo = echoes.current.indexOf(value);
    if (echo >= 0) {
      echoes.current.splice(0, echo + 1);
      return;
    }
    if (value === text) return;
    // Someone else's edit: take it in, keeping the cursor on the same words.
    const el = ref.current;
    if (el && document.activeElement === el) {
      const edit = spliceOf(text, value);
      const shift = (pos: number) =>
        pos <= edit.start ? pos : pos >= edit.start + edit.removed ? pos + edit.inserted.length - edit.removed : edit.start + edit.inserted.length;
      selection.current = [shift(el.selectionStart), shift(el.selectionEnd)];
    }
    echoes.current = [];
    base.current = value;
    setText(value);
    // Only a new shared value matters here; `text` is what was on screen when it arrived.
  }, [value]);

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
        onEdit(next, base.current);
        base.current = next;
        echoes.current.push(next);
        setText(next);
      }}
      {...rest}
    />
  );
}
