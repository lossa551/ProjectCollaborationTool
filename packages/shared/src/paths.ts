// Path helpers shared by lock rules and task scopes. Paths are relative to
// the repository root, use forward slashes, and compare case-insensitively
// because the app runs on Windows.

/** Normalizes a repo-relative path; returns null for paths that leave the repo. */
export function normalizePath(input: string): string | null {
  const parts: string[] = [];
  for (const part of input.trim().replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join('/') : null;
}

export function samePath(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

const globCache = new Map<string, RegExp>();

/**
 * Glob to regular expression. `**` matches across folders, `*` and `?` stay
 * within one. A pattern without a slash matches the file name in any folder,
 * so `*.psd` covers `art/ui/menu.psd`.
 */
export function globToRegExp(pattern: string): RegExp {
  const cached = globCache.get(pattern);
  if (cached) return cached;
  const normalized = pattern.trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  let source = '';
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i]!;
    if (c === '*' && normalized[i + 1] === '*') {
      // "**/" also matches zero folders.
      if (normalized[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (c === '*') {
      source += '[^/]*';
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const prefix = normalized.includes('/') ? '^' : '^(?:.*/)?';
  const regex = new RegExp(`${prefix}${source}$`, 'i');
  globCache.set(pattern, regex);
  return regex;
}

export function matchesAny(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => pattern.trim() !== '' && globToRegExp(pattern).test(path));
}
