import { useState } from 'react';
import { CRITERION_STATE_LABELS, CriterionState, planLines, type Criterion, type Task } from '@pct/shared';

// Acceptance criteria on a task, each with its recorded test result. Anyone
// (person or agent) records a result with what they checked; changing a
// criterion's wording means it needs testing again.

export function CriteriaSection({ task, editable }: { task: Task; editable: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const save = () => {
    const lines = planLines(draft).slice(0, 50);
    const unused = [...task.criteria];
    const criteria = lines.map((text) => {
      const same = unused.findIndex((c) => c.text === text);
      const id = same >= 0 ? unused.splice(same, 1)[0]!.id : crypto.randomUUID();
      return { id, text: text.slice(0, 1000) };
    });
    window.pct.updateTask(task.id, { criteria });
    setEditing(false);
  };

  return (
    <section>
      <h3 className="section-title">Acceptance criteria</h3>
      {editing ? (
        <>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={5} placeholder="One per line" autoFocus />
          <p className="muted small">Reworded criteria need testing again.</p>
          <div className="row">
            <button onClick={save}>Save</button>
            <button className="secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <>
          {task.criteria.length === 0 && <p className="muted small">None yet. Add what must be true before this task is done.</p>}
          <ul className="criteria-list">
            {task.criteria.map((c) => (
              <CriterionRow key={c.id} taskId={task.id} criterion={c} editable={editable} />
            ))}
          </ul>
          {editable && (
            <button
              className="link small"
              onClick={() => {
                setDraft(task.criteria.map((c) => c.text).join('\n'));
                setEditing(true);
              }}
            >
              {task.criteria.length ? 'Edit criteria' : 'Add criteria'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

const STATE_ICON: Record<CriterionState, string> = { untested: '○', verified: '✓', failing: '✗' };

function CriterionRow({ taskId, criterion: c, editable }: { taskId: string; criterion: Criterion; editable: boolean }) {
  const [recording, setRecording] = useState(false);
  const [state, setState] = useState<CriterionState>(c.state === 'untested' ? 'verified' : c.state);
  const [evidence, setEvidence] = useState(c.evidence);

  return (
    <li className={`criterion criterion-${c.state}`}>
      <div className="criterion-head">
        <span className="criterion-icon" title={CRITERION_STATE_LABELS[c.state]}>
          {STATE_ICON[c.state]}
        </span>
        <span className="grow">{c.text}</span>
        {editable && !recording && (
          <button className="link small" onClick={() => setRecording(true)}>
            Record result
          </button>
        )}
      </div>
      {c.state !== 'untested' && !recording && (
        <p className="muted small criterion-evidence">
          {CRITERION_STATE_LABELS[c.state]}
          {c.by && ` by ${c.by}`}
          {c.at && `, ${new Date(c.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`}
          {c.evidence && `: ${c.evidence}`}
        </p>
      )}
      {recording && (
        <form
          className="criterion-form"
          onSubmit={(e) => {
            e.preventDefault();
            window.pct.verifyCriterion(taskId, c.id, state, evidence.trim());
            setRecording(false);
          }}
        >
          <div className="row tight">
            {CriterionState.options.map((s) => (
              <label key={s} className="check small">
                <input type="radio" checked={state === s} onChange={() => setState(s)} />
                {CRITERION_STATE_LABELS[s]}
              </label>
            ))}
          </div>
          <input value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="What you checked and what happened" maxLength={4000} />
          <div className="row tight">
            <button type="submit">Save</button>
            <button type="button" className="secondary" onClick={() => setRecording(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
  );
}
