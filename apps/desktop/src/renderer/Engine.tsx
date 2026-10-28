import { useState } from 'react';
import { describeConnection } from '@pct/shared';
import type { AppState, EngineBridgeChoice, EngineState } from '../common/api';

// Settings: the game engine on this PC (issues #10 and #11). Agents act in
// Godot, Summer Engine or the Unreal Editor through the engine's MCP server,
// which the app runs and checks every call of (locks, task paths, approvals).
// Kept on this PC, since agents run on the PC that started them.

const BRIDGES: { id: EngineBridgeChoice; label: string; detail: string }[] = [
  {
    id: 'auto',
    label: 'Automatic',
    detail:
      'Unreal projects: EngineWire in the Unreal Editor. Godot projects: Summer Engine’s server while Summer Engine is open, the Godot MCP server otherwise. Picked again at each agent turn.',
  },
  {
    id: 'unreal',
    label: 'Unreal Editor (EngineWire)',
    detail:
      'Drives the Unreal Editor that has your project open, through the EngineWire plugin: assets, levels, Blueprints, play in editor, screenshots. Agents that use it work in your project folder. Started with npx (needs Node.js).',
  },
  {
    id: 'godot',
    label: 'Godot MCP server',
    detail:
      'Runs Godot headless on each agent’s own copy of the project: create scenes, add nodes, run the game and read its output. Started with npx (needs Node.js).',
  },
  {
    id: 'summer',
    label: 'Summer Engine',
    detail:
      'Drives the Summer Engine editor that has your project open: scene edits, play, console and screenshots. Agents that use it work in your project folder, not a copy, because that is what the editor has open.',
  },
  { id: 'off', label: 'Off', detail: 'Agents work on the project files only.' },
];

const SERVER_NAMES = { godot: 'the Godot MCP server', summer: 'Summer Engine’s server', unreal: 'EngineWire in the Unreal Editor' };

export const ENGINEWIRE_URL = 'https://github.com/ChiR24/Unreal_mcp';

const GODOT_SOURCES: Record<NonNullable<EngineState['godotSource']>, string> = {
  saved: '(chosen here)',
  env: '(from GODOT_PATH)',
  editor: '(the Godot editor you ran)',
  path: '(found on the PATH)',
  found: '(found where Godot is usually kept)',
};

export const NODE_URL = 'https://nodejs.org/en/download';

/** One line on what the editor is doing, for Settings and Home. */
export function describeEditor(engine: EngineState): string {
  const { editor } = engine;
  if (engine.unreal && !engine.godotProject) {
    if (editor?.kind !== 'unreal') return 'The Unreal Editor is not running.';
    return editor.projectOpen ? 'The Unreal Editor has your project open.' : 'The Unreal Editor is running, with another project.';
  }
  if (!editor || editor.kind === 'unreal') return 'Neither Godot nor Summer Engine is running.';
  const name = editor.kind === 'godot' ? 'Godot' : 'Summer Engine';
  if (!editor.projectOpen) {
    return engine.plugin === 'ok' ? `${name} is running, without your project open.` : `${name} is running. Add the Locks plugin and the app sees when it has your project open.`;
  }
  return `${name}${editor.version ? ` ${editor.version}` : ''} has your project open${editor.scene ? `, on ${editor.scene}` : ''}.`;
}

