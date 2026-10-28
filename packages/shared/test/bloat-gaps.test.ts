import { describe, expect, it } from 'vitest';
import { analyzeBloat, bloatItemKeys, codeTokens, findNearDuplicates, findUnusedPlugins, markNewSince, type ScannedFile } from '@pct/shared';

const file = (path: string, text: string | null = '', extra: Partial<ScannedFile> = {}): ScannedFile => ({ path, size: text?.length ?? 100, hash: null, text, ...extra });

const inventory = `class_name Inventory
extends Node
# Holds the player's items.
signal changed
var slots: Array = []
var capacity := 20

func add(item, count := 1) -> bool:
	if slots.size() >= capacity:
		return false
	for slot in slots:
		if slot.item == item and slot.count + count <= 99:
			slot.count += count
			changed.emit()
			return true
	slots.append({"item": item, "count": count})
	changed.emit()
	return true

func remove(item, count := 1) -> bool:
	for slot in slots:
		if slot.item == item:
			slot.count -= count
			if slot.count <= 0:
				slots.erase(slot)
			changed.emit()
			return true
	return false
`;

describe('near-duplicate code', () => {
  it('drops comments, strings and numbers from the tokens', () => {
    expect(codeTokens('var a = "hi" # note\nvar b = 42', 'gd')).toEqual(['var', 'a', '=', '"s"', 'var', 'b', '=', '0']);
    expect(codeTokens('const x = 1; // note\n/* block */ call(`t`)', 'ts')).toEqual(['const', 'x', '=', '0', ';', 'call', '(', '"s"', ')']);
  });

  it('finds a system copied to another folder and tweaked, with the share in common', () => {
    const tweaked = inventory
      .replace('class_name Inventory', 'class_name ChestStorage')
      .replace("# Holds the player's items.", '# Holds what a chest has.')
      .replace('var capacity := 20', 'var capacity := 40')
      .replace('<= 99', '<= 50');
    const pairs = findNearDuplicates([
      file('scripts/player/inventory.gd', inventory),
      file('scripts/world/chest_storage.gd', tweaked),
      file('scripts/world/door.gd', 'extends Node\nfunc open():\n\tpass\n'.repeat(3)),
      file('test/test_inventory.gd', inventory),
    ]);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.paths).toEqual(['scripts/player/inventory.gd', 'scripts/world/chest_storage.gd']);
    expect(pairs[0]!.reason).toBe('similar');
    expect(pairs[0]!.similarity).toBeGreaterThan(0.8);
  });

  it('leaves different code alone and does not repeat identical files', () => {
    const other = Array.from({ length: 30 }, (_, i) => `func step_${i}(delta):\n\tposition.x += speed_${i} * delta\n`).join('');
    const report = analyzeBloat(
      [
        file('a/inventory.gd', inventory, { hash: 'h1', size: 900 }),
        file('b/inventory_copy.gd', inventory, { hash: 'h1', size: 900 }),
        file('c/mover.gd', other),
      ],
      { ranBy: 'Martin', branch: 'main', truncated: false },
    );
    expect(report.duplicates.map((d) => d.reason)).toEqual(['identical']);
  });
});

describe('unused add-ons and plugins', () => {
  it('finds Godot add-ons nobody enables or loads', () => {
    const plugins = findUnusedPlugins([
      file('project.godot', '[application]\nrun/main_scene="res://main.tscn"\n\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/dialogue/plugin.cfg")\n'),
      file('main.tscn', '[gd_scene format=3]\n[ext_resource path="res://addons/tween_kit/tween_kit.gd"]\n'),
      file('player.gd', 'var path := AStarGrid.new()\n'),
      file('addons/dialogue/plugin.cfg', '[plugin]\nname="Dialogue"\n'),
      file('addons/old_editor_tool/plugin.cfg', '[plugin]\nname="Old tool"\n'),
      file('addons/old_editor_tool/tool.gd', 'extends EditorPlugin\n'),
      file('addons/tween_kit/tween_kit.gd', 'extends Node\n'),
      file('addons/astar_grid/grid.gd', 'class_name AStarGrid\nextends RefCounted\n'),
      file('addons/unused_lib/lib.gd', 'class_name NeverUsed\n'),
    ]);
    expect(plugins).toEqual([
      { engine: 'godot', path: 'addons/old_editor_tool', name: 'old_editor_tool', detail: 'Not enabled in project.godot, and nothing outside it loads it' },
      { engine: 'godot', path: 'addons/unused_lib', name: 'unused_lib', detail: 'Nothing outside it loads its files or uses its classes' },
    ]);
  });

  it('finds Unreal plugins the .uproject turns off', () => {
    const plugins = findUnusedPlugins([
      file('Shooter.uproject', JSON.stringify({ Plugins: [{ Name: 'OldWeapons', Enabled: false }, { Name: 'Gameplay', Enabled: true }, { Name: 'Helper', Enabled: false }] })),
      file('Plugins/OldWeapons/OldWeapons.uplugin', JSON.stringify({ FriendlyName: 'Old weapons' })),
      file('Plugins/Gameplay/Gameplay.uplugin', JSON.stringify({ Plugins: [{ Name: 'Helper', Enabled: true }] })),
      file('Plugins/Helper/Helper.uplugin', '{}'),
      file('Plugins/Tools/Experimental/Experimental.uplugin', JSON.stringify({ EnabledByDefault: false })),
      file('Plugins/OnByDefault/OnByDefault.uplugin', '{}'),
    ]);
    expect(plugins).toEqual([
      { engine: 'unreal', path: 'Plugins/OldWeapons', name: 'OldWeapons', detail: 'Turned off in Shooter.uproject but kept in Plugins/' },
      { engine: 'unreal', path: 'Plugins/Tools/Experimental', name: 'Experimental', detail: 'Off by default and not turned on in Shooter.uproject' },
    ]);
  });
});

describe('Git LFS pointers and new findings', () => {
  it('lists pointers as not pulled and says why the Unreal check was skipped', () => {
    const report = analyzeBloat(
      [
        file('Game.uproject', '{}'),
        file('Content/Maps/L_Main.umap', null, { lfs: true }),
        file('Content/Props/SM_Box.uasset', null, { refs: [] }),
      ],
      { ranBy: 'Martin', branch: 'main', truncated: false },
    );
    expect(report.notPulled).toEqual(['Content/Maps/L_Main.umap']);
    expect(report.notPulledCount).toBe(1);
    expect(report.unusedGameFiles).toEqual([]);
    expect(report.skipped).toEqual([
      'Unused Unreal assets in Content: 1 used asset is a Git LFS pointer (not pulled), so what it uses is unknown. Run git lfs pull, then check again.',
    ]);
  });

  it('marks the findings the previous scan did not have', () => {
    const scan = (assets: string[], at: number) =>
      analyzeBloat(
        assets.map((p) => file(p, null)),
        { ranBy: 'Martin', branch: 'main', truncated: false, trigger: 'daily' },
        at,
      );
    const first = markNewSince(scan(['art/a.png'], 1), null);
    expect(first.newKeys).toEqual([]);
    const second = markNewSince(scan(['art/a.png', 'art/b.png'], 2), first);
    expect(second).toMatchObject({ previousAt: 1, newKeys: ['asset:art/b.png'], trigger: 'daily' });
    expect(bloatItemKeys(second)).toEqual(['asset:art/a.png', 'asset:art/b.png']);
  });
});
