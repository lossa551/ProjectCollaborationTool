import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MEMORY_EXPORT_PATH, memoryMarkdown, type MemoryEntry } from '@pct/shared';

// Project memory written to docs/project-memory.md in your project folder, so
// it is in the repository with the code and CLI agents (Claude Code, Codex)
// that read repo files find it. The file is only rewritten when its content
// changes, so it does not show up as changed for nothing.

/** Writes the file; false when it already said the same. */
export function writeMemoryFile(root: string, entries: MemoryEntry[]): boolean {
  const file = join(root, ...MEMORY_EXPORT_PATH.split('/'));
  const text = memoryMarkdown(entries);
  try {
    if (readFileSync(file, 'utf8').replace(/\r\n/g, '\n') === text) return false;
  } catch {
    // Not written yet.
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
  return true;
}
