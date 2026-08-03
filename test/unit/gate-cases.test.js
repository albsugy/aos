// The gate's case corpus, run through the real policy engine.
//
// Every row in test/fixtures/gate-cases.json is one assertion. Adding a case
// is a one-line edit there; this file just supplies the fixture world the
// commands are judged against (a repo with a working tree, an AOS_HOME).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-gate-corpus-'));
process.env.AOS_HOME = path.join(WORK, 'aos-home');

const { DEFAULT_POLICY, evaluateCommand, evaluateBashProtected } = await import('../../src/policy.js');

// A working tree for the commands that ask it whether a ref names a file.
const REPO = path.join(WORK, 'repo');
fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
fs.mkdirSync(path.join(REPO, '.claude'), { recursive: true });
fs.mkdirSync(path.join(REPO, '.git', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'src', 'app.js'), '');
fs.writeFileSync(path.join(REPO, 'Makefile'), '');
fs.writeFileSync(path.join(REPO, '.claude', 'settings.json'), '{}');
fs.mkdirSync(path.join(process.env.AOS_HOME, 'projects', 'demo'), { recursive: true });

const fixture = JSON.parse(
  fs.readFileSync(new URL('../fixtures/gate-cases.json', import.meta.url), 'utf8')
);

// {NAME} → the placeholder's parts concatenated (each carries its own spacing,
// so a flag can be split mid-word). Commands are stored in pieces because this
// repo's own hook gates writes containing the literal destructive forms; see
// the fixture's $comment.
const VALUES = {
  ...Object.fromEntries(Object.entries(fixture.placeholders).map(([k, v]) => [k, v.join('')])),
  AOS_HOME: process.env.AOS_HOME,
};
function expand(template) {
  return String(template).replace(/\{([A-Z_]+)\}/g, (whole, name) => {
    if (!(name in VALUES)) throw new Error(`unknown placeholder {${name}} in: ${template}`);
    return VALUES[name];
  });
}

// The same order src/hooks.js applies for a Bash call: the command tiers
// decide first, and only a clean `allow` reaches the protected-path check.
// (The plan and scope gates are stateful — they belong to the smoke suite.)
function decide(command) {
  const verdict = evaluateCommand(DEFAULT_POLICY, command, { cwd: REPO });
  if (verdict.decision !== 'allow') return verdict;
  return evaluateBashProtected(command, { home: process.env.AOS_HOME, cwd: REPO }) || verdict;
}

test('the corpus is well-formed', () => {
  assert.ok(fixture.cases.length >= 100, `expected a real corpus, got ${fixture.cases.length} rows`);
  for (const row of [...fixture.cases, ...fixture.knownLimits]) {
    assert.ok(row.command, 'every row needs a command');
    assert.ok(['allow', 'ask', 'deny'].includes(row.expect), `bad expect: ${row.expect}`);
    assert.ok(row.note && row.note.length > 5, `every row says what it defends: ${row.command}`);
    assert.doesNotThrow(() => expand(row.command), `placeholders resolve: ${row.command}`);
  }
  const seen = new Set();
  for (const row of fixture.cases) {
    const cmd = expand(row.command);
    assert.equal(seen.has(cmd), false, `duplicate case: ${cmd}`);
    seen.add(cmd);
  }
});

for (const row of fixture.cases) {
  test(`gate: ${row.command} → ${row.expect} (${row.note})`, () => {
    const command = expand(row.command);
    assert.equal(decide(command).decision, row.expect, command);
  });
}

// These assert what the gate does NOT catch. A failure here is good news with
// a chore attached: the limit closed, so move the row into `cases` and update
// the docs that describe the boundary.
for (const row of fixture.knownLimits) {
  test(`documented limit: ${row.note}`, () => {
    const command = expand(row.command);
    assert.equal(
      decide(command).decision,
      row.expect,
      `${command}\n\nIf this now returns something stricter, the limit was closed — ` +
        'move the row from knownLimits into cases and update DOCS.md.'
    );
  });
}
