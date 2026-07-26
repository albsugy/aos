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
import { reviewState, reviewCounts, reviewPath, reviewProblemLines, BLOCKING_REVIEW_STATES } from './review.js';

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
    // pending | clean | resolved | open | invalid | absent | not-required |
    // forced — computed at finish from review.json (see review.js). Blocking
    // states stop the finish. "Don't self-certify."
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
  // `run state awaiting-review` reaches the same state finishRun does, so it
  // has to clear the same gate — otherwise the review is one command away from
  // being skipped. Closing states normally arrive THROUGH that gated edge, but
  // `--force` can jump straight to done/shipped from anywhere — so a close
  // also snapshots the review (never blocks: the human sign-off is the
  // authority at close) rather than leaving meta stuck at "pending" as if the
  // question had never come up.
  const gated = state === 'awaiting-review';
  const closing = state === 'done' || state === 'shipped';
  const review = gated
    ? assertReviewGate(projectId, runId, force)
    : closing
      ? { ...reviewState(projectId, runId), blocked: false }
      : null;
  const meta = mutateRunMeta(projectId, runId, (m) => {
    m.state = state;
    // A close only fills the snapshot in when the gated edge never ran
    // (forced jump) — it must not overwrite an earlier honest `forced` stamp.
    if (review && (gated || !m.adversarial_review || m.adversarial_review === 'pending')) {
      m.adversarial_review = review.blocked ? 'forced' : review.state;
      m.review = { state: review.state, ...reviewCounts(review.findings) };
    }
    m.state_times = m.state_times || {};
    if (!m.state_times[state]) m.state_times[state] = nowIso();
    if (by && closing) m.closed_by = { ...by, ts: nowIso() };
  });
  if (!meta) throw new Error(`Unknown run: ${runId}`);
  // Same audit fields as finishRun: an auditor grepping for review_forced or
  // adversarial_review must see this path too, not only `run finish`.
  appendAudit(projectId, {
    event: 'run-state',
    run: runId,
    state,
    forced: force || undefined,
    adversarial_review: review ? (review.blocked ? 'forced' : review.state) : undefined,
    review_forced: review?.blocked || undefined,
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

// Credit `usageNow − base` onto the run's totals, never negative.
function creditDelta(tokens, usageNow, base = {}) {
  tokens.input += Math.max(0, (usageNow.input || 0) - (base.input || 0));
  tokens.output += Math.max(0, (usageNow.output || 0) - (base.output || 0));
  tokens.cache_read = (tokens.cache_read || 0) + Math.max(0, (usageNow.cache_read || 0) - (base.cache_read || 0));
  if (usageNow.models) {
    tokens.models = tokens.models || {};
    addModelBuckets(tokens.models, usageNow.models, base.models);
  }
}

// Per-field max of two usage snapshots, model buckets included.
function highWater(seen, usageNow) {
  const out = {
    input: Math.max(seen.input || 0, usageNow.input || 0),
    output: Math.max(seen.output || 0, usageNow.output || 0),
    cache_read: Math.max(seen.cache_read || 0, usageNow.cache_read || 0),
    models: {},
  };
  for (const id of new Set([...Object.keys(seen.models || {}), ...Object.keys(usageNow.models || {})])) {
    const a = (seen.models || {})[id] || {};
    const b = (usageNow.models || {})[id] || {};
    out.models[id] = Object.fromEntries(MODEL_BUCKET_KEYS.map((k) => [k, Math.max(a[k] || 0, b[k] || 0)]));
  }
  return out;
}

export function settleRunTokens(projectId, runId, usageNow, sessionId = null) {
  return mutateRunMeta(projectId, runId, (meta) => {
    meta.tokens = meta.tokens || { input: 0, output: 0, cache_read: 0 }; // legacy runs
    // Unbound runs (started from a terminal, not a session) can legitimately
    // collect usage from several sessions — but each session's transcript total
    // is CUMULATIVE and SessionEnd fires repeatedly against it (resume, /clear,
    // logout). Adding the raw total every time multiplied an unbound run's
    // spend by the number of endings, the same bug sessions.jsonl had. So keep
    // a per-session high-water mark and credit only what is new.
    if (!meta.session) {
      const key = sessionId || '_';
      meta.tokens_seen = meta.tokens_seen || {};
      const seen = meta.tokens_seen[key] || {};
      creditDelta(meta.tokens, usageNow, seen);
      // A HIGH-WATER mark, not the last value: a rotated or truncated
      // transcript reports less than it did before, and storing that smaller
      // number would re-credit the same region on the next firing.
      meta.tokens_seen[key] = highWater(seen, usageNow);
      return;
    }
    if (meta.tokens_settled) return false;
    creditDelta(meta.tokens, usageNow, meta.tokens_baseline || {});
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

// The adversarial review lives in review.json now — see review.js for the
// schema and for why the old heading-in-verification.md check was replaced.
export function adversarialReviewState(projectId, runId) {
  return reviewState(projectId, runId).state;
}

// Thrown by finishRun when the review gate refuses. Carries the already
// formatted lines so the CLI prints one message and adds no reasoning of its own.
export class ReviewGateError extends Error {
  constructor(lines) {
    super(lines.join('\n'));
    this.name = 'ReviewGateError';
    this.lines = lines;
  }
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
// bound run; `memoryWrite` = learnings/decisions were touched; `nudged` /
// `reviewNudged` = the Stop hook already blocked once for this session, per
// topic (each nudge fires at most once, independently).
export function sessionMemoryActivity(projectId, sessionId) {
  if (!sessionId) {
    return { substantive: false, memoryWrite: false, nudged: false, reviewNudged: false };
  }
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
  let reviewNudged = false;
  for (const file of files) {
    for (const entry of auditLines(file)) {
      if (entry.session !== sessionId) continue;
      if (entry.event === 'learnings-nudge') nudged = true;
      if (entry.event === 'review-nudge') reviewNudged = true;
      if (entry.event !== 'tool') continue;
      if (isMemoryWrite(entry)) memoryWrite = true;
      if (WRITE_TOOLS.has(entry.tool)) writes++;
    }
  }
  return { substantive: Boolean(bound) || writes >= 3, memoryWrite, nudged, reviewNudged, bound };
}

// The one quality claim AOS enforces rather than reports: a run does not reach
// awaiting-review while its adversarial review is missing, malformed, or has
// an unresolved finding. `--force` is the escape hatch and is audited — the
// point is that skipping the review becomes a visible act, not a silent one.
// Throws unless the run's review clears the gate; returns what the gate saw
// (plus `blocked`, i.e. "cleared only because --force was passed").
function assertReviewGate(projectId, runId, force) {
  const review = reviewState(projectId, runId);
  const blocked = review.mode === 'gate' && BLOCKING_REVIEW_STATES.has(review.state);
  if (blocked && !force) {
    throw new ReviewGateError([
      `Run ${runId} cannot reach awaiting-review — the adversarial review gate is not satisfied.`,
      '',
      ...reviewProblemLines(review, reviewPath(projectId, runId)),
      '',
      'Then re-run the command. To proceed anyway: add --force (recorded in the audit).',
      'To turn the gate into a warning for this project: verification.adversarial_review: warn in policy.yaml.',
    ]);
  }
  return { ...review, blocked };
}

export function finishRun(projectId, runId, state = 'awaiting-review', { force = false } = {}) {
  const current = runMeta(projectId, runId);
  if (!current) throw new Error(`Unknown run: ${runId}`);
  // assertTransition's own error advises --force, so the flag must actually
  // reach it — one flag forces both the transition and the review gate, the
  // same contract `run state` has.
  assertTransition(current.state, state, force);
  // Only the entry into awaiting-review is gated; `--state blocked` is a
  // legitimate way to park a run that never got as far as a review.
  const review =
    state === 'awaiting-review'
      ? assertReviewGate(projectId, runId, force)
      : { ...reviewState(projectId, runId), blocked: false };
  const blocked = review.blocked;
  const adversarial_review = blocked ? 'forced' : review.state;
  const learnings_recorded = learningsState(projectId, runId);
  const meta = mutateRunMeta(projectId, runId, (m) => {
    m.state = state;
    m.adversarial_review = adversarial_review;
    // What the gate saw, so a reviewer reading meta.json doesn't have to
    // re-derive it — and so `forced` records what was skipped.
    m.review = { state: review.state, ...reviewCounts(review.findings) };
    m.learnings_recorded = learnings_recorded;
    m.state_times = m.state_times || {};
    if (!m.state_times[state]) m.state_times[state] = nowIso();
  });
  if (!meta) throw new Error(`Unknown run: ${runId}`);
  appendAudit(projectId, {
    event: 'run-state',
    run: runId,
    state,
    forced: force || undefined,
    adversarial_review,
    review_forced: blocked || undefined,
    learnings_recorded,
  });
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

// What a dry-run policy suppressed: the count and a breakdown by action, so
// somebody tuning a policy can see what it WOULD do before switching it on.
// Only called when dry_run is actually enabled — it reads every run's audit,
// which is too much IO to do on every `aos status`.
export function dryRunGateSummary(projectId) {
  const files = [path.join(projectDir(projectId), 'audit.jsonl')];
  for (const r of listRuns(projectId)) files.push(path.join(runDir(projectId, r.run), 'audit.jsonl'));
  const byAction = {};
  let total = 0;
  for (const file of files) {
    for (const entry of auditLines(file)) {
      if (entry.event !== 'gate' || !entry.dry_run) continue;
      total++;
      const key = `${entry.decision}:${entry.action}`;
      byAction[key] = (byAction[key] || 0) + 1;
    }
  }
  return { total, byAction };
}
