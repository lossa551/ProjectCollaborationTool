import { z } from 'zod';
import type { MemoryEntry } from './memory.js';
import { MEMORY_EXPORT_PATH } from './memory.js';
import type { LockRules } from './model.js';
import { NOTE_FILE } from './folder-notes.js';
import {
  GODOT_PLUGIN_CFG,
  GODOT_PLUGIN_CFG_PATH,
  GODOT_PLUGIN_SCRIPT,
  GODOT_PLUGIN_SCRIPT_PATH,
  pluginEnabled,
  withPluginEnabled,
} from './godot-plugin.js';

// Project setup (issue #46): the engine project is made with the engine
// itself, then the app looks at the folder, works out which engine it is,
// and offers a preset of files and settings for working on it together:
// ignore lists, Git LFS, lock rules, bloat check skips, project memory and
// the agent rules in a root AGENTS.md. Presets are plain data, so the
// Unreal and Godot adapters (#10, #11) can build on them. Running setup
// again shows only what is missing or out of date, and never replaces what
// people wrote: lines are added to .gitignore, and the agent rules live in
// their own marked block of AGENTS.md.

// Summer Engine is built on Godot and uses its project files (project.godot,
// .tscn, .tres), so a Summer project is a Godot project here; Summer's MCP
// server is an optional way for agents to drive the editor, not a project type.
export const Engine = z.enum(['generic', 'godot', 'unreal']);
export type Engine = z.infer<typeof Engine>;

export const ENGINE_LABELS: Record<Engine, string> = {
  generic: 'No game engine',
  godot: 'Godot / Summer Engine',
  unreal: 'Unreal Engine',
};

/** The project's own setup settings, committed with it so everyone's app uses the same. */
export const SETUP_CONFIG_PATH = '.collab-tool.json';
export const SETUP_COMMIT_MESSAGE = 'Set up project for collab tool';
export const GODOT_PLUGIN_COMMIT_MESSAGE = 'Add the editor plugin that shows the session’s locks in Godot';
export const CLAUDE_FILE = 'CLAUDE.md';

export const SetupConfig = z.object({
  /** The preset the project was set up with. Early setup files may say "summer", which is Godot now. */
  engine: z.preprocess((value) => (value === 'summer' ? 'godot' : value), Engine),
  /** Files the bloat check leaves out (globs, as in lock rules). */
  bloatSkip: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  /** Unreal: the project folder inside Content, when it is not named like the .uproject. */
  unrealContentFolder: z.string().trim().min(1).max(200).optional(),
  /** Unreal: more top folders in Content the team allows (e.g. a Fab pack), beside the project folder and Common. */
  unrealFolders: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
});
export type SetupConfig = z.infer<typeof SetupConfig>;

