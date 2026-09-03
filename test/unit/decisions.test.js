import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

let home;
before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-decisions-'));
  process.env.AOS_HOME = home;
});
after(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.AOS_HOME;
});

// Imported after AOS_HOME is set — the module resolves paths lazily via
// aosHome(), so this ordering is safe either way, but keep it explicit.
const {
  createPendingDecision,
  approveDecision,
  consumeApproval,
  listPendingDecisions,
  getPendingDecision,
} = await import('../../src/decisions.js');
const { addProject } = await import('../../src/registry.js');

const PROJECT = 'dec-demo';

test('external approval lifecycle: pending → granted → consumed once', () => {
  addProject({ id: PROJECT, name: PROJECT, repo: '/tmp/dec-demo' });
  const d = createPendingDecision(PROJECT, {
    provider: 'codex',
    session: 'thr_1',
    action: 'git-push',
    reason: 'Publishing requires human approval',
    fingerprint: 'fp1',
    tool: 'Bash',
  });
  assert.match(d.id, /^dec_[0-9a-f]+$/);
  assert.ok(getPendingDecision(PROJECT, d.id));

  // not approved yet → nothing to consume
  assert.equal(consumeApproval(PROJECT, 'fp1'), null);

  const granted = approveDecision(PROJECT, d.id, { user: 'human', via: 'tty' });
  assert.equal(granted.ok, true);
  assert.equal(getPendingDecision(PROJECT, d.id), null); // left pending

  // wrong fingerprint does not consume the approval
  assert.equal(consumeApproval(PROJECT, 'other'), null);
  assert.ok(consumeApproval(PROJECT, 'fp1')); // matching op spends it
  assert.equal(consumeApproval(PROJECT, 'fp1'), null); // single use
});

test('approveDecision rejects unknown and malformed ids', () => {
  assert.equal(approveDecision(PROJECT, 'dec_nope').ok, false);
  assert.equal(getPendingDecision(PROJECT, '../evil'), null);
  assert.equal(getPendingDecision(PROJECT, 'dec_../../policy.yaml'), null);
});

test('pending decisions expire', () => {
  const d = createPendingDecision(PROJECT, {
    provider: 'cursor',
    action: 'deploy',
    reason: 'r',
    fingerprint: 'fp2',
  });
  // age it past the pending TTL by rewriting its created timestamp
  const file = path.join(home, 'projects', PROJECT, 'decisions', 'pending', `${d.id}.json`);
  const aged = JSON.parse(fs.readFileSync(file, 'utf8'));
  aged.created = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  fs.writeFileSync(file, JSON.stringify(aged));
  const res = approveDecision(PROJECT, d.id, { user: 'h', via: 'tty' });
  assert.equal(res.ok, false);
  assert.match(res.error, /expired/i);
});

test('listPendingDecisions survives an empty project', () => {
  addProject({ id: 'dec-empty', name: 'e', repo: '/tmp/dec-empty' });
  assert.deepEqual(listPendingDecisions('dec-empty'), []);
});
