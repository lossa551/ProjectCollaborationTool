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

/** What the folder notes scan adds to the report (see the desktop app's folder-notes.ts). */
export const FolderNoteFinding = z.object({
  /**
   * stale-note: a folder's AGENTS.md no longer matches it; missing-note: a big
   * folder agents read through without one; large-file: a text file that
   * costs an agent a lot of context to read whole.
   */
  kind: z.enum(['stale-note', 'missing-note', 'large-file']),
  /** The note, folder or file. */
  path: z.string().max(1024),
  /** Estimated tokens of the folder or file. */
  tokens: z.number().int(),
  detail: z.string().max(300),
});
export type FolderNoteFinding = z.infer<typeof FolderNoteFinding>;

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
  /** Godot scenes, scripts and resources the game never loads (see findUnusedGodotFiles). */
  unusedGameFiles: z.array(z.string().max(1024)).max(BLOAT_LIST_LIMIT).default([]),
  unusedDependencies: z.array(UnusedDependency).max(BLOAT_LIST_LIMIT),
  folderNotes: z.array(FolderNoteFinding).max(BLOAT_LIST_LIMIT).default([]),
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

/** Boilerplate that every package or folder is expected to have a copy of. */
const BOILERPLATE = /(?:^|\/)(?:tsconfig[^/]*\.json|\.gitignore|\.gitattributes|\.editorconfig|\.prettierrc[^/]*|LICENSE[^/]*|\.gdignore)$/i;

/** Files that mark the root of a package or project; names may repeat across packages on purpose. */
const PACKAGE_MARKERS = /(?:^|\/)(?:package\.json|project\.godot|[^/]+\.uproject|[^/]+\.csproj|Cargo\.toml|go\.mod|pyproject\.toml)$/i;

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
    if (!file.hash || file.size < 64 || BOILERPLATE.test(file.path)) continue;
    byHash.set(file.hash, [...(byHash.get(file.hash) ?? []), file.path]);
  }
  const identical = new Set<string>();
  for (const paths of byHash.values()) {
    if (paths.length < 2) continue;
    out.push({ reason: 'identical', paths: paths.slice(0, 20) });
    for (const p of paths) identical.add(p);
  }

  // Each package of a monorepo may have its own "storage.ts"; only the same package counts.
  const roots = files.filter((f) => PACKAGE_MARKERS.test(f.path)).map((f) => dirName(f.path));
  const packageOf = (path: string) =>
    roots.filter((root) => root === '' || path.startsWith(`${root}/`)).sort((a, b) => b.length - a.length)[0] ?? '';
  const byName = new Map<string, string[]>();
  for (const file of files) {
    const ext = extensionOf(file.path);
    if (!CODE_EXTENSIONS.has(ext) || isTestFile(file.path)) continue;
    const stem = normalizedStem(file.path);
    const plain = baseName(file.path).toLowerCase().replace(/\.[^.]+$/, '');
    if (!stem || COMMON_NAMES.has(plain)) continue;
    const key = `${packageOf(file.path)}\n${ext}\n${stem}`;
    byName.set(key, [...(byName.get(key) ?? []), file.path]);
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
  // Inside a Godot project, what the game loads is known exactly: see findUnusedGodotFiles.
  const godot = godotProjects(files);
  if (godot.length) {
    const inGodot = (path: string) => godot.some((dir) => dir === '' || path.startsWith(`${dir}/`));
    const unused = findUnusedGodotFiles(files).filter((path) => ASSET_EXTENSIONS.includes(extensionOf(path)));
    return [...unused, ...findUnusedAssetsByName(files).filter((path) => !inGodot(path))];
  }
  return findUnusedAssetsByName(files);
}

