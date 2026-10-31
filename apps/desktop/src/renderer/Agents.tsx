import { Fragment, useEffect, useState, type FormEvent } from 'react';
import {
  API_PROVIDERS,
  ApiProvider,
  CLI_TOOLS,
  CliTool,
  DEFAULT_APPROVALS,
  apiKeyName,
  describeConnection,
  totalUsage,
  usageDay,
  weekStart,
  type AgentApprovals,
  type AgentConnection,
  type AgentProfile,
  type ApprovalPolicy,
  type CliAuth,
  type Participant,
} from '@pct/shared';
import type { AppState } from '../common/api';
import { Avatar } from './Avatar';
import { CostShort } from './Cost';
import { ask } from './Dialog';
import { NotesAgentSettings, draftTotals } from './NotesAgent';

// Screen 5: each agent's connection, responsibilities, allowed paths and what
// it needs approval for. Profiles are shared with the session; an agent runs
// on the PC of whoever presses Start, with that PC's API key.

const POLICY_LABEL: Record<ApprovalPolicy, string> = { allow: 'Allowed', ask: 'Ask first', deny: 'Not allowed' };

const APPROVAL_FIELDS: { key: keyof AgentApprovals; label: string }[] = [
  { key: 'editInScope', label: 'Edits inside its paths and the task' },
  { key: 'editOutsideScope', label: 'Edits outside them' },
  { key: 'commands', label: 'Shell commands' },
];

/** Which agent participant runs this profile right now, if any. */
export function runnerOf(agent: AgentProfile, participants: Participant[]): Participant | undefined {
  return participants.find((p) => p.agent?.profileId === agent.id);
}

export function AgentsScreen({ state, onOpenChat }: { state: AppState; onOpenChat: (agentId: string) => void }) {
  const { session } = state;
  const online = session.status === 'connected';
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const editingAgent = editing && editing !== 'new' ? session.agents.find((a) => a.id === editing) : undefined;

  return (
    <div className="agents-screen">
      <header className="screen-header">
        <div>
          <h2>Agents</h2>
          <p className="muted">
            Agents join the session like people do. Each runs on the PC of whoever starts it, in that person’s project
            folder; API keys stay on that PC. Chat with them under Chats in the menu.
          </p>
        </div>
        <button disabled={!online} onClick={() => setEditing('new')}>
          New agent
        </button>
      </header>

      {editing && (editing === 'new' || editingAgent) && (
        <AgentEditor key={editing} agent={editingAgent} state={state} onDone={() => setEditing(null)} />
      )}

      {session.agents.length === 0 && !editing && (
        <section className="card">
          <p className="muted">
            No agents yet. Add one for a model API (Claude, DeepSeek, OpenAI, or a local model through Ollama) or for a
            command-line agent such as Claude Code or Codex.
          </p>
        </section>
      )}

      <div className="agent-grid">
        {session.agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            state={state}
            onEdit={() => setEditing(agent.id)}
            onChat={() => onOpenChat(agent.id)}
          />
        ))}
      </div>

      <NotesAgentSettings state={state} />
    </div>
  );
}