export function parseSetupConfig(text: string | null): SetupConfig | null {
  if (!text) return null;
  try {
    const parsed = SetupConfig.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

const EPIC_DOCS = 'https://dev.epicgames.com/documentation/en-us/unreal-engine';
const epic = (page: string) => `${EPIC_DOCS}/${page}?application_version=5.8`;

/** Epic's official pages the Unreal preset treats as the source of truth (UE 5.8). */
export const EPIC_GUIDES = {
  projectStructure: epic('incamera-vfx-project-structure-example-in-unreal-engine'),
  folderStructure: epic('assets-folder-structure-in-unreal-engine'),
  assetNaming: epic('recommended-asset-naming-conventions-in-unreal-engine-projects'),
  codingStandard: epic('epic-cplusplus-coding-standard-for-unreal-engine'),
  sourceControl: epic('source-control-in-unreal-engine'),
  oneFilePerActor: epic('one-file-per-actor-in-unreal-engine'),
};

export const GODOT_GUIDES = {
  versionControl: 'https://docs.godotengine.org/en/stable/tutorials/best_practices/version_control_systems.html',
  projectOrganization: 'https://docs.godotengine.org/en/stable/tutorials/best_practices/project_organization.html',
  styleGuide: 'https://docs.godotengine.org/en/stable/tutorials/scripting/gdscript/gdscript_styleguide.html',
};

export interface Preset {
  engine: Engine;
  /** Lines for .gitignore: engine caches and build output. */
  gitignore: string[];
  /** Patterns stored with Git LFS. */
  lfs: string[];
  /** Exclusive lock patterns added to the session's lock rules. */
  locks: string[];
  /** Generated or engine-owned files the bloat check should not report. */
  bloatSkip: string[];
  /** The engine's part of the agent rules, as Markdown. */
  rules: string[];
  /** Said once in the wizard, for things setup cannot do itself. */
  reminders: string[];
}

const GODOT_RULES = [
  'Godot sources (follow them over your own habits):',
  `- Version control: ${GODOT_GUIDES.versionControl}`,
  `- Project organization: ${GODOT_GUIDES.projectOrganization}`,
  `- GDScript style guide: ${GODOT_GUIDES.styleGuide}`,
  '',
  '- Never commit or edit `.godot/`: it is the editor\'s cache and is made again on import.',
  '- Do not edit `.import` or `.uid` files by hand; Godot writes them.',
  '- `.tscn` and `.tres` are text but merge badly: take an exclusive lock before changing one, and keep the change to what the task needs.',
  '- Refer to files with `res://` paths, and move or rename files in the editor (or through the app) so references are updated.',
  '- Put new scenes, scripts and assets next to the feature they belong to, the way the project already does it; record a new layout choice in project memory.',
  '- The project may be opened in Godot or in Summer Engine (built on Godot, same project files). When the app offers Summer\'s MCP server or the `summer` CLI, change scenes through them, so writes are checked against the latest version.',
];

export const PRESETS: Record<Engine, Preset> = {
  generic: {
    engine: 'generic',
    gitignore: [],
    lfs: [],
    locks: [],
    bloatSkip: [],
    rules: [],
    reminders: [],
  },
  godot: {
    engine: 'godot',
    gitignore: ['.godot/', '/android/'],
    lfs: ['*.png', '*.jpg', '*.webp', '*.exr', '*.hdr', '*.wav', '*.ogg', '*.mp3', '*.glb', '*.fbx', '*.blend', '*.ttf', '*.otf'],
    locks: ['*.tscn', '*.tres', '*.scn', '*.res'],
    bloatSkip: ['.godot/**', '**/*.import', '**/*.uid'],
    rules: GODOT_RULES,
    reminders: [],
  },
  unreal: {
    engine: 'unreal',
    gitignore: [
      'Binaries/',
      'DerivedDataCache/',
      'Intermediate/',
      'Saved/',
      'Plugins/**/Binaries/',
      'Plugins/EngineWire/',
      'Plugins/**/Intermediate/',
      '.vs/',
      '.idea/',
      '*.sln',
      '*.VC.db',
      '*.opensdf',
      '*.sdf',
      '*.suo',
    ],
    lfs: ['*.uasset', '*.umap', '*.fbx', '*.png', '*.tga', '*.exr', '*.hdr', '*.psd', '*.wav'],
    locks: ['*.uasset', '*.umap'],
    // One File Per Actor writes an asset per actor here; they are the level's, not duplicates.
    bloatSkip: ['Content/__ExternalActors__/**', 'Content/__ExternalObjects__/**', 'Content/Developers/**', 'Content/Collections/**'],
    rules: [
      "Epic's official Unreal Engine 5.8 documentation is the source of truth for this project. Follow it over your own habits, and never invent your own layout:",
      `- Project folder structure: ${EPIC_GUIDES.projectStructure}`,
      `- Assets folder structure: ${EPIC_GUIDES.folderStructure}`,
      `- Asset naming: ${EPIC_GUIDES.assetNaming}`,
      `- C++ coding standard: ${EPIC_GUIDES.codingStandard}`,
      `- Source control: ${EPIC_GUIDES.sourceControl}`,
      `- One File Per Actor: ${EPIC_GUIDES.oneFilePerActor}`,
      '',
      "- Place every new asset where Epic's folder structure says: project content in `Content/<Project>/` (a folder named after the project), content shared with other projects in `Content/Common/`. Inside the project folder use Epic's folders: `Assets/` for characters, environments and FX (by type, e.g. `Assets/Chr/`, `Assets/Rocks/`, then one folder per asset), `Envs/` for levels, `Sequences/`, `Media/`, and `Tools/` for utility Blueprints, widgets, structures and enums. Do not create other top-level folders in `Content/`; the app refuses engine calls that would.",
      '- Change `.uasset` and `.umap` files through the Unreal Editor (or the Unreal tools the app gives you), never by writing the files.',
      '- Name assets `[AssetTypePrefix]_[AssetName]_[Descriptor]_[OptionalVariantLetterOrNumber]` with Epic\'s prefixes, e.g. `BP_` Blueprint, `WBP_` Widget Blueprint, `ABP_` Animation Blueprint, `M_` Material, `MI_` Material Instance, `SM_` Static Mesh, `SK_` Skeletal Mesh, `SKEL_` Skeleton, `T_` Texture, `FXS_` Niagara System, `DT_` Data Table. For a type Epic does not list, follow the list as a guide.',
      '- Write C++ to the Epic coding standard (naming prefixes `U`, `A`, `F`, `E`, `I`, `T`, `b` for bools; one class per header).',
      '- `.uasset` and `.umap` are binary and can never be merged: take an exclusive lock before changing one, and do not move or rename assets outside the editor.',
      '- Never commit `Binaries/`, `Intermediate/`, `Saved/` or `DerivedDataCache/`.',
      '- Levels use One File Per Actor, so two people can work in one level; do not turn it off.',
      '- Where Epic gives no recommendation, follow the conventions in project memory, and record any new choice there.',
      '- Review flags assets placed or named outside these rules, and changes outside your task.',
    ],
    reminders: [
      'Turn on One File Per Actor (World Partition levels have it already) in each level\'s World Settings, so two people can edit one map.',
      'Agents reach the Unreal Editor through the EngineWire plugin: add it from Home once on each PC. Unreal builds it from source, so a Blueprint-only project needs one C++ class first (Tools → New C++ Class), and the PC needs Visual Studio with the C++ game development workload.',
    ],
  },
};

/** What the app read from the project folder to plan setup. */
export interface ProjectFacts {
  /** Names in the top folder; folders end in '/'. */
  topFiles: string[];
  /** The .uproject in the top folder, if any. */
  uproject: { name: string; text: string } | null;
  /** project.godot's text, if any. */
  godotProject: string | null;
  config: string | null;
  gitignore: string | null;
  gitattributes: string | null;
  agents: string | null;
  claude: string | null;
  memoryFile: boolean;
  /** git lfs is installed. */
  lfs: boolean;
  /** The app's Godot editor plugin script, if the project has it (addons/collab_tool/plugin.gd). */
  godotPlugin?: string | null;
}

export interface DetectedProject {
  engine: Engine;
  /** e.g. "5.8" or "4.3", when the project says. */
  version: string | null;
  /** The file it was told from. */
  marker: string | null;
  /** The project's name, e.g. the .uproject's. */
  name: string | null;
}

/** Which engine the folder is for: a .uproject means Unreal, project.godot Godot (or Summer Engine, which shares its files). */
export function detectProject(facts: ProjectFacts): DetectedProject {
  if (facts.uproject) {
    let version: string | null = null;
    try {
      const association: unknown = (JSON.parse(facts.uproject.text) as { EngineAssociation?: unknown }).EngineAssociation;
      // A source build is named by a GUID instead of a version.
      if (typeof association === 'string' && /^\d+\.\d+/.test(association)) version = association;
    } catch {
      // Not readable JSON: still an Unreal project.
    }
    return { engine: 'unreal', version, marker: facts.uproject.name, name: facts.uproject.name.replace(/\.uproject$/i, '') };
  }
  if (facts.godotProject !== null) {
    const features = /^config\/features\s*=\s*PackedStringArray\(([^)]*)\)/m.exec(facts.godotProject)?.[1] ?? '';
    const version = /"(\d+\.\d+)"/.exec(features)?.[1] ?? null;
    const name = /^config\/name\s*=\s*"([^"]*)"/m.exec(facts.godotProject)?.[1] ?? null;
    return { engine: 'godot', version, marker: 'project.godot', name };
  }
  return { engine: 'generic', version: null, marker: null, name: null };
}

