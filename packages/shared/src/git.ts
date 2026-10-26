import type { FileChange } from './model.js';

// Reading git's output, for the PCs that run git: people's workspaces and agents' own copies.

const CHANGE: Record<string, FileChange> = { A: 'added', C: 'added', M: 'modified', T: 'modified', D: 'deleted', R: 'renamed' };

/** Parses `git diff --name-status -z`: a status, then one path (two for renames and copies). */
export function parseNameStatus(output: string): { path: string; change: FileChange }[] {
  const parts = output.split('\0');
  const files: { path: string; change: FileChange }[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i++];
    if (!status) continue;
    const letter = status[0]!;
    if (letter === 'R' || letter === 'C') {
      i++; // the old path
      const path = parts[i++];
      if (path) files.push({ path, change: CHANGE[letter]! });
    } else {
      const path = parts[i++];
      if (path) files.push({ path, change: CHANGE[letter] ?? 'modified' });
    }
  }
  return files;
}

