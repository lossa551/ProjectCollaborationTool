import { z } from 'zod';

// The bloat check: things that make a project bigger than it needs to be.
// Whoever runs it scans their own project folder; the report is shared with
// the session. Everything here is a hint for a person to look at, never an
// automatic delete. Changes outside a task's paths are worked out live from
// workspaces and pull requests instead (see filesOutsideScope).

export const BLOAT_LIST_LIMIT = 300;

export const BloatDuplicate = z.object({
  /** identical: the same bytes; same-name: code files with the same name in different folders. */
  reason: z.enum(['identical', 'same-name']),
  paths: z.array(z.string().max(1024)).min(2).max(20),
});
export type BloatDuplicate = z.infer<typeof BloatDuplicate>;

export const UnusedDependency = z.object({
  /** The package.json it is declared in. */
  manifest: z.string().max(1024),
  name: z.string().max(214),
  dev: z.boolean(),
});
export type UnusedDependency = z.infer<typeof UnusedDependency>;

export const BloatReport = z.object({
  ranBy: z.string().max(64),
  ranAt: z.number(),
  /** The branch the scanned folder was on. */
  branch: z.string().max(255).nullable(),
  /** How many files were looked at. */
  scanned: z.number().int(),
  /** The project had more files than the check looks at. */
  truncated: z.boolean(),
  duplicates: z.array(BloatDuplicate).max(BLOAT_LIST_LIMIT),
  unusedAssets: z.array(z.string().max(1024)).max(BLOAT_LIST_LIMIT),
  unusedDependencies: z.array(UnusedDependency).max(BLOAT_LIST_LIMIT),
});
export type BloatReport = z.infer<typeof BloatReport>;

/** One file of the project, as the scanner read it. */
export interface ScannedFile {
  /** Repo-relative, forward slashes. */
  path: string;
  size: number;
  /** Content hash, for files small enough to hash. */
  hash: string | null;
  /** Content of text files small enough to read. */
  text: string | null;
}

/** Files that count as assets: referenced by name from code, scenes or configs. */
export const ASSET_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tga', 'exr', 'hdr', 'psd', 'kra',
  'blend', 'fbx', 'glb', 'gltf', 'obj', 'dae',
  'wav', 'ogg', 'mp3', 'flac', 'opus',
  'ttf', 'otf', 'woff', 'woff2',
  'mp4', 'webm', 'ogv',
];

const CODE_EXTENSIONS = new Set([
  'gd', 'cs', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'c', 'cc', 'cpp', 'h', 'hpp', 'rs', 'go', 'java', 'kt', 'lua', 'swift',
]);

/** File names that are meant to repeat in every folder. */
const COMMON_NAMES = new Set([
  'index', 'main', 'mod', 'init', 'utils', 'util', 'helpers', 'types', 'constants', 'config', 'setup', 'test', 'tests',
  'app', 'lib', 'build', 'vite.config', 'vitest.config', 'env.d', 'cli', 'server', 'client', 'model', 'models',
]);

/** Text that never counts as a reference: lockfiles and Godot's generated import notes. */
const IGNORED_FOR_REFERENCES = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|\.import$/i;

const extensionOf = (path: string) => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dirName = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** "PlayerController.gd", "player_controller.gd" and "player-controller.gd" are the same name. */
function normalizedStem(path: string): string {
  const name = baseName(path).toLowerCase();
  const stem = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name;
  return stem.replace(/[-_ ]/g, '');
}

const isTestFile = (path: string) => /(?:^|\/)(?:tests?|__tests__|spec)\/|[._-](?:test|spec)\.[^/]+$|_test\.[^/]+$/i.test(path);

export function findDuplicates(files: ScannedFile[]): BloatDuplicate[] {
  const out: BloatDuplicate[] = [];
  const byHash = new Map<string, string[]>();
  for (const file of files) {
    // Tiny files (empty placeholders, one-line configs) are expected to repeat.
    if (!file.hash || file.size < 64) continue;
    byHash.set(file.hash, [...(byHash.get(file.hash) ?? []), file.path]);
  }
  const identical = new Set<string>();
  for (const paths of byHash.values()) {
    if (paths.length < 2) continue;
    out.push({ reason: 'identical', paths: paths.slice(0, 20) });
    for (const p of paths) identical.add(p);
  }

  const byName = new Map<string, string[]>();
  for (const file of files) {
    if (!CODE_EXTENSIONS.has(extensionOf(file.path)) || isTestFile(file.path)) continue;
    const stem = normalizedStem(file.path);
    const plain = baseName(file.path).toLowerCase().replace(/\.[^.]+$/, '');
    if (!stem || COMMON_NAMES.has(plain)) continue;
    byName.set(stem, [...(byName.get(stem) ?? []), file.path]);
  }
  for (const paths of byName.values()) {
    if (paths.length < 2 || paths.every((p) => identical.has(p))) continue;
    if (new Set(paths.map(dirName)).size < 2) continue;
    out.push({ reason: 'same-name', paths: paths.slice(0, 20) });
  }
  return out;
}

