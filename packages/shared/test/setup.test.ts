import { describe, expect, it } from 'vitest';
import {
  CLAUDE_IMPORT,
  DEFAULT_LOCK_RULES,
  EPIC_GUIDES,
  RULES_END,
  RULES_START,
  agentRules,
  appendSection,
  detectProject,
  missingLfs,
  missingLines,
  parseSetupConfig,
  planSetup,
  rulesBlock,
  setupFiles,
  todo,
  withClaudeImport,
  withConfig,
  withPresetLocks,
  withRules,
  type MemoryEntry,
  type ProjectFacts,
} from '../src/index.js';

const facts = (changes: Partial<ProjectFacts> = {}): ProjectFacts => ({
  topFiles: [],
  uproject: null,
  godotProject: null,
  config: null,
  gitignore: null,
  gitattributes: null,
  agents: null,
  claude: null,
  memoryFile: false,
  lfs: true,
  ...changes,
});

const session = { lockRules: DEFAULT_LOCK_RULES, memory: [] as MemoryEntry[], memoryAuto: false };

describe('detectProject', () => {
  it('finds Unreal from the .uproject and reads its engine version', () => {
    const detected = detectProject(facts({ uproject: { name: 'Shooter.uproject', text: '{"FileVersion":3,"EngineAssociation":"5.8"}' } }));
    expect(detected).toEqual({ engine: 'unreal', version: '5.8', marker: 'Shooter.uproject', name: 'Shooter' });
  });

  it('leaves the version out for a source build', () => {
    expect(detectProject(facts({ uproject: { name: 'A.uproject', text: '{"EngineAssociation":"{1A2B-33}"}' } })).version).toBeNull();
  });

  it('finds Godot from project.godot, with its name and version', () => {
    const godot = '[application]\nconfig/name="Moss"\nconfig/features=PackedStringArray("4.3", "Forward Plus")\n';
    expect(detectProject(facts({ godotProject: godot }))).toEqual({ engine: 'godot', version: '4.3', marker: 'project.godot', name: 'Moss' });
  });

  it('treats a Summer Engine project as Godot, also from an early setup file', () => {
    expect(detectProject(facts({ godotProject: '', config: '{"engine":"summer","bloatSkip":[]}' })).engine).toBe('godot');
    expect(parseSetupConfig('{"engine":"summer","bloatSkip":[]}')?.engine).toBe('godot');
  });

  it('is generic otherwise, whatever the setup file says', () => {
    expect(detectProject(facts({ config: '{"engine":"unreal"}' })).engine).toBe('generic');
  });
});

describe('list files', () => {
  it('adds only the lines that are missing, matching / variants', () => {
    expect(missingLines('# cache\n/Binaries\nSaved/\n', ['Binaries/', 'Saved/', 'Intermediate/'])).toEqual(['Intermediate/']);
  });

  it('appends under one comment and keeps what is there', () => {
    expect(appendSection('node_modules/\r\n', '# Added', ['.godot/'])).toBe('node_modules/\n\n# Added\n.godot/\n');
    expect(appendSection(null, '# Added', ['.godot/'])).toBe('# Added\n.godot/\n');
    expect(appendSection('x\n', '# Added', [])).toBe('x\n');
  });

  it('counts a pattern as stored with LFS only with filter=lfs', () => {
    expect(missingLfs('*.uasset filter=lfs diff=lfs merge=lfs -text\n*.umap binary\n', ['*.uasset', '*.umap'])).toEqual(['*.umap']);
  });
});