function AgentCard({ agent, state, onEdit, onChat }: { agent: AgentProfile; state: AppState; onEdit: () => void; onChat: () => void }) {
  const { session } = state;
  const online = session.status === 'connected';
  const runner = runnerOf(agent, session.participants);
  const local = state.localAgents[agent.id];
  const [error, setError] = useState<string | null>(null);
  const missingKey = keyProblem(agent.connection, state);

  const start = async () => {
    setError(null);
    const result = await window.pct.startAgent(agent.id);
    if (!result.ok) setError(result.error);
  };

  return (
    <section className="card agent-card">
      <header className="agent-head">
        <Avatar name={agent.name} kind="agent" status={runner ? runner.status : 'offline'} />
        <div className="grow">
          <h2>{agent.name}</h2>
          <span className="muted small">{describeConnection(agent.connection)}</span>
        </div>
      </header>
      <p className={agent.responsibilities.trim() ? 'agent-role' : 'agent-role muted'}>
        {agent.responsibilities.trim() || 'No responsibilities written yet.'}
      </p>
      <dl className="agent-facts small">
        <dt>Paths</dt>
        <dd>{agent.allowedPaths.length ? agent.allowedPaths.map((p) => <code key={p}>{p}</code>) : <span className="muted">Anywhere the task allows</span>}</dd>
        {APPROVAL_FIELDS.map((field) => (
          <FragmentRow key={field.key} label={field.label} value={POLICY_LABEL[agent.approvals[field.key]]} />
        ))}
        <AgentSpend agent={agent} state={state} />
      </dl>
      <p className="small">
        {runner ? (
          <span className="good">Running on {runner.agent!.startedBy}’s PC</span>
        ) : local?.status === 'starting' ? (
          <span className="warning">Starting…</span>
        ) : (
          <span className="muted">Not running</span>
        )}
        {local?.status === 'running' && <span className="muted"> · in {local.folder}</span>}
      </p>
      {(error ?? (local?.status === 'error' ? local.error : null)) && <p className="error small">{error ?? local?.error}</p>}
      {!runner && missingKey && <p className="warning small">{missingKey}</p>}
      <div className="row">
        {local && local.status !== 'error' ? (
          <button className="secondary" onClick={() => window.pct.stopAgent(agent.id)}>
            Stop
          </button>
        ) : (
          <button disabled={!online || !!runner || !!missingKey} onClick={() => void start()}>
            Start on this PC
          </button>
        )}
        <button className="secondary" onClick={onChat}>
          Chat
        </button>
        <button className="secondary" disabled={!online} onClick={onEdit}>
          Edit
        </button>
      </div>
    </section>
  );
}

/**
 * What the agent cost today and this week (since Monday), over all its chats
 * and drafts; its folder notes and commit message drafts are also shown apart.
 */
function AgentSpend({ agent, state }: { agent: AgentProfile; state: AppState }) {
  const { usage, prices } = state.session;
  const rows = usage.filter((r) => r.agentId === agent.id);
  const now = Date.now();
  const today = usageDay(now);
  const monday = weekStart(now);
  const drafts = (['notes', 'commit', 'review'] as const)
    .map((kind) => ({ kind, ...draftTotals(state, kind, agent.id, now) }))
    .filter((d) => d.week.calls > 0);
  return (
    <>
      <dt>Today</dt>
      <dd>
        <CostShort total={totalUsage(rows.filter((r) => r.day === today), prices)} />
      </dd>
      <dt>This week</dt>
      <dd>
        <CostShort total={totalUsage(rows.filter((r) => r.day >= monday), prices)} />
      </dd>
      {drafts.map((d) => (
        <Fragment key={d.kind}>
          <dt>{d.kind === 'notes' ? 'Folder notes' : d.kind === 'review' ? 'Duplicate checks' : 'Commit messages'}</dt>
          <dd title="Drafts written outside any chat, counted in the totals above">
            <CostShort total={d.today} /> <span className="muted">today ·</span> <CostShort total={d.week} />{' '}
            <span className="muted">this week</span>
          </dd>
        </Fragment>
      ))}
    </>
  );
}

function FragmentRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}

/** Why this PC cannot run the agent, if it cannot. */
export function keyProblem(connection: AgentConnection, state: AppState): string | null {
  if (connection.type === 'cli') {
    return state.cliTools[connection.tool] ? null : `${CLI_TOOLS[connection.tool].label} is not installed on this PC.`;
  }
  const preset = API_PROVIDERS[connection.provider];
  if (!preset.needsKey) return null;
  const name = apiKeyName(connection.provider, connection.baseUrl ?? preset.baseUrl);
  return state.apiKeys[name] ? null : `Add a ${preset.label} API key on this PC (Edit) to start it here.`;
}

type ConnectionChoice = `api:${ApiProvider}` | `cli:${CliTool}`;

const CHOICES: { value: ConnectionChoice; label: string; group: string }[] = [
  ...ApiProvider.options.map((p) => ({ value: `api:${p}` as const, label: API_PROVIDERS[p].label, group: 'Model API (our own agent loop)' })),
  ...CliTool.options.map((t) => ({ value: `cli:${t}` as const, label: CLI_TOOLS[t].label, group: 'Command-line agent' })),
];