/**
 * The app's Godot editor plugin in this project: missing, there but older
 * than this app's (or turned off), or up to date. Null when there is no Godot project.
 */
export function godotPluginState(facts: Pick<ProjectFacts, 'godotProject' | 'godotPlugin'>): 'missing' | 'old' | 'ok' | null {
  if (facts.godotProject === null) return null;
  if (facts.godotPlugin == null) return 'missing';
  const current = facts.godotPlugin.replace(/\r\n/g, '\n') === GODOT_PLUGIN_SCRIPT;
  return current && pluginEnabled(facts.godotProject) ? 'ok' : 'old';
}

export const SetupItemId = z.enum(['gitignore', 'gitattributes', 'locks', 'bloat', 'memory', 'agents', 'claude', 'plugin']);
export type SetupItemId = z.infer<typeof SetupItemId>;

/**
 * missing: not there yet; drifted: there, but older than the preset;
 * done: nothing to do; unavailable: cannot be done on this PC (no Git LFS).
 */
export type SetupItemState = 'missing' | 'drifted' | 'done' | 'unavailable';

export interface SetupItem {
  id: SetupItemId;
  label: string;
  /** The file it writes or changes; null for the session's lock rules. */
  file: string | null;
  state: SetupItemState;
  /** What doing it changes, in a sentence. */
  detail: string;
  /** What is added, to show before anything is written. */
  preview: string;
}

