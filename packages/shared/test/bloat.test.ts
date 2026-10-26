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
});
