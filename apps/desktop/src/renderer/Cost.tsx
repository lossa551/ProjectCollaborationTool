import { useEffect, useState, type FormEvent } from 'react';
import {
  DEFAULT_PRICES,
  ModelPrice,
  allTokens,
  formatCost,
  formatTokens,
  inputTokens,
  type PriceTable,
  type UsageTotal,
} from '@pct/shared';
import type { AppState } from '../common/api';

// What agents cost (issue #37): tokens and an estimated price per chat, agent
// and task, budgets that pause an agent, and the price table it all uses.

/** Tokens and cost in one line; hover for the split. */
export function CostLine({ total, empty = 'Nothing used yet' }: { total: UsageTotal; empty?: string }) {
  if (total.calls === 0) return <span className="muted">{empty}</span>;
  const detail = [
    `${total.input.toLocaleString()} input tokens`,
    total.cacheRead ? `${total.cacheRead.toLocaleString()} read from the cache` : null,
    total.cacheWrite ? `${total.cacheWrite.toLocaleString()} written to the cache` : null,
    `${total.output.toLocaleString()} output tokens`,
    `${total.calls} model ${total.calls === 1 ? 'call' : 'calls'}`,
    total.unpriced.length ? `No price for ${total.unpriced.join(', ')}: add one in Settings, Model prices.` : null,
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <span className="cost-line" title={detail}>
      {formatTokens(inputTokens(total))} in · {formatTokens(total.output)} out ·{' '}
      <strong>{formatCost(total.cost)}</strong>
      {total.unpriced.length > 0 && <span className="warning"> + unpriced</span>}
    </span>
  );
}

/** Total tokens and cost, short, e.g. for a list. */
export function CostShort({ total }: { total: UsageTotal }) {
  if (total.calls === 0) return <span className="muted">$0</span>;
  return (
    <span title={`${allTokens(total).toLocaleString()} tokens`}>
      {formatCost(total.cost)}
      {total.unpriced.length > 0 && <span className="warning">+</span>}
      <span className="muted"> · {formatTokens(allTokens(total))}</span>
    </span>
  );
}

/** How much of a budget is spent, as a bar. */
export function BudgetMeter({ spent, limit }: { spent: number; limit: number }) {
  const share = Math.min(1, spent / limit);
  const over = spent >= limit;
  return (
    <span className={over ? 'budget-meter over' : share >= 0.8 ? 'budget-meter near' : 'budget-meter'}>
      <span className="budget-track">
        <span className="budget-fill" style={{ width: `${Math.round(share * 100)}%` }} />
      </span>
      <span className="small">
        {formatCost(spent)} of {formatCost(limit)}
        {over && ' · used up'}
      </span>
    </span>
  );
}

/**
 * A budget with its meter, set or removed in place. When it is used up the
 * agent pauses and asks in its chat to go on.
 */
