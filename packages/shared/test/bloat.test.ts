import { describe, expect, it } from 'vitest';
import { analyzeBloat, type ScannedFile } from '@pct/shared';

const file = (path: string, text: string | null = '', hash: string | null = null, size = 100): ScannedFile => ({ path, size, hash, text });

describe('bloat check', () => {
  it('finds identical files and code files with the same name in different folders', () => {
    const report = analyzeBloat(
      [
        file('art/hero.png', null, 'aaa'),
        file('art/old/hero_copy.png', null, 'aaa'),
        file('.gitkeep', '', 'empty', 0),
        file('src/.gitkeep', '', 'empty', 0),
        file('scripts/player/PlayerController.gd', 'extends Node', 'p1'),
        file('scripts/legacy/player_controller.gd', 'extends Node2D', 'p2'),
        file('src/index.ts', '', 'i1'),
        file('lib/index.ts', '', 'i2'),
        file('src/menu.ts', '', 'm1'),
        file('test/menu.test.ts', '', 'm2'),
        file('scenes/main.tscn', '[ext_resource path="res://art/hero.png"]\n[ext_resource path="res://art/old/hero_copy.png"]'),
        // Separate packages may mirror each other's names, and each has its own tsconfig.
        file('packages/server/package.json', '{}'),
        file('packages/server/src/storage.ts', '', 's1'),
        file('packages/server/tsconfig.json', '', 'tsc', 200),
        file('packages/app/package.json', '{}'),
        file('packages/app/src/storage.ts', '', 's2'),
        file('packages/app/tsconfig.json', '', 'tsc', 200),
        file('packages/app/src/Storage.tsx', '', 's3'),
      ],
      { ranBy: 'Martin', branch: 'main', truncated: false },
    );
    expect(report.duplicates).toEqual([
      { reason: 'identical', paths: ['art/hero.png', 'art/old/hero_copy.png'] },
      { reason: 'same-name', paths: ['scripts/player/PlayerController.gd', 'scripts/legacy/player_controller.gd'] },
    ]);
  });

  it('finds assets nothing refers to', () => {
    const report = analyzeBloat(
      [
        file('art/hero.png', null),
        file('art/Unused Tree.png', null),
        file('art/unused_tree.png.import', 'source_file="res://art/unused_tree.png"'),
        file('audio/jump.ogg', null),
        file('audio/old_jump.wav', null),
        file('scripts/player.gd', 'var sfx = preload("res://audio/jump.ogg")'),
        file('scenes/main.tscn', 'path="res://art/hero.png"'),
      ],
      { ranBy: 'Martin', branch: null, truncated: false },
    );
    expect(report.unusedAssets).toEqual(['art/Unused Tree.png', 'audio/old_jump.wav']);
  });

  it('finds dependencies nothing imports or runs', () => {
    const report = analyzeBloat(
      [
        file(
          'package.json',
          JSON.stringify({
            name: 'game-tools',
            scripts: { build: 'tsc -p . && vite build', test: 'vitest run' },
            dependencies: { zod: '1', lodash: '1', '@scope/ui': '1', 'tools-shared': '1' },
            devDependencies: { typescript: '5', vite: '7', vitest: '5', '@types/node': '22', 'left-pad': '1' },
          }),
        ),
        file('src/a.ts', "import { z } from 'zod';\nimport { Button } from \"@scope/ui/button\";"),
        file('shared/package.json', JSON.stringify({ name: 'tools-shared', dependencies: { yaml: '2' } })),
        file('package-lock.json', '"lodash": {}, "left-pad": {}'),
      ],
      { ranBy: 'Martin', branch: null, truncated: false },
    );
    expect(report.unusedDependencies).toEqual([
      { manifest: 'package.json', name: 'lodash', dev: false },
      { manifest: 'package.json', name: 'left-pad', dev: true },
      { manifest: 'shared/package.json', name: 'yaml', dev: false },
    ]);
  });

  it('in a Godot project, reports what the game never loads: from project.godot through res://, uid:// and class_name', () => {
    const report = analyzeBloat(
      [
        file('README.md', 'See game/art/logo.png'),
        file('promo/banner.png', null),
        file('game/project.godot', '[application]\nrun/main_scene="res://scenes/main.tscn"\nconfig/icon="res://icon.svg"\n[autoload]\nScore="*res://autoload/score.gd"\n'),
        file('game/icon.svg', '<svg/>'),
        file('game/autoload/score.gd', 'extends Node\nvar sfx = preload("uid://bcoin")\n'),
        file('game/sfx/coin.wav', null),
        file('game/sfx/coin.wav.import', '[remap]\nimporter="wav"\nuid="uid://bcoin"\n'),
        file('game/scenes/main.tscn', '[gd_scene format=3 uid="uid://main"]\n[ext_resource type="Script" path="res://scenes/main.gd" id="1"]\n'),
        file('game/scenes/main.gd', 'extends Node2D\nvar enemy := Enemy.new()\nvar boss = load("boss.tscn")\n'),
        file('game/scenes/boss.tscn', '[gd_scene format=3]\n[ext_resource path="res://art/boss.png"]\n'),
        file('game/art/boss.png', null),
        file('game/enemies/enemy.gd', 'class_name Enemy\nextends Node2D\n'),
        // Never reached: an old level, its script and art, and a resource.
        file('game/scenes/old_level.tscn', '[gd_scene format=3]\n[ext_resource path="res://scenes/old_level.gd"]\n[ext_resource path="res://art/old_bg.png"]\n'),
        file('game/scenes/old_level.gd', 'extends Node\n'),
        file('game/art/old_bg.png', null),
        file('game/art/logo.png', null),
        file('game/themes/unused.tres', '[gd_resource type="Theme" format=3]\n'),
        // Add-ons and tests are the editor's and the test runner's.
        file('game/addons/gut/gut.gd', 'extends Node\n'),
        file('game/test/test_score.gd', 'extends GutTest\n'),
      ],
      { ranBy: 'Martin', branch: 'main', truncated: false },
    );
    expect(report.unusedGameFiles).toEqual(['game/scenes/old_level.tscn', 'game/scenes/old_level.gd', 'game/themes/unused.tres']);
    // Inside the project only what the game loads counts (the README naming logo.png does not); outside it, names do.
    expect(report.unusedAssets).toEqual(['game/art/old_bg.png', 'game/art/logo.png', 'promo/banner.png']);
  });
});

