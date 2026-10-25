import { describe, expect, it } from 'vitest';
import { globToRegExp, matchesAny, normalizePath, samePath } from '@pct/shared';

describe('normalizePath', () => {
  it('uses forward slashes and drops dots and extra slashes', () => {
    expect(normalizePath('.\\art\\\\ui/menu.psd')).toBe('art/ui/menu.psd');
    expect(normalizePath('/scripts/./player.gd ')).toBe('scripts/player.gd');
  });

  it('refuses paths that leave the project', () => {
    expect(normalizePath('../secrets.txt')).toBeNull();
    expect(normalizePath('a/../../b')).toBeNull();
    expect(normalizePath('  ')).toBeNull();
  });

  it('compares case-insensitively', () => {
    expect(samePath('Art/Menu.PSD', 'art/menu.psd')).toBe(true);
  });
});

describe('globs', () => {
  it('matches file names anywhere when the pattern has no folder', () => {
    expect(matchesAny('art/ui/menu.psd', ['*.psd'])).toBe(true);
    expect(matchesAny('menu.PSD', ['*.psd'])).toBe(true);
    expect(matchesAny('art/menu.psd.txt', ['*.psd'])).toBe(false);
  });

  it('anchors patterns with folders to the project root', () => {
    expect(globToRegExp('scripts/player/**').test('scripts/player/move.gd')).toBe(true);
    expect(globToRegExp('scripts/player/**').test('scripts/player/sub/deep.gd')).toBe(true);
    expect(globToRegExp('scripts/player/**').test('other/scripts/player/move.gd')).toBe(false);
    expect(globToRegExp('scripts/*.gd').test('scripts/sub/move.gd')).toBe(false);
    expect(globToRegExp('**/save_*.gd').test('save_manager.gd')).toBe(true);
    expect(globToRegExp('level?.tscn').test('scenes/level1.tscn')).toBe(true);
  });

  it('treats regex characters literally', () => {
    expect(matchesAny('docs/a+b(1).md', ['docs/a+b(1).md'])).toBe(true);
    expect(matchesAny('docs/aab1.md', ['docs/a+b(1).md'])).toBe(false);
  });
});
