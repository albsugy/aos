import path from 'node:path';
import { projectDir, readIfExists } from './paths.js';
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

const SEVERITIES = ['high', 'medium', 'low'];
const STATUSES = ['open', 'fixed', 'dismissed', 'deferred'];
// Long enough that "ok", "n/a" and "fixed" don't pass as a disposition, short
// enough not to invite padding.
const MIN_TEXT = 12;

export function reviewPath(projectId, runId) {
  return path.join(projectDir(projectId), 'runs', runId, REVIEW_FILE);
}

function text(v) {
  return typeof v === 'string' ? v.trim() : '';
}

// Returns { errors, findings }. Every error is phrased as an instruction: the
// gate prints them verbatim, so they have to be enough to fix the file by.
export function validateReview(parsed) {
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
    if (!SEVERITIES.includes(severity)) errors.push(`${at}.severity: must be one of ${SEVERITIES.join(' | ')}`);
    if (summary.length < MIN_TEXT) errors.push(`${at}.summary: required — state the defect in one sentence`);
    if (!STATUSES.includes(status)) errors.push(`${at}.status: must be one of ${STATUSES.join(' | ')}`);
    // `open` is the one status that needs no resolution — it is the state that
    // blocks the gate, so demanding prose for it would just invite closing it.
    if (STATUSES.includes(status) && status !== 'open' && resolution.length < MIN_TEXT) {
      errors.push(`${at}.resolution: required for status "${status}" — what you did, or why it does not apply`);
    }
    findings.push({ severity, status, summary, resolution, location: text(f.location) || null });
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
  const setting = loadPolicy(projectId).verification?.adversarial_review;
  if (setting === false) return 'off';
  if (String(setting).toLowerCase() === 'warn') return 'warn';
  return 'gate';
}

// States that stop a run from finishing (when mode is `gate`).
export const BLOCKING_REVIEW_STATES = new Set(['absent', 'invalid', 'open']);

// absent   — no review.json
// invalid  — present but malformed (see .errors)
// open     — valid, but findings are still unresolved (see .open)
// clean    — valid, a genuine hunt that found nothing
// resolved — valid, every finding has a disposition
export function reviewState(projectId, runId) {
  const mode = reviewMode(projectId);
  if (mode === 'off') return { mode, state: 'not-required', errors: [], open: [], findings: [] };
  const raw = readIfExists(reviewPath(projectId, runId));
  if (!raw || !raw.trim()) return { mode, state: 'absent', errors: [], open: [], findings: [] };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { mode, state: 'invalid', errors: [`review.json is not valid JSON — ${e.message}`], open: [], findings: [] };
  }
  const { errors, findings } = validateReview(parsed);
  if (errors.length) return { mode, state: 'invalid', errors, open: [], findings };
  const open = findings.filter((f) => f.status === 'open');
  const state = open.length ? 'open' : findings.length ? 'resolved' : 'clean';
  return { mode, state, errors: [], open, findings };
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
      '        "resolution": "what you did, or why it does not apply"',
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
  if (review.state === 'open') {
    return [
      `${review.open.length} adversarial finding(s) still open — resolve them or mark them deferred with a reason:`,
      '',
      ...review.open.map((f) => `  • [${f.severity}] ${f.summary}${f.location ? ` (${f.location})` : ''}`),
    ];
  }
  return [];
}
