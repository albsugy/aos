import fs from 'node:fs';
import path from 'node:path';
import {
  projectDir,
  ensureDir,
  readJson,
  writeJson,
  readIfExists,
  slugify,
  today,
  nowIso,
  withLock,
  canonicalPath,
} from './paths.js';
import { reviewState, reviewCounts, reviewPath, reviewProblemLines, BLOCKING_REVIEW_STATES } from './review.js';
import { gitBranch, safeUrl } from './vcs.js';
import { appendChainedTo, verifyLedger } from './chain.js';

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

export function startRun(projectId, { ticket, title, planGate, repoRoot = null, ticketUrl = null }) {
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
    // The source ticket, when `--ticket` was given a URL — otherwise the id is
    // all we have and the link back to the tracker is lost.
    ticket_url: ticketUrl || null,
    title: title || null,
    // Captured at start, refreshed at finish: reviewing a run means reading its
    // diff, and without the branch the console can only describe the change.
    branch: repoRoot ? gitBranch(repoRoot) : null,
    pr_url: null,
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
// States that end a run. Reaching one is the act a human signs off on,
// whichever command gets there.
export const CLOSING_STATES = new Set(['done', 'shipped']);
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
  let stamped = null;
  const meta = mutateRunMeta(projectId, runId, (m) => {
    m.state = state;
    // A close only fills the snapshot in when the gated edge never ran
    // (forced jump) — it must not overwrite an earlier honest `forced` stamp.
    if (review && (gated || !m.adversarial_review || m.adversarial_review === 'pending')) {
      m.adversarial_review = review.blocked ? 'forced' : review.state;
      m.review = { state: review.state, ...reviewCounts(review.findings) };
    }
    // What meta actually ends up saying — the audit must agree with it. Auditing
    // the freshly computed state instead made the close line contradict the run
    // it described (meta `forced`, audit `absent`).
    stamped = m.adversarial_review;
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
    adversarial_review: stamped || undefined,
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

export function finishRun(projectId, runId, state = 'awaiting-review', { force = false, repoRoot = null, by = null } = {}) {
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
  const touched = touchedFiles(projectId, runId, repoRoot);
  // The branch is re-read here: work often starts on main and moves to a
  // feature branch once the plan is approved, so the start-time value is
  // frequently not the branch the change actually lives on.
  const branchNow = repoRoot ? gitBranch(repoRoot) : null;
  const meta = mutateRunMeta(projectId, runId, (m) => {
    m.state = state;
    m.files = touched.files;
    m.bash_writes = touched.bash_writes || undefined;
    if (branchNow) m.branch = branchNow;
    m.adversarial_review = adversarial_review;
    // What the gate saw, so a reviewer reading meta.json doesn't have to
    // re-derive it — and so `forced` records what was skipped.
    m.review = { state: review.state, ...reviewCounts(review.findings) };
    m.learnings_recorded = learnings_recorded;
    m.state_times = m.state_times || {};
    if (!m.state_times[state]) m.state_times[state] = nowIso();
    // `run finish --state done|shipped` reaches a closing state, so it records
    // the same sign-off `run state` does. Without this the two commands that
    // reach the same state disagreed about whether anyone closed it.
    if (by && CLOSING_STATES.has(state)) m.closed_by = { ...by, ts: nowIso() };
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
    by: by || undefined,
  });
  if (getActiveRun(projectId) === runId) setActiveRun(projectId, null);
  return meta;
}

// The files a run actually touched, reconstructed from its audit trail.
//
// File-tool calls record an absolute path, so those are exact. Bash writes
// record the command text, which we deliberately do NOT try to parse into
// filenames — guessing would produce a list that looks authoritative and is
// wrong. `bash_writes` reports how many such commands ran so the list can be
// read as "these, plus whatever N shell commands did" rather than "these".
export function touchedFiles(projectId, runId, repoRoot = null) {
  const files = new Set();
  let bashWrites = 0;
  // Both sides canonicalized: the audit stores the path the runtime sent, and
  // process.cwd() resolves symlinks, so on macOS (/var -> /private/var) the two
  // spellings never prefix-match and every path stays stubbornly absolute.
  const root = repoRoot ? canonicalPath(repoRoot) : null;
  for (const entry of auditLines(path.join(runDir(projectId, runId), 'audit.jsonl'))) {
    if (entry.event !== 'tool') continue;
    if (WRITE_TOOLS.has(entry.tool)) {
      const summary = String(entry.summary || '');
      if (!summary || !path.isAbsolute(summary)) continue;
      const abs = canonicalPath(summary);
      // Run-folder and project-memory writes are bookkeeping, not the change.
      if (abs.startsWith(canonicalPath(runDir(projectId, runId)) + path.sep)) continue;
      if (abs.startsWith(canonicalPath(projectDir(projectId)) + path.sep)) continue;
      files.add(root && abs.startsWith(root + path.sep) ? abs.slice(root.length + 1) : abs);
    } else if (entry.tool === 'Bash' && /(^|\s)(>|>>|tee\b|sed\s+-\w*i)/.test(String(entry.summary || ''))) {
      bashWrites++;
    }
  }
  return { files: [...files].sort(), bash_writes: bashWrites };
}

// Attach links a run cannot discover for itself. The PR url is the one that
// matters most — it is what turns the console from a status page into a review
// starting point — and nothing can auto-detect it without a network call the
// CLI refuses to make, so the pipeline records it after opening the PR.
export function linkRun(projectId, runId, { pr, ticket, branch } = {}) {
  // Validate everything FIRST. Rejecting inside the mutator still persisted the
  // fields that did validate and then threw, so a bad --pr left a half-applied
  // change on disk with no audit line describing it.
  const updates = {};
  for (const [field, flag, value] of [['pr_url', '--pr', pr], ['ticket_url', '--ticket-url', ticket]]) {
    if (value === undefined || value === null) continue;
    const url = safeUrl(value);
    if (!url) throw new Error(`${flag} must be an http(s) URL`);
    updates[field] = url;
  }
  if (branch) updates.branch = String(branch).slice(0, 200);
  if (!Object.keys(updates).length) throw new Error('Nothing to link.');
  const meta = mutateRunMeta(projectId, runId, (m) => Object.assign(m, updates) && undefined);
  if (!meta) throw new Error(`Unknown run: ${runId}`);
  appendAudit(projectId, { event: 'run-link', run: runId, pr: meta.pr_url || undefined, branch: meta.branch || undefined });
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

// audit.1.jsonl rather than audit.jsonl.1: globbing `*.jsonl` must keep
// finding only live logs.
function auditPath(projectId, runId = null) {
  return path.join(runId ? runDir(projectId, runId) : projectDir(projectId), 'audit.jsonl');
}

// Audit lines go to the active run when one exists, else to the project log —
// session exhaust outside a run is still worth keeping. A run bound to a
// session only accepts that session's lines: a second concurrent session in
// the same repo lands in the project log instead of polluting the run's
// audit trail. Unbound runs (started from a terminal, not via a session)
// keep the old accept-everything behavior.
// Logs rotate to audit.1.jsonl at LOG_ROTATE_BYTES; only the contract-history
// reader (cost.js) aggregates across the boundary — everything else reads the
// current run's recent activity, which the fresh file still holds.
// Every line is hash-chained (see chain.js) so `aos audit verify` can detect
// post-hoc edits; the chain continues across a rotation because it links
// lines, not files.
function rotatedOf(p) {
  return p.replace(/audit\.jsonl$/, 'audit.1.jsonl');
}

export function appendAudit(projectId, entry) {
  const active = getActiveRun(projectId);
  if (active && fs.existsSync(runDir(projectId, active))) {
    const boundSession = runMeta(projectId, active)?.session;
    if (!boundSession || !entry.session || entry.session === boundSession) {
      appendChainedTo(auditPath(projectId, active), rotatedOf(auditPath(projectId, active)), { ts: nowIso(), ...entry });
      return;
    }
  }
  const p = auditPath(projectId);
  appendChainedTo(p, rotatedOf(p), { ts: nowIso(), ...entry });
}

// All of a project's audit ledgers, one report per directory: the project
// log and every run's log, rotated generation first (chronological order —
// the chain links lines, not files, but verification still walks them in
// the order they were written).
export function verifyProjectLedgers(projectId) {
  const out = [];
  const pair = (base, label) => {
    const rotated = base.replace(/audit\.jsonl$/, 'audit.1.jsonl');
    out.push({ label, report: verifyLedger([rotated, base]) });
  };
  pair(path.join(projectDir(projectId), 'audit.jsonl'), 'project ledger');
  for (const r of listRuns(projectId)) {
    pair(path.join(runDir(projectId, r.run), 'audit.jsonl'), `run ${r.run}`);
  }
  return out;
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
