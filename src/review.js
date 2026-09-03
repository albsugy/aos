import path from 'node:path';
import { projectDir, readIfExists, readJson } from './paths.js';
import { loadPolicy } from './policy.js';

// The adversarial review as a structured record, not prose: runs/<id>/review.json.
//
// The old check (a heading matching /adversarial|skeptic|refut/ in
// verification.md, plus 20 characters of body) was evidence-of-process a model
// satisfied by writing the heading. This is still not proof the review was any
// GOOD — nothing short of another reviewer can be — but it moves the bar from
// "a heading exists" to "explicit claims, each with a disposition", and it
// makes the one thing that IS mechanically checkable a hard gate: a run cannot
// reach awaiting-review with an unresolved finding in it.
//
// Paths are built from projectDir (not run.js's runDir) to keep this module
// free of a cycle: run.js imports review.js, never the reverse.
export const REVIEW_FILE = 'review.json';
// Machine-written by `aos run review` — never trusted from review.json, which
// is agent-authored. A fake `executions` array in the review file is the cheap
// lie this sidecar exists to stop.
export const EXECUTIONS_FILE = 'executions.json';

const SEVERITIES = ['high', 'medium', 'low'];
const STATUSES = ['open', 'fixed', 'dismissed', 'deferred'];
// Long enough that "ok", "n/a" and "fixed" don't pass as a disposition, short
// enough not to invite padding.
const MIN_TEXT = 12;
// Statuses whose claim a reproduce command can actually demonstrate: `open`
// says the bug exists (the command must FAIL), `fixed` says it no longer does
// (the command must PASS). `dismissed`/`deferred` are judgements, not
// executable claims — demanding a command for them would just invite noise.
export const DEMONSTRABLE_STATUSES = ['open', 'fixed'];

export function reviewPath(projectId, runId) {
  return path.join(projectDir(projectId), 'runs', runId, REVIEW_FILE);
}

export function executionsPath(projectId, runId) {
  return path.join(projectDir(projectId), 'runs', runId, EXECUTIONS_FILE);
}

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// Returns { errors, findings }. Every error is phrased as an instruction: the
// gate prints them verbatim, so they have to be enough to fix the file by.
//
// `executable` turns on the executable-findings bar (policy
// verification.executable_findings): every DEMONSTRABLE high-severity finding
// must carry a `reproduce` command. Presence is validated here; whether the
// command actually demonstrates the claim is checked by executeReview and
// enforced by the gate as the `unproven` state.
export function validateReview(parsed, { executable = false } = {}) {
  const errors = [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { errors: ['review.json must be a JSON object'], findings: [] };
  }
  if (text(parsed.reviewer).length < 3) {
    errors.push('reviewer: required — who or what performed the review (e.g. "skeptic subagent")');
  }
  const scope = Array.isArray(parsed.scope) ? parsed.scope.filter((s) => text(s)) : [];
  if (!scope.length) {
    errors.push('scope: required — a non-empty list of what was actually examined (files, criteria, commands)');
  }
  if (!Array.isArray(parsed.findings)) {
    errors.push('findings: required — an array (use [] only when a genuine hunt found nothing)');
    return { errors, findings: [] };
  }
  const findings = [];
  parsed.findings.forEach((f, i) => {
    const at = `findings[${i}]`;
    if (!f || typeof f !== 'object' || Array.isArray(f)) {
      errors.push(`${at}: must be an object`);
      return;
    }
    const severity = text(f.severity).toLowerCase();
    const status = text(f.status).toLowerCase();
    const summary = text(f.summary);
    const resolution = text(f.resolution);
    const reproduce = text(f.reproduce) || null;
    if (!SEVERITIES.includes(severity)) errors.push(`${at}.severity: must be one of ${SEVERITIES.join(' | ')}`);
    if (summary.length < MIN_TEXT) errors.push(`${at}.summary: required — state the defect in one sentence`);
    if (!STATUSES.includes(status)) errors.push(`${at}.status: must be one of ${STATUSES.join(' | ')}`);
    // `open` is the one status that needs no resolution — it is the state that
    // blocks the gate, so demanding prose for it would just invite closing it.
    if (STATUSES.includes(status) && status !== 'open' && resolution.length < MIN_TEXT) {
      errors.push(`${at}.resolution: required for status "${status}" — what you did, or why it does not apply`);
    }
    if (reproduce && reproduce.length < 2) {
      errors.push(`${at}.reproduce: must be a real command, not a token`);
    }
    if (
      executable &&
      severity === 'high' &&
      DEMONSTRABLE_STATUSES.includes(status) &&
      !reproduce
    ) {
      errors.push(
        `${at}.reproduce: required for a ${status} high-severity finding (executable_findings is on) — ` +
          `a command that FAILS while the bug is present and PASSES once it is fixed`
      );
    }
    findings.push({ severity, status, summary, resolution, location: text(f.location) || null, reproduce });
  });
  return { errors, findings };
}

export function reviewCounts(findings) {
  const counts = { total: findings.length };
  for (const s of STATUSES) {
    const n = findings.filter((f) => f.status === s).length;
    if (n) counts[s] = n;
  }
  return counts;
}

// gate | warn | off — `adversarial_review: warn` keeps the pre-0.11 behavior
// (record the state, never block) for projects that want the bookkeeping
// without the gate.
export function reviewMode(projectId) {
  return reviewModeFromPolicy(loadPolicy(projectId));
}

function reviewModeFromPolicy(policy) {
  const setting = policy.verification?.adversarial_review;
  if (setting === false) return 'off';
  if (String(setting).toLowerCase() === 'warn') return 'warn';
  return 'gate';
}

