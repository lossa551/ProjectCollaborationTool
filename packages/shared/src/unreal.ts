// Unreal Engine projects (issue #11): where Epic says assets go and what
// they are called. Martin's standing rule is that agents follow Epic's
// official folder structure and asset naming and never invent their own
// layout, so the app checks new assets against the pages below (UE 5.8),
// refuses agent engine calls that would break them, and lists deviations in
// the bloat check. Only what the pages say is checked.
//
// Folder structure (https://dev.epicgames.com/documentation/en-us/unreal-engine/incamera-vfx-project-structure-example-in-unreal-engine):
// project content goes in Content/<a folder named after the project>, content
// shared with other projects in Content/Common, and inside the project folder
// Assets (characters, environments, FX), Envs (levels), Media, Sequences,
// Stages, StageLevels and Tools (utility Blueprints, widgets, structures,
// enums). Naming (recommended-asset-naming-conventions-in-unreal-engine-projects):
// [AssetTypePrefix]_[AssetName]_[Descriptor]_[OptionalVariantLetterOrNumber].

import { EPIC_GUIDES } from './setup.js';

/** Epic's prefixes, by asset type (the list is not exhaustive; Epic says to follow it as a guide). */
export const EPIC_PREFIXES: Record<string, string> = {
  HDR_: 'HDRI',
  M_: 'Material',
  MI_: 'Material Instance',
  PHYS_: 'Physics Asset',
  PM_: 'Physics Material',
  PPM_: 'Post Process Material',
  SK_: 'Skeletal Mesh',
  SM_: 'Static Mesh',
  T_: 'Texture',
  OCIO_: 'OCIO Profile',
  AC_: 'Actor Component',
  ABP_: 'Animation Blueprint',
  BI_: 'Blueprint Interface',
  BP_: 'Blueprint',
  CT_: 'Curve Table',
  DT_: 'Data Table',
  E_: 'Enum',
  F_: 'Structure',
  WBP_: 'Widget Blueprint',
  FXE_: 'Niagara Emitter',
  FXS_: 'Niagara System',
  FXF_: 'Niagara Function',
  Rig_: 'Rig',
  SKEL_: 'Skeleton',
  AM_: 'Montage',
  AS_: 'Animation Sequence',
  BS_: 'Blend Space',
  NDC_: 'nDisplay Configuration',
  LS_: 'Level Sequence',
  EDIT_: 'Sequencer Edit',
  MS_: 'Media Source',
  MO_: 'Media Output',
  MP_: 'Media Player',
  MPR_: 'Media Profile',
  SNAP_: 'Level Snapshot',
  RCP_: 'Remote Control Preset',
};

/** The folders Epic puts inside the project folder. */
export const EPIC_PROJECT_FOLDERS = ['Assets', 'Envs', 'Media', 'Sequences', 'Stages', 'StageLevels', 'Tools'];
/** Where Epic puts levels. */
const LEVEL_FOLDERS = ['Envs', 'StageLevels'];
/** Content folders the engine itself makes and owns. */
export const ENGINE_CONTENT_FOLDERS = ['Developers', 'Collections', '__ExternalActors__', '__ExternalObjects__'];

/** How one Unreal project is laid out, as the checks need it. */
export interface UnrealLayout {
  /** The project's Content folder, repo-relative ('Content', or 'Game/Content' when the .uproject is one folder down). */
  contentDir: string;
  /** The project folder inside Content (the .uproject's name unless setup says otherwise). */
  projectFolder: string;
  /** More top folders in Content the team allowed (e.g. a Fab pack), from .collab-tool.json. */
  extraFolders: string[];
}

