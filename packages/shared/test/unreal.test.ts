import { describe, expect, it } from 'vitest';
import { analyzeBloat, epicLayoutProblems, epicPrefixOf, objectPathParts, unrealLayout, type ScannedFile } from '@pct/shared';

const layout = unrealLayout('Shooter.uproject');

describe('Epic’s folder structure and naming', () => {
  it('takes the project folder from the .uproject, or from setup', () => {
    expect(layout).toEqual({ contentDir: 'Content', projectFolder: 'Shooter', extraFolders: [] });
    expect(unrealLayout('Game/Shooter.uproject', { unrealContentFolder: 'ShooterGame', unrealFolders: ['Megascans'] })).toEqual({
      contentDir: 'Game/Content',
      projectFolder: 'ShooterGame',
      extraFolders: ['Megascans'],
    });
  });

  it('accepts assets where Epic puts them, named with Epic’s prefixes', () => {
    expect(epicLayoutProblems('Content/Shooter/Assets/Rocks/Rock_A/SM_Rock_A.uasset', layout)).toEqual([]);
    expect(epicLayoutProblems('Content/Shooter/Envs/L_Main.umap', layout)).toEqual([]);
    expect(epicLayoutProblems('Content/Shooter/Tools/WBP_Debug.uasset', layout)).toEqual([]);
    expect(epicLayoutProblems('Content/Common/Assets/T_Noise.uasset', layout)).toEqual([]);
    // Engine-owned folders, plugins and other files are not checked.
    expect(epicLayoutProblems('Content/__ExternalActors__/Shooter/Envs/L_Main/A/B/XYZ.uasset', layout)).toEqual([]);
    expect(epicLayoutProblems('Content/Developers/martin/Test.uasset', layout)).toEqual([]);
    expect(epicLayoutProblems('Plugins/Combat/Content/Sword.uasset', layout)).toEqual([]);
    expect(epicLayoutProblems('Source/Shooter/Shooter.cpp', layout)).toEqual([]);
    // A type Epic does not list follows the pattern with its own prefix.
    expect(epicLayoutProblems('Content/Shooter/Tools/IA_Jump.uasset', layout)).toEqual([]);
  });

  it('flags what does not follow them', () => {
    expect(epicLayoutProblems('Content/Materials/M_Rock.uasset', layout)[0]).toContain('outside Content/Shooter/');
    expect(epicLayoutProblems('Content/Shooter/Blueprints/BP_Door.uasset', layout)[0]).toContain("not in one of Epic's project folders");
    expect(epicLayoutProblems('Content/Shooter/Assets/Maps/L_Main.umap', layout)[0]).toContain('levels go in Content/Shooter/Envs/');
    expect(epicLayoutProblems('Content/Shooter/Assets/Rocks/rock.uasset', layout)[0]).toContain('no asset type prefix');
    expect(epicLayoutProblems('Content/Shooter/Assets/Rocks/SM_Rock.uasset', layout, ['MI_'])[0]).toContain('MI_<Name>');
    expect(epicLayoutProblems('Content/Megascans/Rock.uasset', unrealLayout('Shooter.uproject', { unrealFolders: ['Megascans'] }))).toEqual([]);
  });

  it('knows Epic’s prefixes', () => {
    expect(epicPrefixOf('SM_Rock_A')).toBe('SM_');
    expect(epicPrefixOf('Rig_Hero')).toBe('Rig_');
    expect(epicPrefixOf('XX_Thing')).toBeNull();
    expect(epicPrefixOf('Rock')).toBeNull();
  });

  it('reads object paths', () => {
    expect(objectPathParts('/Game/Shooter/Envs/L_Main.L_Main')).toEqual({ mount: 'Game', rel: 'Shooter/Envs/L_Main' });
    expect(objectPathParts('/Combat/BP_Sword.BP_Sword_C')).toEqual({ mount: 'Combat', rel: 'BP_Sword' });
    expect(objectPathParts('/Engine/BasicShapes/Cube')).toBeNull();
    expect(objectPathParts('C:/art/rock.fbx')).toBeNull();
    expect(objectPathParts('KeyLight')).toBeNull();
  });
});

