import fs from 'node:fs';
import path from 'node:path';
import {
  projectDir,
  ensureDir,
  readJson,
  writeJson,
  appendLine,
  readIfExists,
  slugify,
  today,
  nowIso,
} from './paths.js';

export function statePath(projectId) {
  return path.join(projectDir(projectId), 'state.json');
}

export function runsDir(projectId) {
  return path.join(projectDir(projectId), 'runs');
}

export function runDir(projectId, runId) {
  return path.join(runsDir(projectId), runId);
}

export function getActiveRun(projectId) {
  const state = readJson(statePath(projectId), {});
  return state.activeRun || null;
}

export function setActiveRun(projectId, runId) {
  const state = readJson(statePath(projectId), {});
  state.activeRun = runId;
  writeJson(statePath(projectId), state);
}

export function runMeta(projectId, runId) {
  return readJson(path.join(runDir(projectId, runId), 'meta.json'), null);
}

export function saveRunMeta(projectId, runId, meta) {
  writeJson(path.join(runDir(projectId, runId), 'meta.json'), meta);
}

export function startRun(projectId, { ticket, title }) {
  const base = `${today()}-${slugify(ticket || title || 'run')}`;
  let runId = base;
  let i = 2;
  while (fs.existsSync(runDir(projectId, runId))) {
    runId = `${base}-${i++}`;
  }
  const dir = ensureDir(runDir(projectId, runId));
  const meta = {
    run: runId,
    ticket: ticket || null,
    title: title || null,
    state: 'in-progress',
    verification: 'pending',
    verification_attempts: 0,
    tokens: { input: 0, output: 0 },
    created: nowIso(),
    updated: nowIso(),
  };
  saveRunMeta(projectId, runId, meta);
  fs.writeFileSync(
    path.join(dir, 'ticket.md'),
    `# Ticket — ${ticket || title || runId}\n\n## Source\n\n(paste or summarize the original ticket here)\n\n## Acceptance criteria\n\n- [ ] ...\n`
  );
  setActiveRun(projectId, runId);
  appendAudit(projectId, { event: 'run-start', run: runId, ticket: ticket || null });
  return { runId, dir, meta };
}

export function setRunState(projectId, runId, state) {
  const meta = runMeta(projectId, runId);
  if (!meta) throw new Error(`Unknown run: ${runId}`);
  meta.state = state;
  meta.updated = nowIso();
  saveRunMeta(projectId, runId, meta);
  appendAudit(projectId, { event: 'run-state', run: runId, state });
  return meta;
}

export function finishRun(projectId, runId, state = 'awaiting-review') {
  const meta = setRunState(projectId, runId, state);
  if (getActiveRun(projectId) === runId) setActiveRun(projectId, null);
  return meta;
}

export function listRuns(projectId) {
  const dir = runsDir(projectId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => fs.existsSync(path.join(dir, d, 'meta.json')))
    .map((d) => runMeta(projectId, d))
    .filter(Boolean)
    .sort((a, b) => (a.created < b.created ? 1 : -1));
}

// Audit lines go to the active run when one exists, else to the project log —
// session exhaust outside a run is still worth keeping.
export function appendAudit(projectId, entry) {
  const active = getActiveRun(projectId);
  const line = JSON.stringify({ ts: nowIso(), ...entry });
  if (active && fs.existsSync(runDir(projectId, active))) {
    appendLine(path.join(runDir(projectId, active), 'audit.jsonl'), line);
  } else {
    appendLine(path.join(projectDir(projectId), 'audit.jsonl'), line);
  }
}

export function addRunTokens(projectId, runId, usage) {
  const meta = runMeta(projectId, runId);
  if (!meta) return;
  meta.tokens.input += usage.input || 0;
  meta.tokens.output += usage.output || 0;
  meta.updated = nowIso();
  saveRunMeta(projectId, runId, meta);
}

export function readRunFile(projectId, runId, file) {
  return readIfExists(path.join(runDir(projectId, runId), file));
}