export function BudgetField({
  budget,
  spent,
  disabled,
  onChange,
}: {
  budget: number | null;
  spent: number;
  disabled: boolean;
  onChange: (budget: number | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(budget === null ? '' : String(budget));
  useEffect(() => setValue(budget === null ? '' : String(budget)), [budget]);

  const save = (event: FormEvent) => {
    event.preventDefault();
    const amount = Number(value.replace(',', '.').replace('$', '').trim());
    if (!Number.isFinite(amount) || amount <= 0) return;
    onChange(Math.round(amount * 100) / 100);
    setEditing(false);
  };

  if (editing) {
    return (
      <form className="budget-form row" onSubmit={save}>
        <span className="muted">$</span>
        <input autoFocus inputMode="decimal" value={value} placeholder="5.00" onChange={(e) => setValue(e.target.value)} aria-label="Budget in dollars" />
        <button type="submit" disabled={disabled}>
          Set
        </button>
        <button type="button" className="secondary" onClick={() => setEditing(false)}>
          Cancel
        </button>
      </form>
    );
  }
  return (
    <div className="budget-field">
      {budget === null ? <span className="muted small">No budget</span> : <BudgetMeter spent={spent} limit={budget} />}
      <button className="link small" disabled={disabled} onClick={() => setEditing(true)}>
        {budget === null ? 'Set a budget' : 'Change'}
      </button>
      {budget !== null && (
        <button className="link small" disabled={disabled} onClick={() => onChange(null)}>
          Remove
        </button>
      )}
    </div>
  );
}

type PriceDraft = Record<keyof ModelPrice, string>;

const toDraft = (p: ModelPrice): PriceDraft => ({
  model: p.model,
  input: String(p.input),
  output: String(p.output),
  cacheRead: String(p.cacheRead),
  cacheWrite: String(p.cacheWrite),
});

function fromDrafts(drafts: PriceDraft[]): PriceTable | null {
  const out: PriceTable = [];
  for (const d of drafts) {
    if (!d.model.trim()) continue;
    const parsed = ModelPrice.safeParse({
      model: d.model.trim(),
      input: Number(d.input || 0),
      output: Number(d.output || 0),
      cacheRead: Number(d.cacheRead || 0),
      cacheWrite: Number(d.cacheWrite || 0),
    });
    if (!parsed.success) return null;
    out.push(parsed.data);
  }
  return out;
}

const PRICE_COLUMNS: { key: Exclude<keyof ModelPrice, 'model'>; label: string }[] = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheRead', label: 'Cache read' },
  { key: 'cacheWrite', label: 'Cache write' },
];

/** Settings: the price per million tokens of each model, shared by the session. */
export function PriceSettings({ state }: { state: AppState }) {
  const { session } = state;
  const online = session.status === 'connected';
  const [drafts, setDrafts] = useState(() => session.prices.map(toDraft));
  const saved = JSON.stringify(session.prices.map(toDraft));
  useEffect(() => setDrafts(JSON.parse(saved) as PriceDraft[]), [saved]);
  const table = fromDrafts(drafts);
  const changed = table !== null && JSON.stringify(table) !== JSON.stringify(session.prices);
  const used = new Set(session.usage.filter((r) => r.source === 'priced').map((r) => r.model));
  const set = (i: number, key: keyof ModelPrice, value: string) => setDrafts(drafts.map((d, j) => (j === i ? { ...d, [key]: value } : d)));

  return (
    <section className="card price-settings">
      <header className="row">
        <div className="grow">
          <h2>Model prices</h2>
          <p className="muted small">
            US dollars per million tokens, used to estimate what agents cost. A row counts for every model whose name
            starts with it, so <code>claude-opus-4</code> covers all Opus 4 versions. Claude Code reports its own cost and
            local Ollama models are free. Shared with everyone in the session; check your provider’s price page when
            unsure.
          </p>
        </div>
      </header>
      <table className="price-table small">
        <thead>
          <tr>
            <th>Model name starts with</th>
            {PRICE_COLUMNS.map((c) => (
              <th key={c.key}>{c.label}</th>
            ))}
            <th />
          </tr>
        </thead>
        <tbody>
          {drafts.map((d, i) => (
            <tr key={i}>
              <td>
                <input value={d.model} disabled={!online} onChange={(e) => set(i, 'model', e.target.value)} aria-label="Model" />
              </td>
              {PRICE_COLUMNS.map((c) => (
                <td key={c.key}>
                  <input
                    className="num"
                    inputMode="decimal"
                    value={d[c.key]}
                    disabled={!online}
                    onChange={(e) => set(i, c.key, e.target.value)}
                    aria-label={`${c.label} price for ${d.model}`}
                  />
                </td>
              ))}
              <td>
                <button className="link" disabled={!online} onClick={() => setDrafts(drafts.filter((_, j) => j !== i))} title="Remove this row">
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {table === null && <p className="error small">Prices must be numbers of 0 or more.</p>}
      <UnpricedModels used={used} prices={table ?? session.prices} />
      <div className="row">
        <button
          className="secondary"
          disabled={!online}
          onClick={() => setDrafts([...drafts, { model: '', input: '', output: '', cacheRead: '', cacheWrite: '' }])}
        >
          Add a model
        </button>
        <button className="link small" disabled={!online} onClick={() => setDrafts(DEFAULT_PRICES.map(toDraft))}>
          Start from the default prices
        </button>
        <span className="grow" />
        <button disabled={!online || !changed} onClick={() => table && window.pct.setPrices(table)}>
          Save prices
        </button>
      </div>
    </section>
  );
}

/** Models agents used that no row covers, so their cost is left out. */
function UnpricedModels({ used, prices }: { used: Set<string>; prices: PriceTable }) {
  const missing = [...used].filter((model) => !prices.some((p) => model.toLowerCase().startsWith(p.model.toLowerCase())));
  if (missing.length === 0) return null;
  return (
    <p className="warning small">
      No price yet for {missing.map((m) => <code key={m}>{m}</code>)}; its cost is left out until you add one.
    </p>
  );
}
