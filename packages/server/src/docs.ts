import {
  DOC_IDS,
  MEMORY_KIND_SINGULAR,
  PLAN_KIND_LABELS,
  Y,
  readMemory,
  readPlanning,
  type DocId,
} from '@pct/shared';

// The server's copy of the shared documents (planning space and project
// memory). Clients send Yjs updates; the server merges them, keeps the result
// on disk and relays them to everyone else. Saving is batched, since every
// keystroke is an update.

export type DocResult = { ok: true; descriptions: string[] } | { ok: false; message: string };

interface Summary {
  title: string;
  label: string;
  approvedAt: number | null;
}

export class SharedDocs {
  private readonly docs = {} as Record<DocId, Y.Doc>;
  private readonly dirty = new Set<DocId>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    saved: Partial<Record<DocId, Uint8Array>>,
    private readonly save: (docId: DocId, state: Uint8Array) => Promise<void>,
    private readonly saveDelayMs = 1000,
  ) {
    for (const id of DOC_IDS) {
      const doc = new Y.Doc();
      const state = saved[id];
      if (state) Y.applyUpdate(doc, state);
      this.docs[id] = doc;
    }
  }

  /** What a client with this state vector is missing, and the server's own state vector. */
  stateFor(docId: DocId, stateVector: Uint8Array): { update: Uint8Array; stateVector: Uint8Array } {
    const doc = this.docs[docId];
    return { update: Y.encodeStateAsUpdate(doc, stateVector), stateVector: Y.encodeStateVector(doc) };
  }

  /** Merges a client's update; describes items added, removed or approved, for the activity feed. */
  apply(docId: DocId, update: Uint8Array): DocResult {
    const doc = this.docs[docId];
    const before = this.summarize(docId);
    try {
      Y.applyUpdate(doc, update);
    } catch {
      return { ok: false, message: 'Could not read that document change' };
    }
    this.dirty.add(docId);
    this.scheduleSave();
    return { ok: true, descriptions: describe(docId, before, this.summarize(docId)) };
  }

  /** Writes changed documents now. */
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const ids = [...this.dirty];
    this.dirty.clear();
    await Promise.all(ids.map((id) => this.save(id, Y.encodeStateAsUpdate(this.docs[id]))));
  }

  /** The document as the app reads it, for tests and tools. */
  doc(docId: DocId): Y.Doc {
    return this.docs[docId];
  }

  private scheduleSave() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush().catch(() => {});
    }, this.saveDelayMs);
  }

  private summarize(docId: DocId): Map<string, Summary> {
    const doc = this.docs[docId];
    if (docId === 'planning') {
      return new Map(
        readPlanning(doc).map((i) => [i.id, { title: i.title, label: PLAN_KIND_LABELS[i.kind].toLowerCase(), approvedAt: i.approvedAt }]),
      );
    }
    return new Map(readMemory(doc).map((e) => [e.id, { title: e.title, label: MEMORY_KIND_SINGULAR[e.kind].toLowerCase(), approvedAt: null }]));
  }
}

function describe(docId: DocId, before: Map<string, Summary>, after: Map<string, Summary>): string[] {
  const where = docId === 'planning' ? 'the planning space' : 'project memory';
  const out: string[] = [];
  for (const [id, item] of after) {
    const old = before.get(id);
    if (!old) out.push(`added ${item.label} "${item.title}" to ${where}`);
    else if (item.approvedAt !== null && item.approvedAt !== old.approvedAt) out.push(`approved the plan for "${item.title}"`);
  }
  for (const [id, item] of before) {
    if (!after.has(id)) out.push(`removed ${item.label} "${item.title}" from ${where}`);
  }
  return out;
}
