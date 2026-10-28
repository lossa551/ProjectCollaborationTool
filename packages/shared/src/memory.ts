import * as Y from 'yjs';
import { z } from 'zod';
import { itemsOf, readItems, setItemText } from './docs.js';
import { estimateTokens } from './model.js';

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
  /** Kept in the record (and in docs/project-memory.md) but no longer given to agents: finished plans, fixed issues. */
  archived: z.boolean().default(false),
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
  z.object({ op: z.literal('set'), id: EntryId, kind: MemoryKind.optional(), title: MemoryTitle.optional(), archived: z.boolean().optional() }),
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
        if (op.archived !== undefined) entry.set('archived', op.archived);
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

/**
 * How many tokens of project memory an agent carries in its instructions.
 * Entries past it are listed by title only, for the agent to read when it
 * needs them, like folder notes past NOTES_TOKEN_BUDGET.
 */
export const MEMORY_TOKEN_BUDGET = 4000;

/** Conventions and decisions bind every change, so they get the budget first. */
const KIND_ORDER: MemoryKind[] = ['convention', 'decision', 'issue', 'plan'];

/** What an agent's chat is about, so memory about the same work comes first. */
export interface MemoryFocus {
  /** The chat and the other chats of its task: entries saved from them are linked. */
  chatIds: string[];
  /** The task's and handoff's paths: entries that name one are linked. */
  paths: string[];
}

function mentionsPath(entry: MemoryEntry, paths: string[]): boolean {
  const text = `${entry.title}\n${entry.body}`.toLowerCase();
  return paths.some((path) => {
    const plain = path.replace(/^\.\//, '').replace(/(\/\*\*?)+$|\/+$/g, '').toLowerCase();
    return plain.length >= 3 && !/[*?]/.test(plain) && text.includes(plain);
  });
}

/** Whether an entry is about the chat's work: saved from one of its task's chats, or naming one of its paths. */
export function memoryLinked(entry: MemoryEntry, focus: MemoryFocus | null | undefined): boolean {
  if (!focus) return false;
  if (entry.source?.kind === 'chat' && entry.source.id && focus.chatIds.includes(entry.source.id)) return true;
  return mentionsPath(entry, focus.paths);
}

/** Entries agents get, most important first: by kind, then linked to the chat's work, then newest. Archived ones are left out. */
export function memoryOrder(entries: MemoryEntry[], focus?: MemoryFocus | null): MemoryEntry[] {
  const linked = new Set(entries.filter((e) => memoryLinked(e, focus)).map((e) => e.id));
  return entries
    .filter((e) => !e.archived)
    .sort(
      (a, b) =>
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        Number(linked.has(b.id)) - Number(linked.has(a.id)) ||
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id),
    );
}

/** One entry as an agent reads it. */
export function memoryEntryText(entry: MemoryEntry): string {
  const body = entry.body.trim();
  return body ? `- ${entry.title}\n${body.replace(/^/gm, '  ')}` : `- ${entry.title}`;
}

/** Tokens one entry adds to every agent call when given in full. */
export function memoryEntryTokens(entry: MemoryEntry): number {
  return estimateTokens(memoryEntryText(entry));
}

export interface RenderedMemory {
  /** Empty when there is nothing to give. */
  text: string;
  /** Given in full. */
  included: MemoryEntry[];
  /** Past the budget: listed by title only. */
  listed: MemoryEntry[];
  /** Left out because they are archived. */
  archived: number;
}

/**
 * Project memory as text, the way an agent reads it: whole entries in order
 * of importance until the budget is used, then the rest by title. `readHint`
 * tells the agent how to read a listed entry.
 */
export function renderMemory(
  entries: MemoryEntry[],
  options: { budget?: number; focus?: MemoryFocus | null; readHint?: string } = {},
): RenderedMemory {
  const budget = options.budget ?? MEMORY_TOKEN_BUDGET;
  const included: MemoryEntry[] = [];
  const listed: MemoryEntry[] = [];
  let used = 0;
  for (const entry of memoryOrder(entries, options.focus)) {
    const tokens = memoryEntryTokens(entry);
    if (used + tokens > budget) {
      listed.push(entry);
      continue;
    }
    used += tokens;
    included.push(entry);
  }
  const archived = entries.length - included.length - listed.length;
  const sections: string[] = [];
  for (const kind of KIND_ORDER) {
    const own = included.filter((e) => e.kind === kind);
    if (own.length) sections.push(`${MEMORY_KIND_LABELS[kind]}:\n${own.map(memoryEntryText).join('\n')}`);
  }
  if (listed.length) {
    sections.push(
      `More entries, by title only${options.readHint ? ` (${options.readHint})` : ''}:\n` +
        listed.map((e) => `- ${MEMORY_KIND_SINGULAR[e.kind]}: ${e.title}`).join('\n'),
    );
  }
  return { text: sections.join('\n\n'), included, listed, archived };
}

/** Entries whose title matches, for an agent reading one it saw by title only (archived ones too). */
export function findMemory(entries: MemoryEntry[], title: string): MemoryEntry[] {
  const want = title.replace(/\s+/g, ' ').trim().toLowerCase();
  if (!want) return [];
  const norm = (e: MemoryEntry) => e.title.replace(/\s+/g, ' ').trim().toLowerCase();
  const exact = entries.filter((e) => norm(e) === want);
  return exact.length ? exact : entries.filter((e) => norm(e).includes(want)).slice(0, 5);
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
  const write = (own: MemoryEntry[], withKind: boolean) =>
    own.forEach((entry, i) => {
      if (i > 0) out.push('');
      out.push(`### ${entry.title.replace(/\s+/g, ' ').trim()}`, '');
      const body = entry.body.trim();
      if (body) out.push(body, '');
      const from = entry.source ? ` · from ${entry.source.kind === 'chat' ? 'agent chat' : 'the bloat check'} "${entry.source.title}"` : '';
      const kind = withKind ? `${MEMORY_KIND_SINGULAR[entry.kind]} · ` : '';
      out.push(`_${kind}${entry.createdBy}, ${new Date(entry.createdAt).toISOString().slice(0, 10)}${from}_`);
    });
  for (const kind of MemoryKind.options) {
    out.push('', `## ${MEMORY_KIND_LABELS[kind]}`, '');
    const own = sorted.filter((e) => e.kind === kind && !e.archived);
    if (own.length === 0) out.push('_None yet._');
    write(own, false);
  }
  const archived = sorted.filter((e) => e.archived);
  if (archived.length) {
    out.push('', '## Archived', '', '_Kept for the record; agents are not given these with their instructions._', '');
    write(archived, true);
  }
  return `${out.join('\n')}\n`;
}