/** The layout for a project whose .uproject is at uprojectPath (repo-relative). */
export function unrealLayout(uprojectPath: string, config?: { unrealContentFolder?: string; unrealFolders?: string[] } | null): UnrealLayout {
  const slash = uprojectPath.lastIndexOf('/');
  const dir = slash >= 0 ? uprojectPath.slice(0, slash) : '';
  const name = uprojectPath.slice(slash + 1).replace(/\.uproject$/i, '');
  return {
    contentDir: dir ? `${dir}/Content` : 'Content',
    projectFolder: config?.unrealContentFolder?.trim() || name,
    extraFolders: config?.unrealFolders ?? [],
  };
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The Epic prefix a name starts with, if any. */
export function epicPrefixOf(name: string): string | null {
  const head = /^([A-Za-z]+_)/.exec(name)?.[1];
  return head && head in EPIC_PREFIXES ? head : null;
}

/**
 * What a .uasset or .umap at this path does against Epic's structure and
 * naming; empty when it follows them or is not project content (plugins,
 * engine-owned folders). expected: the prefixes the asset's type takes, when
 * the caller knows the type (e.g. the engine call that makes it).
 */
export function epicLayoutProblems(path: string, layout: UnrealLayout, expected: string[] = []): string[] {
  const root = `${layout.contentDir}/`;
  if (!path.toLowerCase().startsWith(root.toLowerCase())) return [];
  const parts = path.slice(root.length).split('/');
  const file = parts.pop() ?? '';
  const level = /\.umap$/i.test(file);
  if (!level && !/\.uasset$/i.test(file)) return [];
  const top = parts[0];
  if (top && ENGINE_CONTENT_FOLDERS.some((f) => same(f, top))) return [];
  if (top && layout.extraFolders.some((f) => same(f, top))) return [];
  const problems: string[] = [];
  const name = file.replace(/\.(uasset|umap)$/i, '');
  const project = `${layout.contentDir}/${layout.projectFolder}/`;
  if (!top || (!same(top, layout.projectFolder) && !same(top, 'Common'))) {
    problems.push(`it is outside ${project} (Epic: project content goes in a folder named after the project, shared content in Content/Common)`);
  } else if (same(top, layout.projectFolder)) {
    const second = parts[1];
    if (!second || !EPIC_PROJECT_FOLDERS.some((f) => same(f, second))) {
      problems.push(`it is not in one of Epic's project folders (${EPIC_PROJECT_FOLDERS.map((f) => `${project}${f}/`).join(', ')})`);
    } else if (level && !LEVEL_FOLDERS.some((f) => same(f, second))) {
      problems.push(`levels go in ${project}Envs/ (or StageLevels/ for stage levels), per Epic`);
    }
  }
  if (!level) {
    const prefix = epicPrefixOf(name);
    if (expected.length && !expected.some((p) => name.startsWith(p))) {
      problems.push(`a ${EPIC_PREFIXES[expected[0]!] ?? 'asset'} is named ${expected.join(' or ')}<Name> by Epic's naming conventions`);
    } else if (!expected.length && !prefix && !/^[A-Z][A-Za-z0-9]*_/.test(name)) {
      problems.push(`the name has no asset type prefix (Epic: [AssetTypePrefix]_[AssetName]_[Descriptor]_[Variant], e.g. SM_Rock_A)`);
    }
  }
  return problems;
}

/** One sentence for a chat notice or the bloat check, with the Epic pages. */
export function describeLayoutProblems(path: string, problems: string[]): string {
  return `${path}: ${problems.join('; ')}. See ${EPIC_GUIDES.folderStructure} and ${EPIC_GUIDES.assetNaming}.`;
}

/**
 * An Unreal object path (/Game/Maps/L_Main, /Game/Maps/L_Main.L_Main,
 * /Game/X/BP_Door.BP_Door_C) as the package's folder and name inside
 * Content, e.g. "Maps/L_Main"; plugin mounts (/MyPlugin/...) give the mount
 * too. Null for engine and script packages.
 */
export function objectPathParts(raw: string): { mount: string; rel: string } | null {
  const path = raw.trim().replace(/^"|"$/g, '').replace(/\\/g, '/');
  const m = /^\/([A-Za-z0-9_]+)\/([^.:'"\s][^.:'"]*)/.exec(path);
  if (!m) return null;
  const mount = m[1]!;
  if (/^(Engine|Script|Temp|Memory|Config|Niagara|Paper2D|Saved|tmp)$/i.test(mount)) return null;
  const rel = m[2]!.replace(/\/+$/, '');
  if (!rel || rel.split('/').some((p) => p === '..' || p === '.')) return null;
  return { mount, rel };
}
