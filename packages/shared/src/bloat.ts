import { z } from 'zod';
import { epicLayoutProblems, unrealLayout } from './unreal.js';

// The bloat check: things that make a project bigger than it needs to be.
// Whoever runs it scans their own project folder; the report is shared with
// the session. Everything here is a hint for a person to look at, never an
// automatic delete. Changes outside a task's paths are worked out live from
// workspaces and pull requests instead (see filesOutsideScope).

export const BLOAT_LIST_LIMIT = 300;

export const BloatDuplicate = z.object({
  /**
   * identical: the same bytes; same-name: code files with the same name in
   * different folders; similar: two code files that are mostly the same code
   * (copied and tweaked, see findNearDuplicates).
   */
  reason: z.enum(['identical', 'same-name', 'similar']),
  paths: z.array(z.string().max(1024)).min(2).max(20),
  /** For similar: the share of the code the two have in common, 0 to 1. */
  similarity: z.number().min(0).max(1).optional(),
});
export type BloatDuplicate = z.infer<typeof BloatDuplicate>;

export const UnusedDependency = z.object({
  /** The package.json it is declared in. */
  manifest: z.string().max(1024),
  name: z.string().max(214),
  dev: z.boolean(),
});
export type UnusedDependency = z.infer<typeof UnusedDependency>;

/** A Godot add-on or Unreal plugin that is kept in the project but not used (see findUnusedPlugins). */
export const UnusedPlugin = z.object({
  engine: z.enum(['godot', 'unreal']),
  /** The add-on's or plugin's folder. */
  path: z.string().max(1024),
  name: z.string().max(200),
  detail: z.string().max(300),
});
export type UnusedPlugin = z.infer<typeof UnusedPlugin>;

/** What started a scan: a person, new commits on main or beta, or the daily check. */
export const BloatTrigger = z.enum(['manual', 'merge', 'daily']);
export type BloatTrigger = z.infer<typeof BloatTrigger>;

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
  /** The commit the scanned folder was on. */
  commit: z.string().max(64).nullable().default(null),
  trigger: BloatTrigger.default('manual'),
  /** How many files were looked at. */
  scanned: z.number().int(),
  /** The project had more files than the check looks at. */
  truncated: z.boolean(),
  duplicates: z.array(BloatDuplicate).max(BLOAT_LIST_LIMIT),
  unusedAssets: z.array(z.string().max(1024)).max(BLOAT_LIST_LIMIT),
  /** Godot scenes, scripts and resources the game never loads (see findUnusedGodotFiles), or Unreal assets nothing reaches (findUnusedUnrealAssets). */
  unusedGameFiles: z.array(z.string().max(1024)).max(BLOAT_LIST_LIMIT).default([]),
  /** Unreal assets and levels placed or named against Epic's structure and naming (see epicLayoutProblems). */
  epicLayout: z.array(z.object({ path: z.string().max(1024), problem: z.string().max(1000) })).max(BLOAT_LIST_LIMIT).default([]),
  unusedDependencies: z.array(UnusedDependency).max(BLOAT_LIST_LIMIT),
  folderNotes: z.array(FolderNoteFinding).max(BLOAT_LIST_LIMIT).default([]),
  /** Godot add-ons and Unreal plugins kept in the project but not enabled or used. */
  unusedPlugins: z.array(UnusedPlugin).max(BLOAT_LIST_LIMIT).default([]),
  /** Files that are Git LFS pointers (the real file is not pulled here), so nothing about them was checked. */
  notPulled: z.array(z.string().max(1024)).max(BLOAT_LIST_LIMIT).default([]),
  notPulledCount: z.number().int().min(0).default(0),
  /** Checks that could not run on this folder, and why, one line each. */
  skipped: z.array(z.string().max(500)).max(20).default([]),
  /** When the report this one is compared with ran; null for the first. */
  previousAt: z.number().nullable().default(null),
  /** Findings (see bloatItemKeys) the previous report did not have. */
  newKeys: z.array(z.string().max(1200)).max(BLOAT_LIST_LIMIT * 10).default([]),
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
  /** Unreal .uasset/.umap: the package paths its header names (/Game/...), i.e. what it uses. */
  refs?: string[];
  /** A Git LFS pointer: the real file is not pulled here. */
  lfs?: boolean;
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