function choiceOf(connection: AgentConnection): ConnectionChoice {
  return connection.type === 'api' ? `api:${connection.provider}` : `cli:${connection.tool}`;
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function AgentEditor({ agent, state, onDone }: { agent: AgentProfile | undefined; state: AppState; onDone: () => void }) {
  const [name, setName] = useState(agent?.name ?? '');
  const [choice, setChoice] = useState<ConnectionChoice>(agent ? choiceOf(agent.connection) : 'api:anthropic');
  const [model, setModel] = useState(agent?.connection.model ?? API_PROVIDERS.anthropic.model);
  const [baseUrl, setBaseUrl] = useState(agent?.connection.type === 'api' ? (agent.connection.baseUrl ?? '') : '');
  const [auth, setAuth] = useState<CliAuth>(agent?.connection.type === 'cli' ? agent.connection.auth : 'plan');
  const [responsibilities, setResponsibilities] = useState(agent?.responsibilities ?? '');
  const [paths, setPaths] = useState(agent?.allowedPaths.join('\n') ?? '');
  const [approvals, setApprovals] = useState<AgentApprovals>(agent?.approvals ?? DEFAULT_APPROVALS);
  const [error, setError] = useState<string | null>(null);

  const [kind, id] = choice.split(':') as ['api', ApiProvider] | ['cli', CliTool];
  const preset = kind === 'api' ? API_PROVIDERS[id as ApiProvider] : null;

  const pick = (next: ConnectionChoice) => {
    setChoice(next);
    const [nextKind, nextId] = next.split(':');
    setModel(nextKind === 'api' ? API_PROVIDERS[nextId as ApiProvider].model : '');
    setBaseUrl('');
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const connection: AgentConnection =
      kind === 'api'
        ? { type: 'api', provider: id as ApiProvider, model: model.trim(), baseUrl: baseUrl.trim() || null }
        : { type: 'cli', tool: id as CliTool, model: model.trim() || null, auth };
    if (kind === 'api' && id === 'openai-compatible' && !baseUrl.trim()) {
      setError('Enter the API’s address, e.g. https://example.com/v1');
      return;
    }
    const result = await window.pct.saveAgent({
      ...(agent && { id: agent.id }),
      name: name.trim(),
      connection,
      responsibilities: responsibilities.trim(),
      allowedPaths: lines(paths),
      approvals,
    });
    if (result.ok) onDone();
    else setError(result.error);
  };

  const keyName = preset?.needsKey ? apiKeyName(id as ApiProvider, baseUrl.trim() || preset.baseUrl) : null;

  return (
    <form className="card agent-editor" onSubmit={(e) => void save(e)}>
      <h2>{agent ? `Edit ${agent.name}` : 'New agent'}</h2>
      <div className="editor-grid">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Planner, Builder, Reviewer" maxLength={64} required />
        </label>
        <label className="field">
          <span>Runs on</span>
          <select value={choice} onChange={(e) => pick(e.target.value as ConnectionChoice)}>
            {['Model API (our own agent loop)', 'Command-line agent'].map((group) => (
              <optgroup key={group} label={group}>
                {CHOICES.filter((c) => c.group === group).map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{kind === 'api' ? 'Model' : 'Model (optional; the tool’s default if empty)'}</span>
          <input value={model} onChange={(e) => setModel(e.target.value)} required={kind === 'api'} maxLength={100} spellCheck={false} />
        </label>
        {kind === 'cli' && id === 'claude-code' && (
          <label className="field">
            <span>Signs in with</span>
            <select value={auth} onChange={(e) => setAuth(e.target.value as CliAuth)}>
              <option value="plan">Your Claude plan (claude.ai login)</option>
              <option value="api">An API key (billed per token)</option>
            </select>
          </label>
        )}
        {kind === 'api' && (id === 'openai-compatible' || id === 'ollama') && (
          <label className="field">
            <span>API address{preset?.baseUrl ? ` (default ${preset.baseUrl})` : ''}</span>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder={preset?.baseUrl ?? 'https://…/v1'} spellCheck={false} />
          </label>
        )}
      </div>
      {kind === 'cli' && (
        <p className="muted small">
          {CLI_TOOLS[id as CliTool].label} runs headless in the project folder of whoever starts it.{' '}
          {id === 'claude-code'
            ? 'Every tool it uses is checked by the app first (locks, paths, approvals) through a hook.'
            : 'Codex has no hook for this, so after each run the app checks what it changed and undoes changes outside its paths unless someone keeps them.'}
          {!state.cliTools[id as CliTool] && ' It is not installed on this PC.'}
        </p>
      )}
      {kind === 'cli' && id === 'claude-code' && (
        <p className="muted small">
          {auth === 'plan'
            ? 'It uses the Claude Pro or Max plan of whoever starts it, so it costs nothing extra per token; it counts towards that plan’s usage limits instead. Each PC signs in once: open a terminal, run claude and log in with your Claude account. API keys on the PC (ANTHROPIC_API_KEY and the like) are kept away from it so they cannot take over.'
            : 'It uses the API key Claude Code finds on the PC of whoever starts it, such as ANTHROPIC_API_KEY, and every token is billed to that API account.'}
        </p>
      )}
      {keyName && <ApiKeyField name={keyName} label={preset!.label} status={state.apiKeys[keyName]} />}
      <label className="field">
        <span>Responsibilities (given to the agent as its instructions)</span>
        <textarea
          value={responsibilities}
          onChange={(e) => setResponsibilities(e.target.value)}
          rows={4}
          maxLength={4000}
          placeholder="e.g. Implements gameplay code from an agreed plan. Writes tests for what it changes. Never touches art assets."
        />
      </label>
      <label className="field">
        <span>Allowed paths, one per line (empty: anywhere the task allows)</span>
        <textarea value={paths} onChange={(e) => setPaths(e.target.value)} rows={3} placeholder={'scripts/**\ntests/**'} spellCheck={false} />
      </label>
      <div className="editor-grid">
        {APPROVAL_FIELDS.map((field) => (
          <label key={field.key} className="field">
            <span>{field.label}</span>
            <select value={approvals[field.key]} onChange={(e) => setApprovals({ ...approvals, [field.key]: e.target.value as ApprovalPolicy })}>
              {(Object.keys(POLICY_LABEL) as ApprovalPolicy[]).map((p) => (
                <option key={p} value={p}>
                  {POLICY_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <p className="muted small">
        Files locked exclusively by someone else are never edited, whatever these say. Soft locks held by others always ask first.
      </p>
      {error && <p className="error small">{error}</p>}
      <div className="row">
        <button type="submit">{agent ? 'Save' : 'Add agent'}</button>
        <button type="button" className="secondary" onClick={onDone}>
          Cancel
        </button>
        {agent && (
          <button
            type="button"
            className="danger"
            onClick={async () => {
              if (await ask(`Remove ${agent.name}?`, { detail: 'Its chats stay.', confirm: 'Remove agent', danger: true })) {
                window.pct.deleteAgent(agent.id);
                onDone();
              }
            }}
          >
            Remove agent
          </button>
        )}
      </div>
    </form>
  );
}

function ApiKeyField({ name, label, status }: { name: string; label: string; status: 'saved' | 'env' | undefined }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setKey(''), [name]);
  const save = async (value: string | null) => {
    setError(null);
    const result = await window.pct.setApiKey(name, value);
    if (result.ok) setKey('');
    else setError(result.error);
  };
  return (
    <div className="field">
      <span>
        {label} API key on this PC:{' '}
        {status === 'saved' ? <span className="good">saved</span> : status === 'env' ? <span className="good">from an environment variable</span> : <span className="warning">none yet</span>}
      </span>
      <div className="row tight">
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Paste a key to save it, encrypted, on this PC only" autoComplete="off" />
        <button type="button" disabled={!key.trim()} onClick={() => void save(key)}>
          Save key
        </button>
        {status === 'saved' && (
          <button type="button" className="secondary" onClick={() => void save(null)}>
            Remove
          </button>
        )}
      </div>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}