export function EngineSettings({ state }: { state: AppState }) {
  const { engine, session } = state;
  const [error, setError] = useState<string | null>(null);
  const picked = new Set(engine.agents);
  const chooseGodot = async (choose: boolean) => {
    const result = await window.pct.setGodotPath(choose);
    setError(result.ok || result.error === 'cancelled' ? null : result.error);
  };
  return (
    <section className="card engine-settings">
      <header>
        <h2>Game engine</h2>
        <p className="muted small">
          {engine.godotProject
            ? 'Your project folder is a Godot project (Godot or Summer Engine). '
            : engine.unreal
              ? `Your project folder is an Unreal project (${engine.unreal.uproject}${engine.unreal.engineVersion ? `, Unreal Engine ${engine.unreal.engineVersion}` : ''}). `
              : 'Your project folder has no project.godot or .uproject yet; these settings apply once it does. '}
          Agents reach the engine only through the app: scene, asset and level changes take locks and follow task paths and approvals
          like file edits, deletes always ask, and playing the game or running editor scripts asks like a command. Kept on this PC.
        </p>
      </header>

      <h3>Engine tools for agents</h3>
      <div className="engine-bridges">
        {BRIDGES.map((bridge) => (
          <label key={bridge.id} className={engine.bridge === bridge.id ? 'engine-bridge active' : 'engine-bridge'}>
            <input type="radio" name="engine-bridge" checked={engine.bridge === bridge.id} onChange={() => window.pct.setEngineBridge(bridge.id)} />
            <span>
              <strong>{bridge.label}</strong>
              <span className="muted small"> {bridge.detail}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="small engine-active">
        {engine.active ? (
          <>
            Agents use <strong>{SERVER_NAMES[engine.active]}</strong> now. <span className="muted">{engine.activeWhy}</span>
          </>
        ) : (
          <span className="muted">Agents get no engine tools now. {engine.activeWhy}</span>
        )}
      </p>
      <p className="muted small">{describeEditor(engine)}</p>
      {engine.node === false && engine.bridge !== 'off' && (
        <p className="warning small">
          Node.js is not installed on this PC. The app starts the engine’s MCP server with npx, which comes with Node.js.{' '}
          <button className="link small" onClick={() => window.open(NODE_URL)}>
            Get Node.js
          </button>{' '}
          (the app finds it within a minute after you install it).
        </p>
      )}
      {(engine.bridge === 'summer' || (engine.bridge === 'auto' && engine.editor?.kind === 'summer')) && !engine.summerSignedIn && (
        <p className="warning small">
          Summer is not signed in on this PC yet. Run <code>npx summer-engine@latest login</code> once, and open your project in Summer
          Engine before an agent uses it.
        </p>
      )}

      {engine.bridge !== 'off' && (
        <>
          <h3>Agents that use it</h3>
          {session.agents.length === 0 ? (
            <p className="muted small">No agents yet. Add one above.</p>
          ) : (
            <ul className="engine-agents">
              {session.agents.map((agent) => (
                <li key={agent.id}>
                  <label className="check">
                    <input type="checkbox" checked={picked.has(agent.id)} onChange={(e) => window.pct.setEngineAgent(agent.id, e.target.checked)} />
                    <span>
                      <strong>{agent.name}</strong>
                      <span className="muted small"> {describeConnection(agent.connection)}</span>
                      {agent.connection.type === 'cli' && agent.connection.tool === 'codex' && (
                        <span className="muted small"> · Codex cannot be checked call by call, so it does not get engine tools</span>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">New agents get it too. Takes effect from each agent’s next turn.</p>
        </>
      )}

      {engine.unreal && !engine.godotProject && <UnrealSettings engine={engine} />}

      {!engine.unreal || engine.godotProject ? (
        <GodotProgram engine={engine} error={error} chooseGodot={chooseGodot} />
      ) : (
        error && <p className="error small">{error}</p>
      )}
    </section>
  );
}

/** Unreal: the engine the project asks for, and EngineWire. */
function UnrealSettings({ engine }: { engine: EngineState }) {
  const unreal = engine.unreal!;
  return (
    <>
      <h3>Unreal Engine</h3>
      <div className="engine-godot">
        {unreal.editorCmd ? (
          <p className="small">
            <code className="small">{unreal.editorCmd}</code>
            <span className="muted small"> (Unreal Engine {unreal.engineVersion ?? ''}, found on this PC)</span>
          </p>
        ) : (
          <p className="muted small">
            Unreal Engine {unreal.engineVersion ?? ''} not found yet. The app looks in the Epic Games Launcher’s list and the usual folders, and
            takes it from the Unreal Editor you run.
          </p>
        )}
        <p className="muted small">
          Agents run the project’s automation tests headless (UnrealEditor-Cmd, tests under Project.) and record the results on the task’s
          acceptance criteria.
        </p>
        <p className="small">
          EngineWire:{' '}
          {unreal.plugin === 'ok' ? (
            <span className="muted">in the project.</span>
          ) : (
            <span className="muted">not in the project yet. Add it from Home (one click; this PC only).</span>
          )}{' '}
          <button className="link small" onClick={() => window.open(ENGINEWIRE_URL)}>
            About EngineWire
          </button>
        </p>
        <p className="muted small">
          New assets follow Epic’s folder structure and asset naming: the app refuses agent calls that would not, and the bloat check lists
          assets that do not.
        </p>
      </div>
    </>
  );
}

function GodotProgram({ engine, error, chooseGodot }: { engine: EngineState; error: string | null; chooseGodot: (choose: boolean) => Promise<void> }) {
  return (
    <>
      <h3>Godot program</h3>
      <div className="row engine-godot">
        <div className="grow">
          {engine.godotPath ? (
            <>
              <code className="small">{engine.godotPath}</code>
              <span className="muted small"> {engine.godotSource ? GODOT_SOURCES[engine.godotSource] : ''}</span>
            </>
          ) : (
            <span className="muted small">
              Not found yet. Open your project in Godot once and the app takes it from there, or choose Godot’s (or Summer Engine’s) program.
            </span>
          )}
          <p className="muted small">
            With the GUT or gdUnit4 add-on in the project, agents run the tests headless and record the results on the task’s acceptance
            criteria.
          </p>
        </div>
        <button className="secondary" onClick={() => void chooseGodot(true)}>
          Choose…
        </button>
        {engine.godotSource === 'saved' && (
          <button className="link" onClick={() => void chooseGodot(false)}>
            Forget
          </button>
        )}
      </div>
      {error && <p className="error small">{error}</p>}
    </>
  );
}
