// Policy CI: the replay engine over a fixture ledger. The full CLI surface
// (`aos policy test`) is exercised by the smoke suite; here we pin the
// semantics — what counts as history, how recorded decisions map to replay
// rows, and the truncated-command honesty.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-policytest-'));
process.env.AOS_HOME = path.join(WORK, 'aos-home');

const { collectBashHistory, replayPolicy } = await import('../../src/policy-test.js');
const { loadPolicyText } = await import('../../src/policy.js');

const PROJECT = 'demo';
const PROJ_DIR = path.join(process.env.AOS_HOME, 'projects', PROJECT);
fs.mkdirSync(PROJ_DIR, { recursive: true });

function seedAudit(lines) {
  fs.writeFileSync(
    path.join(PROJ_DIR, 'audit.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  );
}

const now = new Date().toISOString();
const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
const yearAgo = new Date(Date.now() - 365 * 86_400_000).toISOString();

test('history = Bash tool calls + gate decisions, with recorded verdicts', () => {
  seedAudit([
    { ts: now, event: 'tool', tool: 'Bash', summary: 'git push origin main', session: 's1' },
    { ts: now, event: 'tool', tool: 'Bash', summary: 'npm test', session: 's1' },
    { ts: now, event: 'tool', tool: 'Bash', summary: 'git push origin main', session: 's1' }, // repeat
    { ts: now, event: 'gate', decision: 'deny', action: 'push-force', tool: 'Bash', command: 'git push --force', session: 's1' },
    { ts: now, event: 'tool', tool: 'Edit', summary: '/abs/path/src/a.js', session: 's1' }, // not Bash
    { ts: now, event: 'tool', tool: 'Bash', summary: 'ls', session: 's1', source: 'ingested' },
  ]);
  const h = collectBashHistory(PROJECT);
  assert.equal(h.scanned, 5, 'five Bash rows (Edit excluded)');
  assert.equal(h.unique.length, 4, 'the repeated push collapses to one unique');
  const push = h.unique.find((r) => r.command === 'git push origin main');
  assert.equal(push.count, 2);
  assert.equal(push.recorded, 'allow');
  const forced = h.unique.find((r) => r.command === 'git push --force');
  assert.equal(forced.recorded, 'deny', 'gate decisions carry through');
  const ingested = h.unique.find((r) => r.command === 'ls');
  assert.equal(ingested.source, 'ingested');
});

test('--since filters old traffic out', () => {
  seedAudit([
    { ts: yearAgo, event: 'tool', tool: 'Bash', summary: 'git push origin main' },
    { ts: hourAgo, event: 'tool', tool: 'Bash', summary: 'npm test' },
  ]);
  const h = collectBashHistory(PROJECT, Date.now() - 86_400_000);
  assert.equal(h.scanned, 1);
  assert.equal(h.unique[0].command, 'npm test');
});

test('replay: a candidate forbidding push would deny traffic that ran freely', () => {
  seedAudit([{ ts: now, event: 'tool', tool: 'Bash', summary: 'git push origin main' }]);
  const candidate = loadPolicyText(`
tiers:
  forbidden:
    - pattern: '\\bgit\\s+push\\b'
      reason: no direct pushes in this fixture
`);
  const r = replayPolicy(PROJECT, candidate, WORK);
  assert.equal(r.wouldDeny.length, 1);
  assert.match(r.wouldDeny[0].reason, /no direct pushes/);
  assert.equal(r.wouldUnblock.length, 0);
});

test('replay: loosening a policy surfaces what it would unblock', () => {
  // `deploy` is gated by a default RULE (no structural twin), so a candidate
  // with the gated tier emptied genuinely unblocks it. (`git push` would not:
  // the structural push check gates it regardless of the rule list.)
  seedAudit([{ ts: now, event: 'gate', decision: 'ask', action: 'deploy', tool: 'Bash', command: 'deploy --prod' }]);
  const candidate = loadPolicyText('tiers:\n  gated: []\n');
  const r = replayPolicy(PROJECT, candidate, WORK);
  assert.equal(r.wouldUnblock.length, 1);
  assert.equal(r.wouldUnblock[0].was, 'ask');
  assert.equal(r.wouldDeny.length, 0);
  assert.equal(r.wouldAsk.length, 0);
});

test('replay: tightening ask→deny is its own bucket, not "unchanged"', () => {
  // A command the old policy gated (and the human approved) that the
  // candidate forbids outright: a real change someone tightening a policy
  // must see.
  seedAudit([{ ts: now, event: 'gate', decision: 'ask', action: 'deploy', tool: 'Bash', command: 'deploy --prod' }]);
  const candidate = loadPolicyText(`tiers:
  forbidden:
    - pattern: '\\bdeploy\\b'
      reason: deploys are frozen this week
`);
  const r = replayPolicy(PROJECT, candidate, WORK);
  assert.equal(r.wouldTighten.length, 1);
  assert.equal(r.wouldTighten[0].was, 'ask');
  assert.equal(r.wouldDeny.length, 0, 'gated-before must not double-count as ran-freely');
  assert.equal(r.unchanged, 0, 'a tightening is not unchanged');
});

test('truncated commands are counted, never silently treated as clean', () => {
  const longTail = 'echo ' + 'a'.repeat(400);
  seedAudit([{ ts: now, event: 'tool', tool: 'Bash', summary: longTail.slice(0, 300) }]);
  const r = replayPolicy(PROJECT, loadPolicyText(''), WORK);
  assert.equal(r.truncated, 1);
  // The row is still evaluated — as recorded, which is the truncated form.
  assert.equal(r.unique.length, 1);
});