/** Assets whose file name appears in no text file. */
function findUnusedAssetsByName(files: ScannedFile[]): string[] {
  const texts = files.filter((f) => f.text !== null && !IGNORED_FOR_REFERENCES.test(f.path));
  const referenced = new Set<string>();
  for (const file of texts) {
    for (const match of file.text!.matchAll(ASSET_REFERENCE)) referenced.add(`${match[1]}.${match[2]}`.toLowerCase());
  }
  let lowered: string[] | null = null;
  return files
    .filter((f) => {
      if (!ASSET_EXTENSIONS.includes(extensionOf(f.path))) return false;
      const name = baseName(f.path).toLowerCase();
      if (referenced.has(name)) return false;
      // Names with spaces or brackets do not come out of the pattern whole; look for them as they are.
      if (/[\s"'`()<>|*?=,;{}[\]]/.test(name)) {
        lowered ??= texts.map((t) => t.text!.toLowerCase());
        return !lowered.some((text) => text.includes(name));
      }
      return true;
    })
    .map((f) => f.path);
}

// Godot (issue #10): the game loads what project.godot points at (main
// scene, autoloads, icon), and from there whatever those files refer to with
// res:// paths, uid:// ids or a script's class_name. Anything no chain
// reaches is never loaded. Add-ons and tests are left alone: the editor and
// the test runner load them.

/** Scenes, scripts and resources: Godot's own files, reported apart from assets. */
const GODOT_GAME_FILES = new Set(['tscn', 'scn', 'tres', 'res', 'gd', 'cs', 'gdshader', 'gdshaderinc', 'shader']);
const GODOT_TEXT = /\.(?:tscn|tres|gd|cs|godot|cfg|gdshader|gdshaderinc|shader|json|import|uid)$/i;
/** Godot loads these by name when they are there. */
const GODOT_IMPLICIT = /^(?:default_bus_layout\.tres|default_env\.tres|export_presets\.cfg|\.gutconfig\.json)$/i;
const GODOT_EXEMPT = /^(?:addons|tests?)\//i;

/** Folders (repo-relative, '' for the top) holding a project.godot. */
export function godotProjects(files: ScannedFile[]): string[] {
  return files.filter((f) => baseName(f.path) === 'project.godot').map((f) => dirName(f.path));
}

export function findUnusedGodotFiles(files: ScannedFile[]): string[] {
  const out: string[] = [];
  const dirs = godotProjects(files).sort((a, b) => b.length - a.length);
  const claimed = new Set<string>();
  for (const dir of dirs) {
    const prefix = dir ? `${dir}/` : '';
    // A project nested in another belongs to itself only.
    const inside = files.filter((f) => f.path.startsWith(prefix) && !claimed.has(f.path));
    for (const f of inside) claimed.add(f.path);
    const local = (path: string) => path.slice(prefix.length);
    const byPath = new Map(inside.map((f) => [local(f.path).toLowerCase(), f]));

    // uid:// ids: from .import and .uid files, and the uid in a scene's or resource's header.
    const uids = new Map<string, string>();
    for (const f of inside) {
      if (f.text === null) continue;
      const rel = local(f.path);
      if (rel.endsWith('.import')) {
        const uid = /^uid="(uid:\/\/[a-z0-9]+)"/m.exec(f.text)?.[1];
        if (uid) uids.set(uid, rel.slice(0, -'.import'.length).toLowerCase());
      } else if (rel.endsWith('.uid')) {
        const uid = /uid:\/\/[a-z0-9]+/.exec(f.text)?.[0];
        if (uid) uids.set(uid, rel.slice(0, -'.uid'.length).toLowerCase());
      } else if (/\.(?:tscn|tres)$/i.test(rel)) {
        const uid = /^\[gd_(?:scene|resource)[^\]]*\buid="(uid:\/\/[a-z0-9]+)"/m.exec(f.text)?.[1];
        if (uid) uids.set(uid, rel.toLowerCase());
      }
    }
    const classes = new Map<string, string>();
    for (const f of inside) {
      if (f.text === null || !/\.(?:gd|cs)$/i.test(f.path)) continue;
      const name = /^\s*class_name\s+([A-Za-z_]\w*)/m.exec(f.text)?.[1] ?? /\[GlobalClass\][\s\S]{0,200}?class\s+([A-Za-z_]\w*)/.exec(f.text)?.[1];
      if (name) classes.set(name, local(f.path).toLowerCase());
    }
    const classPattern = classes.size ? new RegExp(`\\b(${[...classes.keys()].join('|')})\\b`, 'g') : null;

    const reached = new Set<string>();
    const queue: string[] = [];
    const reach = (rel: string) => {
      const key = rel.toLowerCase().replace(/^\.\//, '');
      if (reached.has(key) || !byPath.has(key)) return;
      reached.add(key);
      queue.push(key);
    };
    for (const f of inside) {
      const rel = local(f.path);
      if (rel === 'project.godot' || GODOT_IMPLICIT.test(rel) || GODOT_EXEMPT.test(rel)) reach(rel);
    }
    while (queue.length) {
      const file = byPath.get(queue.shift()!)!;
      if (file.text === null || !GODOT_TEXT.test(file.path)) continue;
      for (const m of file.text.matchAll(/res:\/\/([^"'\s)\]>]+)/g)) reach(m[1]!);
      for (const m of file.text.matchAll(/uid:\/\/[a-z0-9]+/g)) {
        const target = uids.get(m[0]);
        if (target) reach(target);
      }
      if (classPattern) {
        for (const m of file.text.matchAll(classPattern)) {
          const target = classes.get(m[1]!);
          if (target && target !== local(file.path).toLowerCase()) reach(target);
        }
      }
      // A script's own folder is where relative loads ("enemy.tscn") point.
      const folder = dirName(local(file.path));
      for (const m of file.text.matchAll(/\b(?:pre)?load\(\s*"([^":]+)"\s*\)/g)) reach(folder ? `${folder}/${m[1]}` : m[1]!);
    }
    for (const f of inside) {
      const rel = local(f.path);
      const ext = extensionOf(rel);
      if (!GODOT_GAME_FILES.has(ext) && !ASSET_EXTENSIONS.includes(ext)) continue;
      if (!reached.has(rel.toLowerCase())) out.push(f.path);
    }
  }
  return out;
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
    // A workspace root's tools are often run from its packages' scripts.
    const scripts = manifests
      .filter((m) => m === manifest || dir === '' || m.path.startsWith(`${dir}/`))
      .flatMap((m) => Object.values(parse(m.text!)?.scripts ?? {}))
      .join('\n');
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
  folderNotes: FolderNoteFinding[] = [],
): BloatReport {
  return {
    ranBy: info.ranBy.slice(0, 64),
    ranAt: now,
    branch: info.branch,
    scanned: files.length,
    truncated: info.truncated,
    duplicates: findDuplicates(files).slice(0, BLOAT_LIST_LIMIT),
    unusedAssets: findUnusedAssets(files).slice(0, BLOAT_LIST_LIMIT),
    unusedGameFiles: findUnusedGodotFiles(files)
      .filter((path) => GODOT_GAME_FILES.has(extensionOf(path)))
      .slice(0, BLOAT_LIST_LIMIT),
    unusedDependencies: findUnusedDependencies(files).slice(0, BLOAT_LIST_LIMIT),
    folderNotes: folderNotes.slice(0, BLOAT_LIST_LIMIT),
  };
}