describe('bloat check in an Unreal project', () => {
  const asset = (path: string, refs: string[] = []): ScannedFile => ({ path, size: 1000, hash: path, text: null, refs });
  const text = (path: string, body: string): ScannedFile => ({ path, size: body.length, hash: path, text: body });

  it('follows what levels, config and code use; the rest is unused', () => {
    const report = analyzeBloat(
      [
        text('Shooter.uproject', '{}'),
        text('Config/DefaultEngine.ini', 'GameDefaultMap=/Game/Shooter/Envs/L_Main.L_Main\n'),
        text('Config/DefaultGame.ini', '+PrimaryAssetTypesToScan=(PrimaryAssetType="Item",Directories=((Path="/Game/Shooter/Assets/Items")))'),
        text('Source/Shooter/Hero.cpp', 'ConstructorHelpers::FObjectFinder<USoundBase> S(TEXT("/Game/Shooter/Assets/Audio/S_Jump.S_Jump"));'),
        asset('Content/Shooter/Envs/L_Main.umap', ['/Game/Shooter/Assets/Rocks/SM_Rock_A']),
        asset('Content/Shooter/Envs/L_Old.umap', []),
        asset('Content/__ExternalActors__/Shooter/Envs/L_Main/0/AB/XYZ.uasset', ['/Game/Shooter/Assets/Props/SM_Crate']),
        asset('Content/Shooter/Assets/Rocks/SM_Rock_A.uasset', ['/Game/Shooter/Assets/Rocks/MI_Rock_A']),
        asset('Content/Shooter/Assets/Rocks/MI_Rock_A.uasset', ['/Game/Shooter/Assets/Rocks/M_Rock']),
        asset('Content/Shooter/Assets/Rocks/M_Rock.uasset', []),
        asset('Content/Shooter/Assets/Props/SM_Crate.uasset', []),
        asset('Content/Shooter/Assets/Items/DA_Sword.uasset', []),
        asset('Content/Shooter/Assets/Audio/S_Jump.uasset', []),
        asset('Content/Shooter/Assets/Rocks/SM_Rock_Old.uasset', ['/Game/Shooter/Assets/Rocks/M_Rock']),
        asset('Content/Developers/martin/Scratch.uasset', []),
        asset('Content/Materials/Leftover.uasset', []),
        asset('Content/Shooter/Assets/Rocks/rock2.uasset', ['/Game/Shooter/Assets/Rocks/rock2']),
        text('Config/DefaultGame.ini.bak', '/Game/Shooter/Assets/Rocks/rock2'),
      ],
      { ranBy: 'Martin', branch: 'main', truncated: false },
    );
    expect(report.unusedGameFiles).toEqual([
      'Content/Shooter/Assets/Rocks/SM_Rock_Old.uasset',
      'Content/Materials/Leftover.uasset',
      'Content/Shooter/Assets/Rocks/rock2.uasset',
    ]);
    // DA_ and S_ are not on Epic's list, but follow its pattern, as Epic asks for types it does not list.
    expect(report.epicLayout.map((i) => i.path)).toEqual(['Content/Materials/Leftover.uasset', 'Content/Shooter/Assets/Rocks/rock2.uasset']);
  });

  it('says nothing about unused assets when a used asset was not pulled from Git LFS', () => {
    const report = analyzeBloat(
      [
        text('Shooter.uproject', '{}'),
        { path: 'Content/Shooter/Envs/L_Main.umap', size: 130, hash: 'p', text: null },
        asset('Content/Shooter/Assets/X/SM_X.uasset', []),
      ],
      { ranBy: 'Martin', branch: null, truncated: false },
    );
    expect(report.unusedGameFiles).toEqual([]);
  });
});