// Near duplicates (issue #93): a system copied to another folder and
// tweaked is the "duplicate system" that matters, and neither a hash nor a
// name finds it. Each code file is cut into overlapping runs of tokens
// (shingles) with comments, strings and numbers taken out; two files that
// share most of their runs are mostly the same code. MinHash signatures
// with banding find the candidate pairs without comparing every file with
// every other; the share reported is the exact one for each pair.

/** Pairs that share at least this much of their code are reported. */
export const SIMILAR_THRESHOLD = 0.6;
/** Files with fewer tokens than this are too small to be a system. */
const SIMILAR_MIN_TOKENS = 60;
/** Tokens per shingle. */
const SHINGLE = 6;
const BANDS = 16;
const ROWS = 4;
/** Most pairs reported, most alike first. */
const SIMILAR_LIMIT = 100;

/** Languages whose comments start with # or -- instead of //. */
const HASH_COMMENTS = new Set(['gd', 'py']);
const DASH_COMMENTS = new Set(['lua']);

/** The code of a file as tokens: comments gone, every string "s", every number 0. */
export function codeTokens(text: string, ext: string): string[] {
  let code = text.replace(/\r\n/g, '\n');
  if (HASH_COMMENTS.has(ext)) code = code.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '"s"').replace(/#[^\n]*/g, '');
  else if (DASH_COMMENTS.has(ext)) code = code.replace(/--\[\[[\s\S]*?\]\]/g, '').replace(/--[^\n]*/g, '');
  else code = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/[^\n]*/g, '$1');
  code = code.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, ' "s" ');
  return code.match(/[A-Za-z_]\w*|\d[\w.]*|"s"|[^\s\w]/g)?.map((t) => (/^\d/.test(t) ? '0' : t.toLowerCase())) ?? [];
}

