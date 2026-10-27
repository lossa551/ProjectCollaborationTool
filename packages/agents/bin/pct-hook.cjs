#!/usr/bin/env node
// Claude Code PreToolUse hook. Claude Code runs this before every tool use;
// it asks Foreus (which checks locks, scope and approvals, and
// may wait for a person) and answers allow or deny. If the app cannot be
// reached the tool is denied, so nothing slips past the checks.
'use strict';

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', async () => {
  let decision = 'deny';
  let reason = 'Foreus could not be reached, so this was not allowed.';
  try {
    const event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const response = await fetch(process.env.PCT_HOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.PCT_HOOK_TOKEN}` },
      body: JSON.stringify({ chatId: process.env.PCT_CHAT_ID, event }),
    });
    if (response.ok) {
      const answer = await response.json();
      decision = answer.allow ? 'allow' : 'deny';
      reason = String(answer.reason || '');
    }
  } catch {
    // Keep the deny above.
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason },
    }),
  );
  process.exit(0);
});
