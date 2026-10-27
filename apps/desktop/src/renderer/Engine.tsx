import { useState } from 'react';
import { describeConnection } from '@pct/shared';
import type { AppState, EngineBridgeChoice } from '../common/api';

// Settings: the game engine on this PC (issue #10). Agents act in Godot or
// Summer Engine through the engine's MCP server, which the app runs and checks
// every call of (locks, task paths, approvals). Kept on this PC, since agents
// run on the PC that started them.

const BRIDGES: { id: EngineBridgeChoice; label: string; detail: string }[] = [
  { id: 'off', label: 'Off', detail: 'Agents work on the project files only.' },
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
];

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
            : 'Your project folder has no project.godot yet; these settings apply once it does. '}
          Agents reach the engine only through the app: scene and resource changes take locks and follow task paths and approvals
          like file edits, and playing the game or running editor scripts asks like a command. Kept on this PC.
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
      {engine.bridge === 'summer' && !engine.summerSignedIn && (
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
          <p className="muted small">Takes effect from each agent’s next turn.</p>
        </>
      )}

      <h3>Godot program</h3>
      <div className="row engine-godot">
        <div className="grow">
          {engine.godotPath ? (
            <>
              <code className="small">{engine.godotPath}</code>
              <span className="muted small">
                {' '}
                {engine.godotSource === 'saved' ? '(chosen here)' : engine.godotSource === 'env' ? '(from GODOT_PATH)' : '(found on the PATH)'}
              </span>
            </>
          ) : (
            <span className="muted small">Not found. Choose Godot’s (or Summer Engine’s) program so agents can run the game’s tests.</span>
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
    </section>
  );
}