const ASSET_REFERENCE = new RegExp(`([^\\s"'\`()/\\\\:<>|*?=,;{}\\[\\]]+)\\.(${ASSET_EXTENSIONS.join('|')})(?![a-z0-9])`, 'gi');

export function findUnusedAssets(files: ScannedFile[]): string[] {
  const referenced = new Set<string>();
  for (const file of files) {
    if (file.text === null || IGNORED_FOR_REFERENCES.test(file.path)) continue;
    for (const match of file.text.matchAll(ASSET_REFERENCE)) referenced.add(`${match[1]}.${match[2]}`.toLowerCase());
  }
  return files
    .filter((f) => ASSET_EXTENSIONS.includes(extensionOf(f.path)) && !referenced.has(baseName(f.path).toLowerCase()))
    .map((f) => f.path);
}

/** Commands a package installs under another name. */
const PACKAGE_COMMANDS: Record<string, string[]> = {
  typescript: ['tsc'],
  'electron-builder': ['electron-builder'],
  '@playwright/test': ['playwright'],
};

/** Packages used without being imported: type packages and tools found through their config. */
const IMPLICIT = /^@types\/|^(?:prettier|eslint|stylelint)(?:-|$)|^eslint-(?:config|plugin)-|^@typescript-eslint\/|^tslib$/;

export function findUnusedDependencies(files: ScannedFile[]): UnusedDependency[] {
  const manifests = files.filter((f) => baseName(f.path) === 'package.json' && f.text !== null && !f.path.includes('node_modules/'));
  const parse = (text: string): { name?: unknown; dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } | null => {
    try {
      const value: unknown = JSON.parse(text);
      return value && typeof value === 'object' ? value : null;
    } catch {
      return null;
    }
  };
  // Workspace packages refer to each other by name.
  const workspaceNames = new Set(manifests.map((m) => parse(m.text!)?.name).filter((n) => typeof n === 'string'));
  const out: UnusedDependency[] = [];
  for (const manifest of manifests) {
    const pkg = parse(manifest.text!);
    if (!pkg) continue;
    const dir = dirName(manifest.path);
    const inside = files.filter(
      (f) => f.text !== null && f !== manifest && !IGNORED_FOR_REFERENCES.test(f.path) && (dir === '' || f.path.startsWith(`${dir}/`)),
    );
    const scripts = Object.values(pkg.scripts ?? {}).join('\n');
    const used = (name: string) => {
      if (IMPLICIT.test(name) || workspaceNames.has(name)) return true;
      const commands = PACKAGE_COMMANDS[name] ?? [name.slice(name.lastIndexOf('/') + 1)];
      if (commands.some((c) => new RegExp(`(?:^|[\\s/&;|])${escapeRegExp(c)}(?:$|[\\s])`, 'm').test(scripts))) return true;
      const quoted = [`'${name}'`, `"${name}"`, `\`${name}\``, `'${name}/`, `"${name}/`, `\`${name}/`];
      return inside.some((f) => quoted.some((q) => f.text!.includes(q)));
    };
    for (const [deps, dev] of [
      [pkg.dependencies, false],
      [pkg.devDependencies, true],
    ] as const) {
      for (const name of Object.keys(deps ?? {})) {
        if (!used(name)) out.push({ manifest: manifest.path, name, dev });
      }
    }
  }
  return out;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function analyzeBloat(
  files: ScannedFile[],
  info: { ranBy: string; branch: string | null; truncated: boolean },
  now = Date.now(),
): BloatReport {
  return {
    ranBy: info.ranBy.slice(0, 64),
    ranAt: now,
    branch: info.branch,
    scanned: files.length,
    truncated: info.truncated,
    duplicates: findDuplicates(files).slice(0, BLOAT_LIST_LIMIT),
    unusedAssets: findUnusedAssets(files).slice(0, BLOAT_LIST_LIMIT),
    unusedDependencies: findUnusedDependencies(files).slice(0, BLOAT_LIST_LIMIT),
  };
}