export function executableFindingsFromPolicy(policy) {
  return policy.verification?.executable_findings === true;
}

// States that stop a run from finishing (when mode is `gate`).
export const BLOCKING_REVIEW_STATES = new Set(['absent', 'invalid', 'open', 'unproven']);

// absent   — no review.json
// invalid  — present but malformed (see .errors)
// open     — valid, but findings are still unresolved (see .open)
// unproven — valid, but executable_findings is on and a demonstrable
//            high-severity finding has no passing execution recorded
//            (see executeReview in verify.js — the review gate and `aos run
//            review` live on opposite sides of the run.js import cycle, so
//            the runner is documented here and lives there)
// clean    — valid, a genuine hunt that found nothing
// resolved — valid, every finding has a disposition
export function reviewState(projectId, runId) {
  const policy = loadPolicy(projectId);
  const mode = reviewModeFromPolicy(policy);
  const executable = executableFindingsFromPolicy(policy);
  if (mode === 'off') return { mode, state: 'not-required', errors: [], open: [], findings: [], executable };
  const raw = readIfExists(reviewPath(projectId, runId));
  if (!raw || !raw.trim()) return { mode, state: 'absent', errors: [], open: [], findings: [], executable };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { mode, state: 'invalid', errors: [`review.json is not valid JSON — ${e.message}`], open: [], findings: [], executable };
  }
  const { errors, findings } = validateReview(parsed, { executable });
  if (errors.length) return { mode, state: 'invalid', errors, open: [], findings, executable };
  const open = findings.filter((f) => f.status === 'open');
  let state = open.length ? 'open' : findings.length ? 'resolved' : 'clean';
  // Optional `reproduce` is documentation until the policy flag is on — a
  // copied review.json must not flip a project that never opted in to unproven.
  if (executable && state !== 'open') {
    const problems = executionProblems(projectId, runId, findings);
    if (problems.length) {
      return { mode, state: 'unproven', errors: problems, open, findings, executable };
    }
  }
  return { mode, state, errors: [], open, findings, executable };
}

// Which required executions are missing or failing. Proof lives in the
// AOS-written sidecar, not in review.json — `pass: true` in an agent-authored
// file is not evidence. An execution records `finding` (the findings[] index
// it demonstrates), `pass` (did the command's exit status match the status'
// expectation), and `expected` — the expectation at execution time, so a
// finding whose status changed since (fixed → reopened) reads as unproven
// rather than silently inherited.
function executionProblems(projectId, runId, findings) {
  const recorded = readJson(executionsPath(projectId, runId), null);
  const executions = Array.isArray(recorded?.executions) ? recorded.executions : [];
  const problems = [];
  findings.forEach((f, i) => {
    if (f.severity !== 'high' || !DEMONSTRABLE_STATUSES.includes(f.status) || !f.reproduce) return;
    const exec = executions.find((e) => e && e.finding === i);
    if (!exec) {
      problems.push(
        `findings[${i}] (high, ${f.status}): no recorded execution — run \`aos run review\` so its reproduce command is actually run`
      );
      return;
    }
    if (exec.expected !== f.status) {
      problems.push(
        `findings[${i}]: execution recorded for status "${exec.expected}" but the finding is now "${f.status}" — re-run \`aos run review\``
      );
      return;
    }
    if (exec.pass !== true) {
      problems.push(
        `findings[${i}] (${f.status}): the reproduce command did not demonstrate it — ` +
          `expected ${f.status === 'open' ? 'a non-zero exit (the bug reproducing)' : 'exit 0 (the fix holding)'}, got exit ${JSON.stringify(exec.exit)}`
      );
    }
  });
  return problems;
}

// One line per problem, ready to print. Kept next to the validator so the gate
// message and the `aos run review` output can never drift apart.
export function reviewProblemLines(review, reviewFile) {
  if (review.state === 'absent') {
    return [
      `No adversarial review recorded — ${reviewFile} does not exist.`,
      '',
      'Spawn a skeptic subagent (see /aos-verify), then record what it found:',
      '',
      '  {',
      '    "reviewer": "skeptic subagent",',
      '    "scope": ["src/foo.js", "acceptance criterion 2", "npm test"],',
      '    "findings": [',
      '      {',
      '        "severity": "high|medium|low",',
      '        "summary": "one sentence stating the defect",',
      '        "location": "src/foo.js:42",',
      '        "status": "fixed|dismissed|deferred|open",',
      '        "resolution": "what you did, or why it does not apply",',
      '        "reproduce": "npm test -- --run src/foo.test.js  (required for high open/fixed when executable_findings is on)"',
      '      }',
      '    ]',
      '  }',
      '',
      'An empty "findings": [] is a legitimate result — but "scope" must still say what was hunted through.',
    ];
  }
  if (review.state === 'invalid') {
    return [`${reviewFile} is not a usable review:`, '', ...review.errors.map((e) => `  • ${e}`)];
  }
  if (review.state === 'unproven') {
    return [
      `${reviewFile} records findings whose claims have not been demonstrated (review state: unproven):`,
      '',
      ...review.errors.map((e) => `  • ${e}`),
      '',
      'Executable findings are on (verification.executable_findings) — every demonstrable',
      'high-severity finding must have its reproduce command actually run, with the exit',
      'status matching its status: open → the command fails, fixed → the command passes.',
      'Run `aos run review` to execute them, or set executable_findings: false to drop the bar.',
    ];
  }
  if (review.state === 'open') {
    return [
      `${review.open.length} adversarial finding(s) still open — resolve them or mark them deferred with a reason:`,
      '',
      ...review.open.map((f) => `  • [${f.severity}] ${f.summary}${f.location ? ` (${f.location})` : ''}`),
    ];
  }
  return [];
}
