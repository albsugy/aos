// Executable findings: the review schema's reproduce bar and the gate's
// `unproven` state. Execution itself (real subprocesses) is exercised by the
// smoke suite; here we pin the validation and the state machine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-execfind-'));
process.env.AOS_HOME = path.join(WORK, 'aos-home');

const { validateReview, reviewState, BLOCKING_REVIEW_STATES } = await import('../../src/review.js');
const { writeJson, ensureDir } = await import('../../src/paths.js');

const PROJECT = 'demo';
const RUN = 'r1';
const RUN_DIR = path.join(process.env.AOS_HOME, 'projects', PROJECT, 'runs', RUN);
ensureDir(RUN_DIR);

const baseReview = {
  reviewer: 'skeptic subagent',
  scope: ['src/a.js', 'npm test'],
  findings: [
    {
      severity: 'high',
      summary: 'the gate never fires on the shell path',
      location: 'src/gate.js:12',
      status: 'fixed',
      resolution: 'extended the check to Bash redirects and tee',
      reproduce: 'npm test -- gate',
    },
  ],
};

function writeReview(obj) {
  writeJson(path.join(RUN_DIR, 'review.json'), obj);
}
function writePolicy(verification) {
  writeJson(path.join(process.env.AOS_HOME, 'projects', PROJECT, 'policy.yaml'), null); // placeholder, unused
  fs.writeFileSync(
    path.join(process.env.AOS_HOME, 'projects', PROJECT, 'policy.yaml'),
    `verification:\n${verification
      .map((l) => '  ' + l)
      .join('\n')}\n`
  );
}

test('executable mode demands reproduce on demonstrable high findings', () => {
  const { findings, errors } = validateReview(
    { ...baseReview, findings: [{ ...baseReview.findings[0], reproduce: undefined }] },
    { executable: true }
  );
  assert.ok(errors.some((e) => e.includes('findings[0].reproduce')), 'missing reproduce is an error');
  assert.equal(findings[0].reproduce, null);
});

test('executable mode leaves dismissed/deferred and lower severities alone', () => {
  const { errors } = validateReview(
    {
      ...baseReview,
      findings: [
        { ...baseReview.findings[0], status: 'dismissed', resolution: 'a judgment call, documented here', reproduce: undefined },
        { severity: 'medium', summary: 'a smaller thing, noted in passing', status: 'fixed', resolution: 'documented elsewhere', reproduce: undefined },
      ],
    },
    { executable: true }
  );
  assert.equal(errors.length, 0);
});

test('off by default: no reproduce demanded, no unproven state', () => {
  writePolicy(['adversarial_review: true']);
  writeReview({ ...baseReview, findings: [{ ...baseReview.findings[0], reproduce: undefined }] });
  const r = reviewState(PROJECT, RUN);
  assert.equal(r.state, 'resolved');
  assert.equal(r.executable, false);
  assert.equal(BLOCKING_REVIEW_STATES.has('unproven'), true);
});

test('unproven: valid review, required execution missing', () => {
  writePolicy(['adversarial_review: true', 'executable_findings: true']);
  writeReview(baseReview);
  const r = reviewState(PROJECT, RUN);
  assert.equal(r.state, 'unproven');
  assert.ok(r.errors.some((e) => e.includes('no recorded execution')));
});

test('unproven: execution recorded but not passing', () => {
  writeReview({ ...baseReview, executions: [{ finding: 0, status: 'fixed', expected: 'fixed', exit: 1, pass: false }] });
  const r = reviewState(PROJECT, RUN);
  assert.equal(r.state, 'unproven');
  assert.ok(r.errors.some((e) => e.includes('did not demonstrate')));
});

test('unproven: execution recorded under a stale status', () => {
  // The finding was `open` when executed (command failed — correct then), but
  // is `fixed` now: the recorded execution no longer demonstrates the claim.
  writeReview({ ...baseReview, executions: [{ finding: 0, status: 'open', expected: 'open', exit: 1, pass: true }] });
  const r = reviewState(PROJECT, RUN);
  assert.equal(r.state, 'unproven');
  assert.ok(r.errors.some((e) => e.includes('status')));
});

test('resolved: passing execution for the required finding', () => {
  writeReview({ ...baseReview, executions: [{ finding: 0, status: 'fixed', expected: 'fixed', exit: 0, pass: true }] });
  const r = reviewState(PROJECT, RUN);
  assert.equal(r.state, 'resolved');
});