describe('agent rules', () => {
  it('cite Epic’s UE 5.8 docs as the source of truth for Unreal', () => {
    const rules = agentRules('unreal');
    for (const url of Object.values(EPIC_GUIDES)) {
      expect(rules).toContain(url);
      expect(url).toContain('application_version=5.8');
    }
    expect(rules).toContain('never invent your own layout');
    expect(rules).toContain('`BP_` Blueprint');
    expect(rules).toContain('docs/project-memory.md');
  });

  it('have no engine section for a generic project', () => {
    expect(agentRules('generic')).not.toMatch(/^## (Godot|Unreal)/m);
    expect(agentRules('generic')).toContain('# Agent rules');
  });

  it('go above what AGENTS.md said, and replace only their own block later', () => {
    const first = withRules('# Top folder\n\nNotes about the code.\n', 'godot');
    expect(first.startsWith(RULES_START)).toBe(true);
    expect(first).toContain('Notes about the code.');
    const later = withRules(first.replace('Godot sources', 'Old text'), 'unreal');
    expect(rulesBlock(later)).toBe(agentRules('unreal'));
    expect(later).toContain('Notes about the code.');
    expect(later.match(new RegExp(RULES_END, 'g'))).toHaveLength(1);
  });

  it('are imported by CLAUDE.md once', () => {
    expect(withClaudeImport(null)).toBe(`${CLAUDE_IMPORT}\n`);
    const own = withClaudeImport('Use pnpm.\n');
    expect(own).toBe(`Use pnpm.\n\n${CLAUDE_IMPORT}\n`);
    expect(withClaudeImport(own)).toBe(own);
  });
});

describe('setup file', () => {
  it('keeps skips people added and adds the preset’s', () => {
    const text = withConfig('{"engine":"godot","bloatSkip":["art/raw/**"]}', 'unreal');
    expect(parseSetupConfig(text)).toEqual({
      engine: 'unreal',
      bloatSkip: ['art/raw/**', 'Content/__ExternalActors__/**', 'Content/__ExternalObjects__/**', 'Content/Developers/**', 'Content/Collections/**'],
    });
  });

  it('ignores a file that is not ours', () => {
    expect(parseSetupConfig('not json')).toBeNull();
    expect(parseSetupConfig('{"engine":"cryengine"}')).toBeNull();
  });
});

describe('planSetup', () => {
  const unreal = facts({ uproject: { name: 'Shooter.uproject', text: '{"EngineAssociation":"5.8"}' } });

  it('offers every item for a new Unreal project', () => {
    const items = planSetup('unreal', detectProject(unreal), unreal, session);
    expect(items.map((i) => [i.id, i.state])).toEqual([
      ['gitignore', 'missing'],
      ['gitattributes', 'missing'],
      ['locks', 'drifted'],
      ['bloat', 'missing'],
      ['memory', 'missing'],
      ['agents', 'missing'],
      ['claude', 'missing'],
    ]);
    expect(items.find((i) => i.id === 'locks')!.preview).toBe('*.uasset\n*.umap');
    expect(items.find((i) => i.id === 'memory')!.preview).toContain('Engine: Unreal Engine 5.8');
  });

  it('says LFS needs installing instead of writing it', () => {
    const items = planSetup('unreal', detectProject(unreal), { ...unreal, lfs: false }, session);
    expect(items.find((i) => i.id === 'gitattributes')!.state).toBe('unavailable');
    expect(setupFiles('unreal', { ...unreal, lfs: false }, ['gitattributes'])).toEqual({});
  });

  it('has nothing left to do after it ran', () => {
    const files = setupFiles('unreal', unreal, ['gitignore', 'gitattributes', 'bloat', 'agents', 'claude']);
    const after: ProjectFacts = {
      ...unreal,
      gitignore: files['.gitignore']!,
      gitattributes: files['.gitattributes']!,
      config: files['.collab-tool.json']!,
      agents: files['AGENTS.md']!,
      claude: files['CLAUDE.md']!,
      memoryFile: true,
    };
    const memory = [{ id: 'e1', kind: 'decision', title: 'Engine: Unreal Engine 5.8', body: '', createdBy: 'M', createdAt: 1, updatedAt: 1, source: null }] as MemoryEntry[];
    const items = planSetup('unreal', detectProject(after), after, { lockRules: withPresetLocks(DEFAULT_LOCK_RULES, 'unreal'), memory, memoryAuto: true });
    expect(todo(items)).toEqual([]);
  });

  it('shows drift when the preset changed since', () => {
    const old = facts({ godotProject: '', gitignore: '.godot/\n', agents: `${RULES_START}\nold rules\n${RULES_END}\n` });
    const items = planSetup('godot', detectProject(old), old, session);
    expect(items.find((i) => i.id === 'gitignore')).toMatchObject({ state: 'drifted', preview: expect.stringContaining('/android/') });
    expect(items.find((i) => i.id === 'agents')!.state).toBe('drifted');
  });

  it('leaves out items a generic project has nothing for', () => {
    const items = planSetup('generic', detectProject(facts()), facts(), session);
    expect(items.map((i) => i.id)).toEqual(['bloat', 'memory', 'agents', 'claude']);
    expect(items[0]!.label).toBe('Save the project type');
  });
});

describe('withPresetLocks', () => {
  it('adds the engine’s patterns once', () => {
    const once = withPresetLocks(DEFAULT_LOCK_RULES, 'godot');
    expect(once.exclusivePatterns.slice(-4)).toEqual(['*.tscn', '*.tres', '*.scn', '*.res']);
    expect(withPresetLocks(once, 'godot')).toEqual(once);
  });
});