export interface SessionFacts {
  lockRules: LockRules;
  memory: MemoryEntry[];
  /** Project memory is rewritten to the repository whenever it changes. */
  memoryAuto: boolean;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const lines = (text: string | null) => (text ?? '').split(/\r?\n/).map((l) => l.trim());

/** The same ignore or attribute rule, written a little differently. */
const ruleKey = (line: string) => line.trim().replace(/^\//, '').replace(/\/$/, '').toLowerCase();

/** Lines of a list-like file (.gitignore) that are not there yet. */
export function missingLines(text: string | null, wanted: string[]): string[] {
  const have = new Set(lines(text).filter((l) => l && !l.startsWith('#')).map(ruleKey));
  return wanted.filter((w) => !have.has(ruleKey(w)));
}

/** .gitattributes patterns not yet stored with LFS. */
export function missingLfs(text: string | null, patterns: string[]): string[] {
  const have = new Set(
    lines(text)
      .filter((l) => /\bfilter=lfs\b/.test(l))
      .map((l) => ruleKey(l.split(/\s+/)[0]!)),
  );
  return patterns.filter((p) => !have.has(ruleKey(p)));
}

export const lfsLine = (pattern: string) => `${pattern} filter=lfs diff=lfs merge=lfs -text`;

const sectionHeader = (engine: Engine) => `# Added by Foreus (${ENGINE_LABELS[engine]} preset)`;

/** Adds lines to the end of a file, under one comment; never removes or reorders what is there. */
export function appendSection(text: string | null, header: string, added: string[]): string {
  const base = (text ?? '').replace(/\r\n/g, '\n');
  if (added.length === 0) return base;
  const head = base.trimEnd();
  return `${head ? `${head}\n\n` : ''}${header}\n${added.join('\n')}\n`;
}

export const RULES_START = '<!-- collab-tool:agent-rules:start -->';
export const RULES_END = '<!-- collab-tool:agent-rules:end -->';

/** The agent rules every project gets, with the engine's part after them. */
export function agentRules(engine: Engine): string {
  const preset = PRESETS[engine];
  const out = [
    RULES_START,
    '<!-- Written by Foreus from its project setup. Run setup again to update this block; text outside it is yours. -->',
    '',
    '# Agent rules',
    '',
    'People and AI agents work on this project together through Foreus. Every agent follows these rules, whichever tool or model it runs on.',
    '',
    '## Before you start',
    '',
    `- Read \`${MEMORY_EXPORT_PATH}\`: architecture decisions, conventions, known issues and current plans. Follow them.`,
    `- Read the \`${NOTE_FILE}\` folder note of each folder you work in, and the ones above it. Use them to find your way instead of reading whole folders.`,
    "- Work only on your task. Stay inside its paths; if the work needs files outside them, stop and ask.",
    '',
    '## While you work',
    '',
    '- Take a lock before changing a file, and wait or ask when someone else holds it. Files in the lock rules (binary or badly mergeable assets) need an exclusive lock.',
    '- Reuse what exists. Look for an existing system before writing a new one, and do not add dependencies or assets the task does not need.',
    '- Keep changes small and easy to review and undo. Do not reformat, move or rename files you are not changing.',
    '- If your change makes a folder note wrong, update that note in the same change. Folder notes are kept up to date by agents; people review them.',
    '- Record new decisions and conventions in project memory, not only in code comments.',
    '- Ask for approval before anything that cannot be undone: deleting files, rewriting history, changing project or engine settings.',
  ];
  if (preset.rules.length) out.push('', `## ${ENGINE_LABELS[engine]}`, '', ...preset.rules);
  out.push(RULES_END);
  return out.join('\n');
}

/** The rules block in a file, if it has one. */
export function rulesBlock(text: string | null): string | null {
  if (!text) return null;
  const normalized = text.replace(/\r\n/g, '\n');
  const start = normalized.indexOf(RULES_START);
  const end = normalized.indexOf(RULES_END, start);
  return start < 0 || end < 0 ? null : normalized.slice(start, end + RULES_END.length);
}

/** AGENTS.md with the current rules: the block replaced, or put at the top above what was there. */
export function withRules(text: string | null, engine: Engine): string {
  const rules = agentRules(engine);
  const normalized = (text ?? '').replace(/\r\n/g, '\n');
  const old = rulesBlock(normalized);
  if (old) return normalized.replace(old, rules);
  const rest = normalized.trim();
  return `${rules}\n${rest ? `\n${rest}\n` : ''}`;
}

/** Claude Code reads CLAUDE.md, not AGENTS.md: one line imports it. */
export const CLAUDE_IMPORT = `@${NOTE_FILE}`;

export function withClaudeImport(text: string | null): string {
  const normalized = (text ?? '').replace(/\r\n/g, '\n');
  if (lines(normalized).includes(CLAUDE_IMPORT)) return normalized;
  const head = normalized.trimEnd();
  return `${head ? `${head}\n\n` : ''}${CLAUDE_IMPORT}\n`;
}

/** The setup file with the engine and the preset's bloat skips; skips people added are kept. */
export function withConfig(text: string | null, engine: Engine): string {
  const old = parseSetupConfig(text);
  const skips = [...(old?.bloatSkip ?? [])];
  for (const skip of PRESETS[engine].bloatSkip) if (!skips.includes(skip)) skips.push(skip);
  const config: SetupConfig = { engine, bloatSkip: skips };
  if (old?.unrealContentFolder) config.unrealContentFolder = old.unrealContentFolder;
  if (old?.unrealFolders) config.unrealFolders = old.unrealFolders;
  return `${JSON.stringify(config, null, 2)}\n`;
}

export const MEMORY_ENGINE_PREFIX = 'Engine:';

/** The starter project memory entry: which engine, which version. */
export function engineEntry(detected: DetectedProject, engine: Engine): { title: string; body: string } {
  if (engine === 'generic') {
    return { title: `${MEMORY_ENGINE_PREFIX} none`, body: 'Not a game engine project. Set up with Foreus\'s generic preset.' };
  }
  const version = detected.version ? ` ${detected.version}` : '';
  // The memory entry names the engine plainly; Summer Engine shares Godot's version numbers.
  const label = engine === 'godot' ? 'Godot' : ENGINE_LABELS[engine];
  const body = [
    `${detected.name ? `${detected.name} is` : 'The project is'} made with ${label}${version}${detected.marker ? ` (${detected.marker})` : ''}.`,
    engine === 'unreal' ? "Stay on this engine version unless the team decides otherwise. Epic's official docs for it are the source of truth (see AGENTS.md)." : '',
  ]
    .filter(Boolean)
    .join(' ');
  return { title: `${MEMORY_ENGINE_PREFIX} ${label}${version}`, body };
}

/** What setup would do for this folder, item by item. Items with nothing in them for the preset are left out. */
export function planSetup(engine: Engine, detected: DetectedProject, facts: ProjectFacts, session: SessionFacts): SetupItem[] {
  const preset = PRESETS[engine];
  const items: SetupItem[] = [];
  const header = sectionHeader(engine);

  if (preset.gitignore.length) {
    const added = missingLines(facts.gitignore, preset.gitignore);
    items.push({
      id: 'gitignore',
      label: 'Ignore engine caches and build output',
      file: '.gitignore',
      state: added.length === 0 ? 'done' : facts.gitignore === null ? 'missing' : 'drifted',
      detail: added.length ? `Adds ${plural(added.length, 'line')}; what is there stays.` : 'Every preset line is there.',
      preview: added.length ? `${header}\n${added.join('\n')}` : '',
    });
  }

  if (preset.lfs.length) {
    const added = missingLfs(facts.gitattributes, preset.lfs);
    items.push({
      id: 'gitattributes',
      label: 'Store binary assets with Git LFS',
      file: '.gitattributes',
      state: added.length === 0 ? 'done' : !facts.lfs ? 'unavailable' : facts.gitattributes === null ? 'missing' : 'drifted',
      detail:
        added.length === 0
          ? 'Every preset type is stored with LFS.'
          : !facts.lfs
            ? 'Git LFS is not installed on this PC. Install it from git-lfs.com, then run setup again.'
            : `Stores ${plural(added.length, 'file type')} with LFS from now on. Files already committed stay as they are.`,
      preview: added.length ? `${header}\n${added.map(lfsLine).join('\n')}` : '',
    });
  }

  if (preset.locks.length) {
    const have = new Set(session.lockRules.exclusivePatterns.map((p) => p.toLowerCase()));
    const added = preset.locks.filter((p) => !have.has(p.toLowerCase()));
    items.push({
      id: 'locks',
      label: 'Lock engine files that cannot be merged',
      file: null,
      state: added.length === 0 ? 'done' : 'drifted',
      detail: added.length ? `Adds ${added.join(', ')} to the session's exclusive lock rules.` : 'The session already locks every preset type.',
      preview: added.join('\n'),
    });
  }

  const config = parseSetupConfig(facts.config);
  const skipsMissing = preset.bloatSkip.filter((s) => !config?.bloatSkip.includes(s));
  items.push({
    id: 'bloat',
    label: preset.bloatSkip.length ? 'Skip generated files in the bloat check' : 'Save the project type',
    file: SETUP_CONFIG_PATH,
    state: !config ? 'missing' : config.engine !== engine || skipsMissing.length ? 'drifted' : 'done',
    detail: preset.bloatSkip.length
      ? `Records the ${ENGINE_LABELS[engine]} preset and the files the bloat check leaves out, for everyone.`
      : 'Records the preset, so everyone\'s app sets the project up the same way.',
    preview: withConfig(facts.config, engine).trimEnd(),
  });

  const entry = engineEntry(detected, engine);
  const engineEntries = session.memory.filter((e) => e.title.startsWith(MEMORY_ENGINE_PREFIX));
  const hasEntry = engineEntries.some((e) => e.title === entry.title);
  items.push({
    id: 'memory',
    label: 'Start project memory in the repository',
    file: MEMORY_EXPORT_PATH,
    state: hasEntry && facts.memoryFile && session.memoryAuto ? 'done' : !hasEntry && !facts.memoryFile ? 'missing' : 'drifted',
    detail: [
      hasEntry ? null : `Adds the decision "${entry.title}".`,
      facts.memoryFile ? null : 'Writes the file.',
      session.memoryAuto ? null : 'Keeps it up to date whenever memory changes.',
    ]
      .filter(Boolean)
      .join(' ') || 'Project memory is written to the repository and kept up to date.',
    preview: `### ${entry.title}\n\n${entry.body}`,
  });

  const block = rulesBlock(facts.agents);
  const rules = agentRules(engine);
  items.push({
    id: 'agents',
    label: 'Write the agent rules',
    file: NOTE_FILE,
    state: block === rules ? 'done' : block ? 'drifted' : 'missing',
    detail:
      block === rules
        ? 'The rules are up to date.'
        : block
          ? 'Replaces the rules block with the current one; the rest of the file stays.'
          : facts.agents
            ? 'Puts the rules at the top; what the file says now stays below them.'
            : 'Read memory and folder notes first, take locks, stay in scope, and the engine\'s dos and don\'ts.',
    preview: rules,
  });

  const plugin = godotPluginState(facts);
  if (engine === 'godot' && plugin) {
    items.push({
      id: 'plugin',
      label: 'Show locks inside the Godot editor',
      file: GODOT_PLUGIN_SCRIPT_PATH,
      state: plugin === 'ok' ? 'done' : plugin === 'missing' ? 'missing' : 'drifted',
      detail:
        plugin === 'ok'
          ? 'The editor plugin is there and turned on.'
          : 'Adds the app\'s editor plugin to addons/collab_tool/ and turns it on in project.godot: a Locks dock in Godot and Summer Engine, a warning when the scene you open is locked by someone else, and a button to lock it.',
      preview: `${GODOT_PLUGIN_CFG_PATH}\n${GODOT_PLUGIN_SCRIPT_PATH}\nproject.godot: [editor_plugins] enabled`,
    });
  }

  const hasImport = lines(facts.claude).includes(CLAUDE_IMPORT);
  items.push({
    id: 'claude',
    label: 'Point Claude Code at the agent rules',
    file: CLAUDE_FILE,
    state: hasImport ? 'done' : facts.claude === null ? 'missing' : 'drifted',
    detail: hasImport ? 'CLAUDE.md already reads AGENTS.md.' : 'Claude Code reads CLAUDE.md; one line makes it read AGENTS.md too.',
    preview: CLAUDE_IMPORT,
  });

  return items;
}

/** Items setup can do now. */
export const todo = (items: SetupItem[]) => items.filter((i) => i.state === 'missing' || i.state === 'drifted');

/** The new text of each file the chosen items change, by path. */
export function setupFiles(engine: Engine, facts: ProjectFacts, chosen: SetupItemId[]): Record<string, string> {
  const preset = PRESETS[engine];
  const header = sectionHeader(engine);
  const out: Record<string, string> = {};
  if (chosen.includes('gitignore')) {
    const added = missingLines(facts.gitignore, preset.gitignore);
    if (added.length) out['.gitignore'] = appendSection(facts.gitignore, header, added);
  }
  if (chosen.includes('gitattributes') && facts.lfs) {
    const added = missingLfs(facts.gitattributes, preset.lfs);
    if (added.length) out['.gitattributes'] = appendSection(facts.gitattributes, header, added.map(lfsLine));
  }
  if (chosen.includes('bloat')) out[SETUP_CONFIG_PATH] = withConfig(facts.config, engine);
  if (chosen.includes('agents')) out[NOTE_FILE] = withRules(facts.agents, engine);
  if (chosen.includes('claude')) out[CLAUDE_FILE] = withClaudeImport(facts.claude);
  if (chosen.includes('plugin') && engine === 'godot' && facts.godotProject !== null) {
    out[GODOT_PLUGIN_CFG_PATH] = GODOT_PLUGIN_CFG;
    out[GODOT_PLUGIN_SCRIPT_PATH] = GODOT_PLUGIN_SCRIPT;
    const enabled = withPluginEnabled(facts.godotProject);
    if (enabled !== facts.godotProject.replace(/\r\n/g, '\n')) out['project.godot'] = enabled;
  }
  return out;
}

/** The session's lock rules with the preset's added. */
export function withPresetLocks(rules: LockRules, engine: Engine): LockRules {
  const have = new Set(rules.exclusivePatterns.map((p) => p.toLowerCase()));
  return { exclusivePatterns: [...rules.exclusivePatterns, ...PRESETS[engine].locks.filter((p) => !have.has(p.toLowerCase()))] };
}

// First commit: agent chats work in their own git worktree, which needs a
// commit to start from, so a repository with none (a new, empty GitHub repo,
// or a folder just made a repository) is offered one. It holds a README, a
// .gitignore and the files project setup wrote, if it ran; everything else
// in the folder stays uncommitted for the person to commit when ready.

export const FIRST_COMMIT_MESSAGE = 'First commit';

/** What any project's .gitignore starts with: files the OS and editors leave around. */
export const BASE_GITIGNORE = ['.DS_Store', 'Thumbs.db', 'desktop.ini', '*.tmp', '*.swp', '.vs/', '.idea/'];

/** Setup's own files, taken into the first commit when they are there. */
export const FIRST_COMMIT_SETUP_FILES = [NOTE_FILE, CLAUDE_FILE, SETUP_CONFIG_PATH, '.gitattributes', MEMORY_EXPORT_PATH];

export interface FirstCommitFile {
  path: string;
  /** Written by the first commit; otherwise it is already in the folder and only committed. */
  isNew: boolean;
}

/**
 * The first commit for a folder: a README named after the project and a
 * .gitignore (with the engine's lines) when they are missing, and whichever of
 * those and setup's files are there already. `present` lists the paths that exist.
 */
export function planFirstCommit(name: string, engine: Engine, present: string[]): { files: FirstCommitFile[]; write: Record<string, string> } {
  const has = (path: string) => present.some((p) => p.toLowerCase() === path.toLowerCase());
  const write: Record<string, string> = {};
  if (!has('README.md')) write['README.md'] = `# ${name}\n`;
  if (!has('.gitignore')) {
    const engineLines = PRESETS[engine].gitignore;
    write['.gitignore'] = appendSection(engineLines.length ? appendSection(null, sectionHeader(engine), engineLines) : null, '# Files the OS and editors make', BASE_GITIGNORE);
  }
  const files: FirstCommitFile[] = ['README.md', '.gitignore', ...FIRST_COMMIT_SETUP_FILES]
    .filter((path) => write[path] !== undefined || has(path))
    .map((path) => ({ path: present.find((p) => p.toLowerCase() === path.toLowerCase()) ?? path, isNew: write[path] !== undefined }));
  return { files, write };
}
