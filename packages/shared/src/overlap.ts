import { pullForBranch, type GitHubStatus, type Lock, type Task, type Workspace } from './model.js';
import { matchesAny } from './paths.js';

// Who else is changing the same file: local workspaces, pushed branches, open
// pull requests and locks. Two sources on the same branch, or from the same
// person, are one piece of work and never overlap with each other.

export type WorkSource =
  | { kind: 'workspace'; participantId: string; name: string; branch: string | null }
  | { kind: 'pull'; number: number; title: string; branch: string }
  | { kind: 'branch'; branch: string }
  | { kind: 'lock'; lockId: string; holderId: string; name: string; taskId: string | null; exclusive: boolean };

export interface Overlap {
  path: string;
  sources: WorkSource[];
}

export interface WorkspaceEntry {
  participantId: string;
  name: string;
  workspace: Workspace;
}

export function findOverlaps(input: { workspaces: WorkspaceEntry[]; github: GitHubStatus; locks: Lock[] }): Overlap[] {
  const { workspaces, github, locks } = input;
  const byPath = new Map<string, { path: string; sources: WorkSource[] }>();
  const add = (path: string, source: WorkSource) => {
    const key = path.toLowerCase();
    let entry = byPath.get(key);
    if (!entry) byPath.set(key, (entry = { path, sources: [] }));
    entry.sources.push(source);
  };

  for (const { participantId, name, workspace } of workspaces) {
    for (const file of workspace.files) add(file.path, { kind: 'workspace', participantId, name, branch: workspace.branch });
  }
  const openPulls = github.pulls.filter((p) => p.state === 'open');
  for (const pull of openPulls) {
    for (const path of pull.files) add(path, { kind: 'pull', number: pull.number, title: pull.title, branch: pull.branch });
  }
  for (const branch of github.branches) {
    if (!branch.files || openPulls.some((p) => p.branch === branch.name)) continue;
    for (const path of branch.files) add(path, { kind: 'branch', branch: branch.name });
  }
  for (const lock of locks) {
    add(lock.path, {
      kind: 'lock',
      lockId: lock.id,
      holderId: lock.holder.id,
      name: lock.holder.name,
      taskId: lock.taskId,
      exclusive: lock.kind === 'exclusive',
    });
  }

  const overlaps: Overlap[] = [];
  for (const entry of byPath.values()) {
    if (entry.sources.length > 1 && countGroups(entry.sources, github.defaultBranch) > 1) overlaps.push(entry);
  }
  return overlaps.sort((a, b) => a.path.localeCompare(b.path));
}

/** Keys that tie sources into one piece of work. The default branch is shared by everyone, so it ties nothing. */
function workKeys(source: WorkSource, defaultBranch: string | null): string[] {
  const branch = (name: string | null) => (name && name !== defaultBranch ? [`b:${name}`] : []);
  switch (source.kind) {
    case 'workspace':
      return [`p:${source.participantId}`, ...branch(source.branch)];
    case 'pull':
    case 'branch':
      return branch(source.branch);
    case 'lock':
      return [`p:${source.holderId}`];
  }
}

function countGroups(sources: WorkSource[], defaultBranch: string | null): number {
  // Union-find over sources, joined whenever they share a key.
  const parent = sources.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const owner = new Map<string, number>();
  sources.forEach((source, i) => {
    for (const key of workKeys(source, defaultBranch)) {
      const j = owner.get(key);
      if (j === undefined) owner.set(key, i);
      else parent[find(i)] = find(j);
    }
  });
  return new Set(sources.map((_, i) => find(i))).size;
}

/** Whether a source is part of this task's work. */
export function belongsToTask(source: WorkSource, task: Task): boolean {
  if (source.kind === 'lock') return source.taskId === task.id;
  return !!task.branch && source.branch === task.branch;
}

/** Overlaps that touch this task, with only the other side's sources. */
export function overlapsForTask(overlaps: Overlap[], task: Task): Overlap[] {
  return overlaps.flatMap((overlap) => {
    if (!overlap.sources.some((s) => belongsToTask(s, task))) return [];
    const others = overlap.sources.filter((s) => !belongsToTask(s, task));
    return others.length > 0 ? [{ path: overlap.path, sources: others }] : [];
  });
}

/** Files a task is not supposed to change. A task without a scope allows everything. */
/** Files changed for a task: in anyone's workspace on its branch, its open pull request, or its branch on GitHub. */
export function taskChangedFiles(task: Task, workspaces: Record<string, Workspace>, github: GitHubStatus): string[] {
  if (!task.branch) return [];
  const pull = pullForBranch(github, task.branch);
  return [
    ...new Set([
      ...Object.values(workspaces)
        .filter((w) => w.branch === task.branch)
        .flatMap((w) => w.files.map((f) => f.path)),
      ...(pull?.state === 'open' ? pull.files : []),
      ...(github.branches.find((b) => b.name === task.branch)?.files ?? []),
    ]),
  ];
}

export function filesOutsideScope(paths: string[], scope: string[]): string[] {
  return scope.length === 0 ? [] : paths.filter((path) => !matchesAny(path, scope));
}

/** Short description of a source for warnings, e.g. "Lina's workspace" or "PR #12". */
export function describeSource(source: WorkSource, youId: string | null): string {
  switch (source.kind) {
    case 'workspace':
      return source.participantId === youId ? 'your workspace' : `${source.name}'s workspace`;
    case 'pull':
      return `PR #${source.number}`;
    case 'branch':
      return `branch ${source.branch}`;
    case 'lock':
      return `${source.holderId === youId ? 'your' : `${source.name}'s`} ${source.exclusive ? 'exclusive ' : ''}lock`;
  }
}
