import { useEffect, useState } from 'react';
import type { AppState, FirstCommitPlan } from '../common/api';
import { ask } from './Dialog';

// The first commit offer. Agent chats work in their own copy of the project
// (a git worktree), which has to start from a commit, so a repository with
// none (a new, empty GitHub repository) gets this on the GitHub page, in agent
// chats and in setup. It shows what goes in, and asks before committing.

const files = (n: number) => `${n} ${n === 1 ? 'file' : 'files'}`;

/** Shown while your project folder's repository has no commit; nothing otherwise. */
export function FirstCommitPrompt({ state, why }: { state: AppState; why: string }) {
  const local = state.workspace;
  const needed = !!local?.git && !local.error && !local.git.hasCommits;
  const [plan, setPlan] = useState<FirstCommitPlan | null>(null);
  const [push, setPush] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const remoteBranches = local?.git?.remoteBranches.length ?? 0;
  useEffect(() => {
    if (!needed) return;
    let current = true;
    void window.pct.readFirstCommit().then((r) => {
      if (!current) return;
      if (r.ok) setPlan(r.value);
      else setResult({ ok: false, text: r.error });
    });
    return () => {
      current = false;
    };
  }, [needed, local?.folder, remoteBranches]);

  if (!needed) return result?.ok ? <p className="good small first-commit-done">{result.text}</p> : null;

  if (plan?.onGitHub) {
    return (
      <div className="first-commit">
        <p className="small">
          Your copy has no commit yet, but GitHub has some: pick one of its branches under Branch on the GitHub page to get them.
        </p>
      </div>
    );
  }

  const willPush = push && plan?.pushTo !== null;
  const make = async () => {
    if (!plan) return;
    const list = plan.files.map((f) => `• ${f.path}${f.isNew ? ' (new)' : ''}`).join('\n');
    const rest = plan.leftOut > 0 ? `\n\nThe other ${files(plan.leftOut)} in your folder stay uncommitted, for you to commit when you are ready.` : '';
    const ok = await ask(willPush ? `Make the first commit and push it to ${plan.pushTo}?` : 'Make the first commit?', {
      detail: `On branch ${plan.branch}, with:\n${list}${rest}`,
      confirm: willPush ? 'Commit and push' : 'Commit',
    });
    if (!ok) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await window.pct.makeFirstCommit(willPush);
      setResult(r.ok ? { ok: true, text: r.value } : { ok: false, text: r.error });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="first-commit">
      <p className="small">
        <strong>This repository has no commit yet.</strong> {why}
      </p>
      {plan && (
        <p className="muted small">
          The first commit holds {plan.files.map((f) => f.path).join(', ')}
          {plan.leftOut > 0 ? `; the other ${files(plan.leftOut)} stay uncommitted` : ''}.
        </p>
      )}
      <div className="lock-form">
        <button disabled={!plan || busy} onClick={() => void make()}>
          {busy ? 'Committing…' : 'Make the first commit…'}
        </button>
        {plan?.pushTo && (
          <label className="check small">
            <input type="checkbox" checked={push} disabled={busy} onChange={(e) => setPush(e.target.checked)} />
            Push it to {plan.pushTo}
          </label>
        )}
      </div>
      {result && <p className={result.ok ? 'good small' : 'error small'}>{result.text}</p>}
    </div>
  );
}
