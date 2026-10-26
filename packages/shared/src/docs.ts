import * as Y from 'yjs';
import { z } from 'zod';

// Shared documents: the planning space and project memory. Each is a Yjs
// document, so both people can type in the same text at once, keep editing
// while offline, and have everything merge cleanly when they reconnect. The
// server keeps the merged copy and relays updates; see docs/design/sync.md.

export const DocId = z.enum(['planning', 'memory']);
export type DocId = z.infer<typeof DocId>;

export const DOC_IDS = DocId.options;

/** Largest encoded update or state accepted in one message (base64 characters). */
export const DOC_UPDATE_LIMIT = 900_000;

export const EncodedUpdate = z.string().max(DOC_UPDATE_LIMIT);

export function encodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** An encoded update with nothing in it (no new structs, no deletions). */
export function isEmptyUpdate(update: Uint8Array): boolean {
  return update.length <= 2;
}

/** The items of a document live in one top-level map, keyed by id. */
export function itemsOf(doc: Y.Doc, docId: DocId): Y.Map<Y.Map<unknown>> {
  return doc.getMap(docId === 'planning' ? 'items' : 'entries');
}

/** The one edit that turns `a` into `b`: keep the common start and end, replace the middle. */
export function spliceOf(a: string, b: string): { start: number; removed: number; inserted: string } {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let end = 0;
  while (end < max - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  return { start, removed: a.length - start - end, inserted: b.slice(start, b.length - end) };
}

/**
 * Turns `text` into `next` with the smallest single edit, so a concurrent edit
 * elsewhere in the text survives the merge.
 *
 * With `base` (the text the editor started from), an edit made against an
 * older version still lands in the right place: if someone else's change
 * arrived in the meantime, it is kept and this edit moves around it.
 */
export function setText(text: Y.Text, next: string, base?: string): void {
  const current = text.toString();
  if (current === next) return;
  let edit = spliceOf(current, next);
  if (base !== undefined && base !== current) {
    const mine = spliceOf(base, next);
    const theirs = spliceOf(base, current);
    if (theirs.start + theirs.removed <= mine.start) {
      edit = { ...mine, start: mine.start + theirs.inserted.length - theirs.removed };
    } else if (theirs.start >= mine.start + mine.removed) {
      edit = mine;
    }
    // Overlapping edits: this one wins, as if it came last.
  }
  if (edit.removed > 0) text.delete(edit.start, edit.removed);
  if (edit.inserted) text.insert(edit.start, edit.inserted);
}

/** A plain object of an item map, with Y.Text values read as strings. */
export function readItem(item: Y.Map<unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of item.entries()) {
    out[key] = value instanceof Y.Text ? value.toString() : value;
  }
  return out;
}

/** Every item that still fits the schema; one that does not (say, from a newer version) is skipped. */
export function readItems<T>(doc: Y.Doc, docId: DocId, schema: z.ZodType<T>): T[] {
  const out: T[] = [];
  for (const [id, item] of itemsOf(doc, docId).entries()) {
    if (!(item instanceof Y.Map)) continue;
    const parsed = schema.safeParse({ ...readItem(item), id });
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Sets a text field, creating the Y.Text the first time. */
export function setItemText(item: Y.Map<unknown>, field: string, value: string, base?: string): void {
  let text = item.get(field);
  if (!(text instanceof Y.Text)) {
    text = new Y.Text();
    item.set(field, text);
  }
  setText(text as Y.Text, value, base);
}

export { Y };