/** FNV-1a, 32 bits. */
function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** A 32-bit mix, one per signature row, so one hash gives many. */
function mix(h: number, seed: number): number {
  let x = (h ^ seed) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

const SEEDS = Array.from({ length: BANDS * ROWS }, (_, i) => hash32(`seed${i}`));

function shingles(tokens: string[]): Set<number> {
  const out = new Set<number>();
  for (let i = 0; i + SHINGLE <= tokens.length; i++) out.add(hash32(tokens.slice(i, i + SHINGLE).join(' ')));
  return out;
}

/** The share of shingles two files have in common (Jaccard). */
function overlap(a: Set<number>, b: Set<number>): number {
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  let both = 0;
  for (const h of small) if (large.has(h)) both++;
  return both / (a.size + b.size - both);
}

/** Pairs of code files that are mostly the same code; files already found identical are left out. */
export function findNearDuplicates(files: ScannedFile[], exclude: BloatDuplicate[] = []): BloatDuplicate[] {
  const known = new Set(exclude.filter((d) => d.reason === 'identical').flatMap((d) => d.paths));
  const items: { path: string; set: Set<number> }[] = [];
  for (const file of files) {
    const ext = extensionOf(file.path);
    if (file.text === null || !CODE_EXTENSIONS.has(ext) || isTestFile(file.path) || known.has(file.path)) continue;
    const tokens = codeTokens(file.text, ext);
    if (tokens.length < SIMILAR_MIN_TOKENS) continue;
    items.push({ path: file.path, set: shingles(tokens) });
  }
  const buckets = new Map<string, number[]>();
  items.forEach((item, index) => {
    const signature = SEEDS.map((seed) => {
      let min = 0xffffffff;
      for (const h of item.set) {
        const v = mix(h, seed);
        if (v < min) min = v;
      }
      return min;
    });
    for (let band = 0; band < BANDS; band++) {
      const key = `${band}:${signature.slice(band * ROWS, band * ROWS + ROWS).join(',')}`;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(index);
      else buckets.set(key, [index]);
    }
  });
  const seen = new Set<string>();
  const pairs: BloatDuplicate[] = [];
  for (const bucket of buckets.values()) {
    // A bucket with dozens of files is boilerplate everyone shares, not a copy.
    if (bucket.length < 2 || bucket.length > 50) continue;
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const key = `${bucket[i]}:${bucket[j]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const a = items[bucket[i]!]!;
        const b = items[bucket[j]!]!;
        const share = overlap(a.set, b.set);
        if (share >= SIMILAR_THRESHOLD) pairs.push({ reason: 'similar', paths: [a.path, b.path].sort(), similarity: Math.round(share * 100) / 100 });
      }
    }
  }
  return pairs.sort((x, y) => y.similarity! - x.similarity! || x.paths[0]!.localeCompare(y.paths[0]!)).slice(0, SIMILAR_LIMIT);
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

// Unreal (issue #11): levels are where the game starts, so every .umap is
// used, with the actors One File Per Actor keeps beside them; so is anything
// named in Config/*.ini (default maps, game mode, asset manager folders) or in
// C++ source. From there an asset uses what its header names. Assets in
// Developers/ and Collections/ are people's own and left alone.

/** The .uproject folders (repo-relative, '' for the top). */
export function unrealProjects(files: ScannedFile[]): string[] {
  return files.filter((f) => /\.uproject$/i.test(f.path)).map((f) => dirName(f.path));
}

/** /Game/... package paths in text, e.g. "/Game/Shooter/Envs/L_Main" from "/Game/Shooter/Envs/L_Main.L_Main". */
export function packagePaths(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\/Game\/[A-Za-z0-9_\-/]+/g)) out.add(m[0].replace(/\/+$/, ''));
  return [...out];
}

/** Unreal assets nothing reaches; a project whose used assets are not all readable is left out, with the reason added to skipped. */
export function findUnusedUnrealAssets(files: ScannedFile[], skipped: string[] = []): string[] {
  const out: string[] = [];
  for (const dir of unrealProjects(files)) {
    const prefix = dir ? `${dir}/` : '';
    const content = `${prefix}Content/`;
    // Package path (lower case, /Game/...) to its file.
    const packages = new Map<string, ScannedFile>();
    for (const f of files) {
      if (!f.path.startsWith(content) || !/\.(uasset|umap)$/i.test(f.path)) continue;
      packages.set(`/game/${f.path.slice(content.length).replace(/\.(uasset|umap)$/i, '')}`.toLowerCase(), f);
    }
    const reached = new Set<string>();
    const queue: ScannedFile[] = [];
    const reach = (pkg: string) => {
      const key = pkg.toLowerCase();
      const hit = packages.get(key);
      if (hit) {
        if (!reached.has(key)) {
          reached.add(key);
          queue.push(hit);
        }
        return;
      }
      // A folder (the asset manager scans whole folders): everything in it.
      for (const [other, file] of packages) {
        if (other.startsWith(`${key}/`) && !reached.has(other)) {
          reached.add(other);
          queue.push(file);
        }
      }
    };
    for (const [key, f] of packages) {
      const rel = f.path.slice(content.length);
      if (/\.umap$/i.test(f.path) || /^(__ExternalActors__|__ExternalObjects__|Developers|Collections)\//i.test(rel)) reach(key);
    }
    for (const f of files) {
      if (f.text === null || !f.path.startsWith(prefix)) continue;
      const rel = f.path.slice(prefix.length);
      if (/^(Config\/.*\.ini|Source\/.*\.(h|cpp|cs)|Plugins\/.*\.(h|cpp|ini))$/i.test(rel)) for (const pkg of packagePaths(f.text)) reach(pkg);
    }
    while (queue.length) {
      const file = queue.shift()!;
      for (const pkg of file.refs ?? []) reach(pkg);
    }
    // An asset used whose header was not read hides what it uses in turn: then nothing is reported.
    const unread = [...reached].filter((key) => packages.get(key)!.refs === undefined);
    if (unread.length) {
      const where = dir ? `${dir}/Content` : 'Content';
      const pointers = unread.filter((key) => packages.get(key)!.lfs).length;
      skipped.push(
        pointers
          ? `Unused Unreal assets in ${where}: ${pointers} used ${pointers === 1 ? 'asset is a Git LFS pointer' : 'assets are Git LFS pointers'} (not pulled), so what ${pointers === 1 ? 'it uses' : 'they use'} is unknown. Run git lfs pull, then check again.`
          : `Unused Unreal assets in ${where}: ${unread.length} used ${unread.length === 1 ? 'asset' : 'assets'} could not be read.`,
      );
      continue;
    }
    for (const [key, f] of packages) if (!reached.has(key) && /\.uasset$/i.test(f.path)) out.push(f.path);
  }
  return out;
}

/** Unreal assets and levels that do not follow Epic's structure or naming, one line each. */
export function findEpicLayoutIssues(files: ScannedFile[], config: { unrealContentFolder?: string; unrealFolders?: string[] } | null): { path: string; problem: string }[] {
  const out: { path: string; problem: string }[] = [];
  for (const uproject of files.filter((f) => /\.uproject$/i.test(f.path))) {
    const layout = unrealLayout(uproject.path, config);
    for (const f of files) {
      const problems = epicLayoutProblems(f.path, layout);
      if (problems.length) out.push({ path: f.path, problem: problems.join('; ') });
    }
  }
  return out;
}

// Add-ons and plugins (issue #93). A Godot add-on in addons/ is used when
// project.godot enables its plugin.cfg, or when something outside it loads
// its files or uses a class it names (runtime libraries have no plugin). An
// Unreal plugin in Plugins/ is used unless the .uproject turns it off (or it
// is off by default and the .uproject does not turn it on) and no enabled
// plugin needs it.

function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The plugins a .uproject or .uplugin lists, by name (lower case): enabled or not. */
function listedPlugins(json: Record<string, unknown> | null): Map<string, boolean> {
  const out = new Map<string, boolean>();
  if (!Array.isArray(json?.Plugins)) return out;
  for (const entry of json.Plugins as unknown[]) {
    const e = entry as { Name?: unknown; Enabled?: unknown };
    if (typeof e?.Name === 'string') out.set(e.Name.toLowerCase(), e.Enabled !== false);
  }
  return out;
}

export function findUnusedPlugins(files: ScannedFile[]): UnusedPlugin[] {
  const out: UnusedPlugin[] = [];

  for (const dir of godotProjects(files)) {
    const prefix = dir ? `${dir}/` : '';
    const project = files.find((f) => f.path === `${prefix}project.godot`);
    const enabledBlock = /^\[editor_plugins\][^[]*?^enabled\s*=\s*(?:Packed|Pool)StringArray\(([^)]*)\)/m.exec(project?.text ?? '')?.[1] ?? '';
    const enabled = new Set([...enabledBlock.matchAll(/"res:\/\/addons\/([^/"]+)\//g)].map((m) => m[1]!.toLowerCase()));
    const addons = new Map<string, ScannedFile[]>();
    for (const f of files) {
      const m = new RegExp(`^${escapeRegExp(prefix)}addons/([^/]+)/`).exec(f.path);
      if (m) addons.set(m[1]!, [...(addons.get(m[1]!) ?? []), f]);
    }
    const outside = (name: string) =>
      files.filter((f) => f.text !== null && f.path.startsWith(prefix) && !f.path.startsWith(`${prefix}addons/${name}/`) && GODOT_TEXT.test(f.path) && !/\.(?:import|uid)$/i.test(f.path));
    for (const [name, inside] of addons) {
      if (enabled.has(name.toLowerCase())) continue;
      const hasPlugin = inside.some((f) => f.path.toLowerCase() === `${prefix}addons/${name}/plugin.cfg`.toLowerCase());
      const classes = inside
        .filter((f) => f.text !== null && /\.(?:gd|cs)$/i.test(f.path))
        .map((f) => /^\s*class_name\s+([A-Za-z_]\w*)/m.exec(f.text!)?.[1] ?? /\[GlobalClass\][\s\S]{0,200}?class\s+([A-Za-z_]\w*)/.exec(f.text!)?.[1])
        .filter((c): c is string => !!c);
      const classPattern = classes.length ? new RegExp(`\\b(?:${classes.join('|')})\\b`) : null;
      const path = `res://addons/${name}/`.toLowerCase();
      const used = outside(name).some((f) => f.text!.toLowerCase().includes(path) || (classPattern !== null && classPattern.test(f.text!)));
      if (used) continue;
      out.push({
        engine: 'godot',
        path: `${prefix}addons/${name}`,
        name,
        detail: hasPlugin ? 'Not enabled in project.godot, and nothing outside it loads it' : 'Nothing outside it loads its files or uses its classes',
      });
    }
  }

  for (const uproject of files.filter((f) => /\.uproject$/i.test(f.path))) {
    const dir = dirName(uproject.path);
    const prefix = dir ? `${dir}/` : '';
    const listed = listedPlugins(parseJson(uproject.text));
    const plugins = files
      .filter((f) => f.path.startsWith(`${prefix}Plugins/`) && /\.uplugin$/i.test(f.path))
      .map((f) => ({ file: f, name: baseName(f.path).replace(/\.uplugin$/i, ''), json: parseJson(f.text) }));
    const on = (p: (typeof plugins)[number]) => listed.get(p.name.toLowerCase()) ?? p.json?.EnabledByDefault !== false;
    // Plugins an enabled plugin depends on are used through it.
    const needed = new Set<string>();
    for (const p of plugins) if (on(p)) for (const [name, enabled] of listedPlugins(p.json)) if (enabled) needed.add(name);
    for (const p of plugins) {
      if (on(p) || needed.has(p.name.toLowerCase())) continue;
      out.push({
        engine: 'unreal',
        path: dirName(p.file.path),
        name: p.name,
        detail: listed.has(p.name.toLowerCase())
          ? `Turned off in ${baseName(uproject.path)} but kept in Plugins/`
          : `Off by default and not turned on in ${baseName(uproject.path)}`,
      });
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

/** One key per finding, the same across scans, to tell which findings are new. */
export function bloatItemKeys(report: BloatReport): string[] {
  return [
    ...report.duplicates.map(duplicateKey),
    ...report.unusedAssets.map((p) => `asset:${p}`),
    ...report.unusedGameFiles.map((p) => `game:${p}`),
    ...report.epicLayout.map((e) => `epic:${e.path}`),
    ...report.unusedDependencies.map((d) => `dep:${d.manifest}:${d.name}`),
    ...report.unusedPlugins.map((p) => `plugin:${p.path}`),
    ...report.folderNotes.map((f) => `notes:${f.kind}:${f.path}`),
  ];
}

export const duplicateKey = (d: BloatDuplicate) => `dup:${d.reason}:${d.paths.join('|')}`;

/** The report with the findings marked that the previous one did not have. */
export function markNewSince(report: BloatReport, previous: BloatReport | null): BloatReport {
  if (!previous) return { ...report, previousAt: null, newKeys: [] };
  const before = new Set(bloatItemKeys(previous));
  return { ...report, previousAt: previous.ranAt, newKeys: bloatItemKeys(report).filter((k) => !before.has(k)).slice(0, BLOAT_LIST_LIMIT * 10) };
}

export function analyzeBloat(
  files: ScannedFile[],
  info: {
    ranBy: string;
    branch: string | null;
    commit?: string | null;
    trigger?: BloatTrigger;
    truncated: boolean;
    setup?: { unrealContentFolder?: string; unrealFolders?: string[] } | null;
  },
  now = Date.now(),
  folderNotes: FolderNoteFinding[] = [],
): BloatReport {
  const skipped: string[] = [];
  const exact = findDuplicates(files);
  const notPulled = files.filter((f) => f.lfs).map((f) => f.path);
  return {
    ranBy: info.ranBy.slice(0, 64),
    ranAt: now,
    branch: info.branch,
    commit: info.commit ?? null,
    trigger: info.trigger ?? 'manual',
    scanned: files.length,
    truncated: info.truncated,
    duplicates: [...exact, ...findNearDuplicates(files, exact)].slice(0, BLOAT_LIST_LIMIT),
    unusedAssets: findUnusedAssets(files).slice(0, BLOAT_LIST_LIMIT),
    unusedGameFiles: [...findUnusedGodotFiles(files).filter((path) => GODOT_GAME_FILES.has(extensionOf(path))), ...findUnusedUnrealAssets(files, skipped)].slice(
      0,
      BLOAT_LIST_LIMIT,
    ),
    epicLayout: findEpicLayoutIssues(files, info.setup ?? null).slice(0, BLOAT_LIST_LIMIT),
    unusedDependencies: findUnusedDependencies(files).slice(0, BLOAT_LIST_LIMIT),
    folderNotes: folderNotes.slice(0, BLOAT_LIST_LIMIT),
    unusedPlugins: findUnusedPlugins(files).slice(0, BLOAT_LIST_LIMIT),
    notPulled: notPulled.slice(0, BLOAT_LIST_LIMIT),
    notPulledCount: notPulled.length,
    skipped: skipped.slice(0, 20),
    previousAt: null,
    newKeys: [],
  };
}
