import * as Y from 'yjs';
import { z } from 'zod';
import { itemsOf, readItems, setItemText } from './docs.js';

// Project memory (screen 6): what everyone, people and agents, should know
// about the project. Kept in a shared Yjs document like the planning space,
// and given to every agent as part of its context.

export const MemoryKind = z.enum(['decision', 'convention', 'issue', 'plan']);
export type MemoryKind = z.infer<typeof MemoryKind>;

export const MEMORY_KIND_LABELS: Record<MemoryKind, string> = {
  decision: 'Architecture decisions',
  convention: 'Conventions',
  issue: 'Known issues',
  plan: 'Current plans',
};

export const MEMORY_KIND_SINGULAR: Record<MemoryKind, string> = {
  decision: 'Decision',
  convention: 'Convention',
  issue: 'Known issue',
  plan: 'Plan',
};

export const MemoryTitle = z.string().trim().min(1).max(200);
export const MEMORY_TEXT_LIMIT = 20_000;

/** Where an entry came from, when it was not written by hand. */
export const MemorySource = z.object({
  kind: z.enum(['chat', 'bloat']),
  /** The chat id, for an entry saved from an agent chat. */
  id: z.string().max(64).nullable(),
  title: z.string().max(200),
});
export type MemorySource = z.infer<typeof MemorySource>;

export const MemoryEntry = z.object({
  id: z.string(),
  kind: MemoryKind,
  title: z.string().max(200),
  body: z.string().default(''),
  createdBy: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  source: MemorySource.nullable().default(null),
});
export type MemoryEntry = z.infer<typeof MemoryEntry>;

const EntryId = z.string().min(8).max(64);

export const MemoryOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('create'),
    id: EntryId,
    kind: MemoryKind,
    title: MemoryTitle,
    body: z.string().max(MEMORY_TEXT_LIMIT).optional(),
    source: MemorySource.nullable().optional(),
  }),
  z.object({ op: z.literal('set'), id: EntryId, kind: MemoryKind.optional(), title: MemoryTitle.optional() }),
  z.object({
    op: z.literal('text'),
    id: EntryId,
    value: z.string().max(MEMORY_TEXT_LIMIT),
    /** The text the editor started from; see setText. */
    base: z.string().max(MEMORY_TEXT_LIMIT).optional(),
  }),
  z.object({ op: z.literal('delete'), id: EntryId }),
]);
export type MemoryOp = z.infer<typeof MemoryOp>;

export function readMemory(doc: Y.Doc): MemoryEntry[] {
  return readItems(doc, 'memory', MemoryEntry).sort((a, b) => a.createdAt - b.createdAt);
}

/** Applies a change; returns false when the entry it refers to is gone. */
export function applyMemoryOp(doc: Y.Doc, op: MemoryOp, by: string, now = Date.now()): boolean {
  const entries = itemsOf(doc, 'memory');
  let ok = true;
  doc.transact(() => {
    if (op.op === 'create') {
      if (entries.has(op.id)) return;
      const entry = new Y.Map<unknown>();
      entries.set(op.id, entry);
      entry.set('kind', op.kind);
      entry.set('title', op.title);
      entry.set('createdBy', by);
      entry.set('createdAt', now);
      entry.set('updatedAt', now);
      entry.set('source', op.source ?? null);
      entry.set('body', new Y.Text(op.body ?? ''));
      return;
    }
    const entry = entries.get(op.id);
    if (!(entry instanceof Y.Map)) {
      ok = false;
      return;
    }
    switch (op.op) {
      case 'set':
        if (op.kind) entry.set('kind', op.kind);
        if (op.title) entry.set('title', op.title);
        break;
      case 'text':
        setItemText(entry, 'body', op.value, op.base);
        break;
      case 'delete':
        entries.delete(op.id);
        return;
    }
    entry.set('updatedAt', now);
  });
  return ok;
}

/** Project memory as text, the way an agent reads it. Empty when there is none. */
export function renderMemory(entries: MemoryEntry[]): string {
  const sections: string[] = [];
  for (const kind of MemoryKind.options) {
    const own = entries.filter((e) => e.kind === kind);
    if (own.length === 0) continue;
    const lines = own.map((e) => {
      const body = e.body.trim();
      return body ? `- ${e.title}\n${body.replace(/^/gm, '  ')}` : `- ${e.title}`;
    });
    sections.push(`${MEMORY_KIND_LABELS[kind]}:\n${lines.join('\n')}`);
  }
  return sections.join('\n\n');
}

/** Where project memory is written in the repository, for people and CLI agents that read repo files. */
export const MEMORY_EXPORT_PATH = 'docs/project-memory.md';

/**
 * Project memory as a Markdown file for the repository. It depends only on
 * the entries (dates in UTC), so both people's copies come out the same and
 * committing it from either PC never conflicts.
 */
export function memoryMarkdown(entries: MemoryEntry[]): string {
  const out = [
    '# Project memory',
    '',
    '<!-- Written by Foreus from the session\'s project memory. Edit entries in the app: changes made here are overwritten. -->',
    '',
    'What everyone working on this project, people and agents, should know about it.',
  ];
  const sorted = [...entries].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const kind of MemoryKind.options) {
    out.push('', `## ${MEMORY_KIND_LABELS[kind]}`, '');
    const own = sorted.filter((e) => e.kind === kind);
    if (own.length === 0) out.push('_None yet._');
    own.forEach((entry, i) => {
      if (i > 0) out.push('');
      out.push(`### ${entry.title.replace(/\s+/g, ' ').trim()}`, '');
      const body = entry.body.trim();
      if (body) out.push(body, '');
      const from = entry.source ? ` · from ${entry.source.kind === 'chat' ? 'agent chat' : 'the bloat check'} "${entry.source.title}"` : '';
      out.push(`_${entry.createdBy}, ${new Date(entry.createdAt).toISOString().slice(0, 10)}${from}_`);
    });
  }
  return `${out.join('\n')}\n`;
}
