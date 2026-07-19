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
import { loadPolicy } from './policy.js';

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
    // present | absent | not-required | pending — computed at finish from
    // verification.md (see adversarialReviewState). "Don't self-certify."
    adversarial_review: 'pending',
    // The session that started this run, bound by the post-tool hook. Audit
    // and tokens from other concurrent sessions stay out of this run.
    session: null,
    plan_gate: planGate || 'auto',
    plan_approved: false,
    tokens: { input: 0, output: 0, cache_read: 0 },
    // When each state was first entered — cycle time and queue latency
    // derive from these.
    state_times: { 'in-progress': nowIso() },
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

// The run lifecycle is a real state machine, not free-text: skipping straight
// to `shipped` from `in-progress` defeats the review the pipeline exists for.
// Reopen paths (awaiting-review/done → in-progress, done → awaiting-review)
// stay legal because humans do change their minds; `shipped` is terminal.
export const RUN_STATES = ['in-progress', 'blocked', 'awaiting-review', 'done', 'shipped'];
const RUN_TRANSITIONS = {
  'in-progress': ['blocked', 'awaiting-review'],
  blocked: ['in-progress', 'awaiting-review'],
  'awaiting-review': ['in-progress', 'done', 'shipped'],
  done: ['in-progress', 'awaiting-review', 'shipped'],
  shipped: [],
};

function assertTransition(from, to, force) {
  if (!RUN_STATES.includes(to)) {
    throw new Error(`Unknown state "${to}" — valid states: ${RUN_STATES.join(', ')}`);
  }
  if (force || from === to) return;
  // Legacy runs may predate the state machine; only validate known states.
  if (RUN_TRANSITIONS[from] && !RUN_TRANSITIONS[from].includes(to)) {
    const next = RUN_TRANSITIONS[from].length ? RUN_TRANSITIONS[from].join(', ') : '(none — terminal)';
    throw new Error(
      `Illegal transition ${from} → ${to}. Allowed from ${from}: ${next}. Override with --force (audited).`
    );
  }
}

export function setRunState(projectId, runId, state, { force = false, by = null } = {}) {
  const current = runMeta(projectId, runId);
  if (!current) throw new Error(`Unknown run: ${runId}`);
  assertTransition(current.state, state, force);
  const meta = mutateRunMeta(projectId, runId, (m) => {
    m.state = state;
    m.state_times = m.state_times || {};
    if (!m.state_times[state]) m.state_times[state] = nowIso();
    if (by && (state === 'done' || state === 'shipped')) m.closed_by = { ...by, ts: nowIso() };
  });
  if (!meta) throw new Error(`Unknown run: ${runId}`);
  appendAudit(projectId, {
    event: 'run-state',
    run: runId,
    state,
    forced: force || undefined,
    by: by || undefined,
  });
  return meta;
}

// Bind a run to the session that started it (first bind wins). Called by the
// post-tool hook when it sees the `aos run start` command complete. `baseline`
// is the session's transcript usage at bind time — the run is only charged
// for what the session spends *after* it started.
export function bindRunSession(projectId, runId, sessionId, baseline = null) {
  if (!sessionId) return null;
  return mutateRunMeta(projectId, runId, (m) => {
    if (m.session) return false;
    m.session = sessionId;
    if (baseline) m.tokens_baseline = baseline;
  });
}

// Credit a run with (usage so far − its baseline), exactly once. Called when
// the run finishes (post-tool hook) or at SessionEnd, whichever comes first —
// the settled flag makes the second caller a no-op, so a session that runs
// several runs back-to-back can't dump its whole total onto the last one.
const MODEL_BUCKET_KEYS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];

function addModelBuckets(target, nowModels, baseModels = {}) {
  for (const [id, u] of Object.entries(nowModels || {})) {
    const base = baseModels[id] || {};
    const t = (target[id] = target[id] || { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 });
    for (const k of MODEL_BUCKET_KEYS) t[k] += Math.max(0, (u[k] || 0) - (base[k] || 0));
  }
}

export function settleRunTokens(projectId, runId, usageNow) {
  return mutateRunMeta(projectId, runId, (meta) => {
    meta.tokens = meta.tokens || { input: 0, output: 0, cache_read: 0 }; // legacy runs
    // Unbound runs (started from a terminal, not a session) keep the old
    // accumulate-per-session behavior — every session's usage is theirs.
    if (!meta.session) {
      meta.tokens.input += usageNow.input || 0;
      meta.tokens.output += usageNow.output || 0;
      meta.tokens.cache_read = (meta.tokens.cache_read || 0) + (usageNow.cache_read || 0);
      if (usageNow.models) {
        meta.tokens.models = meta.tokens.models || {};
        addModelBuckets(meta.tokens.models, usageNow.models);
      }
      return;
    }
    if (meta.tokens_settled) return false;
    const base = meta.tokens_baseline || { input: 0, output: 0, cache_read: 0 };
    meta.tokens.input += Math.max(0, (usageNow.input || 0) - (base.input || 0));
    meta.tokens.output += Math.max(0, (usageNow.output || 0) - (base.output || 0));
    meta.tokens.cache_read =
      (meta.tokens.cache_read || 0) + Math.max(0, (usageNow.cache_read || 0) - (base.cache_read || 0));
    if (usageNow.models) {
      meta.tokens.models = meta.tokens.models || {};
      addModelBuckets(meta.tokens.models, usageNow.models, base.models);
    }
    meta.tokens_settled = true;
  });
}

