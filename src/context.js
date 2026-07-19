import path from 'node:path';
import { projectDir, readIfExists, tailLines } from './paths.js';
import { listRuns } from './run.js';
import { loadPolicy } from './policy.js';

const MAX_CONTEXT_CHARS = 9000;

// The most recent session that owed learnings, unless a later session already
// wrote memory (that addresses the debt). Light sessions in between neither
// clear nor create debt — it persists until someone actually writes.
function owedSessionEntry(dir) {
  const raw = readIfExists(path.join(dir, 'sessions.jsonl'));
  if (!raw) return null;
  const lines = raw.trim().split('\n').slice(-20);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.memory_write) return null;
      if (entry.learnings_owed) return entry;
    } catch {
      // skip malformed lines
    }
  }
  return null;
}

export function buildContext(projectId, projectName) {
  const dir = projectDir(projectId);
  const pack = readIfExists(path.join(dir, 'context', 'pack.md'));
  const decisions = readIfExists(path.join(dir, 'context', 'decisions.md'));
  const learnings = readIfExists(path.join(dir, 'learnings.md'));
  const policy = loadPolicy(projectId);
  const open = listRuns(projectId).filter((r) =>
    ['in-progress', 'blocked', 'awaiting-review'].includes(r.state)
  );

  const parts = [];
  parts.push(`# AOS project context — ${projectName || projectId}`);
  parts.push(
    `Plan gate: ${policy.plan_gate}. Gated actions require human approval; audit is automatic.`
  );
  // Learnings debt from a previous session (SessionEnd marker). Placed
  // before the pack so the MAX_CONTEXT_CHARS slice can't drop it.
  const lastSession = owedSessionEntry(dir);
  if (lastSession) {
    parts.push(
      `⚠ A previous session (${lastSession.session || 'unknown'}, ${lastSession.ts || ''}) did ` +
        `substantive work but recorded no learnings. If you can tell what it did (check its run's ` +
        `outcome.md / audit), append what it learned to learnings.md — or run /aos-learn.`
    );
  }
  if (pack) parts.push(`## Context pack\n${pack.trim()}`);
  if (decisions) parts.push(`## Recent decisions\n${tailLines(decisions, 40)}`);
  if (learnings) parts.push(`## Learnings\n${tailLines(learnings, 30)}`);
  if (open.length) {
    parts.push(
      `## Open runs\n` +
        open
          .map((r) => `- ${r.run} [${r.state}]${r.ticket ? ` — ${r.ticket}` : ''}`)
          .join('\n')
    );
  }
  let out = parts.join('\n\n');
  if (out.length > MAX_CONTEXT_CHARS) {
    out = out.slice(0, MAX_CONTEXT_CHARS) + '\n\n[context truncated — read full files under ' + dir + ']';
  }
  return out;
}
