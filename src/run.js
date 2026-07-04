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
  withLock,
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
  withLock(statePath(projectId), () => {
    const state = readJson(statePath(projectId), {});
    state.activeRun = runId;
    writeJson(statePath(projectId), state);
  });
}

export function runMeta(projectId, runId) {
  return readJson(path.join(runDir(projectId, runId), 'meta.json'), null);
}

export function saveRunMeta(projectId, runId, meta) {
  writeJson(path.join(runDir(projectId, runId), 'meta.json'), meta);
}

// All meta updates go through here: read-modify-write under the lock so two
// concurrent sessions (or a hook racing the CLI) can't drop each other's
// update. The mutator returns false to signal "no change, don't write".
export function mutateRunMeta(projectId, runId, mutate) {
  const file = path.join(runDir(projectId, runId), 'meta.json');
  return withLock(file, () => {
    const meta = readJson(file, null);
    if (!meta) return null;
    if (mutate(meta) === false) return meta;
    meta.updated = nowIso();
    writeJson(file, meta);
    return meta;
  });
}

export function startRun(projectId, { ticket, title, planGate }) {
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
    // The session that started this run, bound by the post-tool hook. Audit
    // and tokens from other concurrent sessions stay out of this run.
    session: null,
    plan_gate: planGate || 'auto',
    plan_approved: false,
    tokens: { input: 0, output: 0, cache_read: 0 },
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
  const meta = mutateRunMeta(projectId, runId, (m) => {
    m.state = state;
  });
  if (!meta) throw new Error(`Unknown run: ${runId}`);
  appendAudit(projectId, { event: 'run-state', run: runId, state });
  return meta;
}

// Bind a run to the session that started it (first bind wins). Called by the
// post-tool hook when it sees the `aos run start` command complete.
export function bindRunSession(projectId, runId, sessionId) {
  if (!sessionId) return null;
  return mutateRunMeta(projectId, runId, (m) => {
    if (m.session) return false;
    m.session = sessionId;
  });
}

export function approvePlan(projectId, runId) {
  const meta = mutateRunMeta(projectId, runId, (m) => {
    if (m.plan_approved) return false;
    m.plan_approved = true;
  });
  if (!meta) throw new Error(`Unknown run: ${runId}`);
  appendAudit(projectId, { event: 'plan-approved', run: runId });
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
// session exhaust outside a run is still worth keeping. A run bound to a
// session only accepts that session's lines: a second concurrent session in
// the same repo lands in the project log instead of polluting the run's
// audit trail. Unbound runs (started from a terminal, not via a session)
// keep the old accept-everything behavior.
export function appendAudit(projectId, entry) {
  const active = getActiveRun(projectId);
  const line = JSON.stringify({ ts: nowIso(), ...entry });
  if (active && fs.existsSync(runDir(projectId, active))) {
    const boundSession = runMeta(projectId, active)?.session;
    if (!boundSession || !entry.session || entry.session === boundSession) {
      appendLine(path.join(runDir(projectId, active), 'audit.jsonl'), line);
      return;
    }
  }
  appendLine(path.join(projectDir(projectId), 'audit.jsonl'), line);
}

export function addRunTokens(projectId, runId, usage) {
  mutateRunMeta(projectId, runId, (meta) => {
    meta.tokens.input += usage.input || 0;
    meta.tokens.output += usage.output || 0;
    meta.tokens.cache_read = (meta.tokens.cache_read || 0) + (usage.cache_read || 0);
  });
}

export function readRunFile(projectId, runId, file) {
  return readIfExists(path.join(runDir(projectId, runId), file));
}
