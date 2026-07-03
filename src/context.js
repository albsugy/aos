import path from 'node:path';
import { projectDir, readIfExists, tailLines } from './paths.js';
import { listRuns } from './run.js';
import { loadPolicy } from './policy.js';

const MAX_CONTEXT_CHARS = 9000;

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
