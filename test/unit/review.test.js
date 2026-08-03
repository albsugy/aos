// Unit tests for the adversarial review schema. The gate is only as good as
// its refusal messages, so the error text is asserted too.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateReview, reviewCounts, BLOCKING_REVIEW_STATES } from '../../src/review.js';

const clean = {
  reviewer: 'skeptic subagent',
  scope: ['src/gate.js', 'acceptance criteria'],
  findings: [],
};

const errText = (r) => r.errors.join('\n');

test('validateReview: a genuine hunt that found nothing is valid', () => {
  const r = validateReview(clean);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.findings, []);
});

test('validateReview: the review must say who reviewed and what was examined', () => {
  assert.match(errText(validateReview({ ...clean, reviewer: '' })), /reviewer: required/);
  assert.match(errText(validateReview({ ...clean, scope: [] })), /scope: required/);
  assert.match(errText(validateReview({ ...clean, scope: ['', '  '] })), /scope: required/,
    'blank strings are not a scope');
});

test('validateReview: findings must be an array', () => {
  const r = validateReview({ ...clean, findings: 'none' });
  assert.match(errText(r), /findings: required/);
  assert.deepEqual(r.findings, [], 'nothing is salvaged from a malformed list');
});

test('validateReview: non-object input is rejected outright', () => {
  assert.match(errText(validateReview(null)), /must be a JSON object/);
  assert.match(errText(validateReview([])), /must be a JSON object/);
  assert.match(errText(validateReview('review')), /must be a JSON object/);
});

test('validateReview: severity and status come from fixed vocabularies', () => {
  const r = validateReview({
    ...clean,
    findings: [{ severity: 'catastrophic', status: 'maybe', summary: 'the gate leaks' }],
  });
  assert.match(errText(r), /findings\[0\]\.severity: must be one of/);
  assert.match(errText(r), /findings\[0\]\.status: must be one of/);
});

test('validateReview: every status but `open` owes a resolution', () => {
  const withStatus = (status, resolution) =>
    validateReview({
      ...clean,
      findings: [{ severity: 'high', status, summary: 'the gate leaks on wrappers', resolution }],
    });
  assert.match(errText(withStatus('dismissed', '')), /resolution: required for status "dismissed"/);
  assert.match(errText(withStatus('fixed', '')), /resolution: required for status "fixed"/);
  assert.deepEqual(withStatus('open', '').errors, [], 'open is the state that blocks — it needs no prose');
  assert.deepEqual(withStatus('dismissed', 'not reachable from the pipeline').errors, []);
});

test('validateReview: a finding must state the defect', () => {
  const r = validateReview({
    ...clean,
    findings: [{ severity: 'low', status: 'open', summary: 'x' }],
  });
  assert.match(errText(r), /summary: required/);
});

test('validateReview: severity and status are normalized, location is optional', () => {
  const r = validateReview({
    ...clean,
    findings: [{ severity: 'HIGH', status: 'Open', summary: 'wrappers slip past the gate' }],
  });
  assert.deepEqual(r.errors, []);
  assert.equal(r.findings[0].severity, 'high');
  assert.equal(r.findings[0].status, 'open');
  assert.equal(r.findings[0].location, null, 'a missing location is null, not undefined');
});

test('validateReview: errors are per-field, so a bad review is actionable', () => {
  const r = validateReview({ reviewer: '', scope: [], findings: [{}] });
  assert.ok(r.errors.length >= 4, `expected one error per problem, got: ${errText(r)}`);
});

test('reviewCounts: reports only the statuses actually present', () => {
  const counts = reviewCounts([
    { status: 'fixed' },
    { status: 'fixed' },
    { status: 'dismissed' },
  ]);
  assert.equal(counts.total, 3);
  assert.equal(counts.fixed, 2);
  assert.equal(counts.dismissed, 1);
  assert.equal('open' in counts, false, 'a zero count is noise');
});

test('BLOCKING_REVIEW_STATES: only a clean review lets a run finish', () => {
  for (const s of ['absent', 'invalid', 'open']) assert.ok(BLOCKING_REVIEW_STATES.has(s), s);
  assert.equal(BLOCKING_REVIEW_STATES.has('clean'), false);
});