// The most recent run bound to this session, active or not — SessionEnd uses
// this so a run finished mid-session still receives its tokens.
export function findRunBySession(projectId, sessionId) {
  if (!sessionId) return null;
  return listRuns(projectId).find((r) => r.session === sessionId) || null;
}

export function approvePlan(projectId, runId, by = null) {
  const meta = mutateRunMeta(projectId, runId, (m) => {
    if (m.plan_approved) return false;
    m.plan_approved = true;
    if (by) m.approved_by = { ...by, ts: nowIso() };
  });
  if (!meta) throw new Error(`Unknown run: ${runId}`);
  appendAudit(projectId, { event: 'plan-approved', run: runId, by: by || undefined });
  return meta;
}

// Evidence-of-process, not proof-of-quality: we can't judge whether an
// adversarial review was any good, but we can record whether one was actually
// written into verification.md. `not-required` when policy opts out.
export function adversarialReviewState(projectId, runId) {
  const policy = loadPolicy(projectId);
  if (policy.verification?.adversarial_review === false) return 'not-required';
  const md = readIfExists(path.join(runDir(projectId, runId), 'verification.md')) || '';
  const heading = md.match(/^#{1,6}\s*.*(adversarial|skeptic|refut)/im);
  if (!heading) return 'absent';
  // A bare heading with nothing under it doesn't count as a review.
  const body = md.slice(heading.index + heading[0].length).trim();
  return body.length > 20 ? 'present' : 'absent';
}

// A memory write is any audited tool call that touched learnings.md or
// decisions.md — file-tool paths and Bash commands both surface the filename
// in the audit summary (post-tool hook), so a substring check covers `Edit`
// as well as `cat >> learnings.md` appends.
const MEMORY_FILES = ['learnings.md', 'decisions.md'];
const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function auditLines(file) {
  const raw = readIfExists(file);
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function isMemoryWrite(entry) {
  if (entry.event !== 'tool') return false;
  const s = String(entry.summary || '');
  if (!MEMORY_FILES.some((f) => s.includes(f))) return false;
  if (WRITE_TOOLS.has(entry.tool)) return true;
  // Bash summaries are the command text: only count commands that actually
  // write (redirect/tee/in-place edit) — `cat`/`grep` reads of learnings.md
  // must not satisfy the capture check.
  if (entry.tool === 'Bash') return /(>|\btee\b|\bsed\s+-\w*i)/.test(s);
  return false;
}

// Same evidence-of-process bar as adversarialReviewState: we can't judge
// whether a learning was any good, but we can record whether one was written.
export function learningsState(projectId, runId) {
  const lines = auditLines(path.join(runDir(projectId, runId), 'audit.jsonl'));
  return lines.some(isMemoryWrite) ? 'present' : 'absent';
}

// What a session did, seen through its audit lines. A session's lines land in
// the run bound to it or in the project log (see appendAudit), so scan both.
// `substantive` = enough file-tool writes to plausibly owe a learning, or any
// bound run; `memoryWrite` = learnings/decisions were touched; `nudged` =
// the Stop hook already blocked once for this session.
export function sessionMemoryActivity(projectId, sessionId) {
  if (!sessionId) return { substantive: false, memoryWrite: false, nudged: false };
  const files = [path.join(projectDir(projectId), 'audit.jsonl')];
  const bound = findRunBySession(projectId, sessionId);
  if (bound) files.push(path.join(runDir(projectId, bound.run), 'audit.jsonl'));
  const active = getActiveRun(projectId);
  if (active && (!bound || active !== bound.run)) {
    files.push(path.join(runDir(projectId, active), 'audit.jsonl'));
  }
  let writes = 0;
  let memoryWrite = false;
  let nudged = false;
  for (const file of files) {
    for (const entry of auditLines(file)) {
      if (entry.session !== sessionId) continue;
      if (entry.event === 'learnings-nudge') nudged = true;
      if (entry.event !== 'tool') continue;
      if (isMemoryWrite(entry)) memoryWrite = true;
      if (WRITE_TOOLS.has(entry.tool)) writes++;
    }
  }
  return { substantive: Boolean(bound) || writes >= 3, memoryWrite, nudged, bound };
}

export function finishRun(projectId, runId, state = 'awaiting-review') {
  const current = runMeta(projectId, runId);
  if (!current) throw new Error(`Unknown run: ${runId}`);
  assertTransition(current.state, state, false);
  const adversarial_review = adversarialReviewState(projectId, runId);
  const learnings_recorded = learningsState(projectId, runId);
  const meta = mutateRunMeta(projectId, runId, (m) => {
    m.state = state;
    m.adversarial_review = adversarial_review;
    m.learnings_recorded = learnings_recorded;
    m.state_times = m.state_times || {};
    if (!m.state_times[state]) m.state_times[state] = nowIso();
  });
  if (!meta) throw new Error(`Unknown run: ${runId}`);
  appendAudit(projectId, { event: 'run-state', run: runId, state, adversarial_review, learnings_recorded });
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

export function readRunFile(projectId, runId, file) {
  return readIfExists(path.join(runDir(projectId, runId), file));
}
