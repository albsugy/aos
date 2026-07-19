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

// Template placeholders that survive into pack.md mean nobody (human or
// agent) has actually described the project yet.
const PACK_PLACEHOLDER = '(one paragraph';

const LEARNINGS_WINDOW = 30;
const DECISIONS_WINDOW = 40;
// Per-section ceilings: memory sections are guaranteed to fit; the pack
// absorbs whatever budget remains instead of amputating everything after it.
const SECTION_CAP = 2500;

function capChars(text, cap, note) {
  if (text.length <= cap) return text;
  return text.slice(0, cap) + `\n[truncated — ${note}]`;
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

  const head = [];
  head.push(`# AOS project context — ${projectName || projectId}`);
  head.push(
    `Plan gate: ${policy.plan_gate}. Gated actions require human approval; audit is automatic.`
  );
  if (pack && pack.includes(PACK_PLACEHOLDER)) {
    head.push(
      `⚠ The context pack still contains template placeholder lines — run /aos-onboard to ` +
        `have this session extract it from the repo (pack, decisions from git history, ` +
        `contracts). Deleting the remaining "(placeholder)" lines silences this.`
    );
  }
  // Learnings debt from a previous session (SessionEnd marker).
  const lastSession = owedSessionEntry(dir);
  if (lastSession) {
    head.push(
      `⚠ A previous session (${lastSession.session || 'unknown'}, ${lastSession.ts || ''}) did ` +
        `substantive work but recorded no learnings. If you can tell what it did (check its run's ` +
        `outcome.md / audit), append what it learned to learnings.md — or run /aos-learn.`
    );
  }

  const tailSections = [];
  if (decisions) {
    tailSections.push(
      `## Recent decisions\n${capChars(tailLines(decisions, DECISIONS_WINDOW), SECTION_CAP, 'read context/decisions.md')}`
    );
  }
  if (learnings) {
    const lineCount = learnings.split('\n').filter((l) => l.trim()).length;
    let section = `## Learnings\n${capChars(tailLines(learnings, LEARNINGS_WINDOW), SECTION_CAP, 'read learnings.md')}`;
    if (lineCount > LEARNINGS_WINDOW) {
      section +=
        `\n⚠ learnings.md has ${lineCount} lines; only the last ${LEARNINGS_WINDOW} auto-load — ` +
        `the rest are invisible to new sessions. Distill older bullets into the context pack or ` +
        `playbooks (/aos-learn), and use \`aos find <query>\` for recall.`;
    }
    tailSections.push(section);
  }
  if (open.length) {
    tailSections.push(
      `## Open runs\n` +
        open
          .map((r) => `- ${r.run} [${r.state}]${r.ticket ? ` — ${r.ticket}` : ''}`)
          .join('\n')
    );
  }

  // Budget: everything except the pack is guaranteed; the pack gets what's
  // left, so a bloated pack can no longer amputate learnings or open runs.
  const fixedLen = [...head, ...tailSections].join('\n\n').length;
  const parts = [...head];
  if (pack) {
    const packBudget = Math.max(0, MAX_CONTEXT_CHARS - fixedLen - 100);
    parts.push(`## Context pack\n${capChars(pack.trim(), packBudget, 'read context/pack.md')}`);
  }
  parts.push(...tailSections);

  let out = parts.join('\n\n');
  if (out.length > MAX_CONTEXT_CHARS) {
    out = out.slice(0, MAX_CONTEXT_CHARS) + '\n\n[context truncated — read full files under ' + dir + ']';
  }
  return out;
}
