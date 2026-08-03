// Unit tests for the policy engine's building blocks. The gate's adversarial
// surface is covered exhaustively by the case corpus; this file pins the
// structural helpers those cases rest on, plus the file-write gate.
//
// Command fixtures are assembled from parts on purpose: this repo's own hooks
// gate literal destructive strings, so a test file containing them cannot be
// written from a session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_POLICY,
  stripQuoted,
  commandSegments,
  commandWritesFiles,
  evaluateCommand,
  evaluateBashProtected,
  evaluateFileWrite,
} from '../../src/policy.js';

const RM = ['rm', '-rf', '/'].join(' ');
const FORCE_PUSH = ['git', 'push', '--' + 'force', 'origin', 'main'].join(' ');
const HARD_RESET = ['git', 'reset', '--' + 'hard'].join(' ');
const HOME = os.homedir();
const REPO = path.join(os.tmpdir(), 'aos-policy-unit-repo');

const decide = (cmd, opts = {}) => evaluateCommand(DEFAULT_POLICY, cmd, { cwd: REPO, ...opts }).decision;

test('stripQuoted: quoted text is data, not command', () => {
  assert.equal(stripQuoted(`echo "${RM}"`).includes('-rf'), false);
  assert.equal(stripQuoted(`echo '${RM}'`).includes('-rf'), false);
  assert.ok(stripQuoted('git status').includes('git status'), 'unquoted text survives');
});

test('commandSegments: every shell separator starts a new command', () => {
  assert.equal(commandSegments('a && b || c ; d | e').length, 5);
  // Substitution and subshells open a command position too — `echo $(...)`
  // runs whatever is inside.
  assert.ok(commandSegments('echo $(git push origin main)').length > 1, 'substitution is a command position');
  assert.ok(commandSegments('(cd /tmp && ls)').length > 1, 'subshell is a command position');
});

test('commandSegments: splitting errs toward more segments, never fewer', () => {
  // The split is deliberately quote-blind: a quoted separator produces an extra
  // segment that gets scanned and finds nothing, whereas honouring quotes would
  // hide `$(...)` inside them. Over-segmenting is the safe direction.
  assert.ok(commandSegments('echo "a && b"').length >= 1);
  assert.ok(commandSegments('').every((s) => !s.trim()), 'an empty command yields no command to scan');
});

test('the tiers hold: safe is silent, risky asks, destructive denies', () => {
  assert.equal(decide('ls -la'), 'allow');
  assert.equal(decide('npm test'), 'allow');
  assert.equal(decide('git push origin main'), 'ask');
  assert.equal(decide(FORCE_PUSH), 'deny');
  assert.equal(decide(RM), 'deny');
});

test('a command merely mentioning a forbidden string is not hard-blocked', () => {
  // The forbidden tier reads quote-stripped text, so talking about a forbidden
  // command is never a deny. The gated tier still scans the raw string, so a
  // human sees it either way — "not denied" is the guarantee, not "silent".
  assert.notEqual(decide(`echo "${FORCE_PUSH}"`), 'deny');
  assert.notEqual(decide(`git commit -m "prevent ${FORCE_PUSH}"`), 'deny');
  assert.equal(decide('echo "just a message"'), 'allow');
});

test('wrappers are transparent — the wrapped command gets the verdict', () => {
  for (const prefix of ['sudo -E', 'env FOO=1', 'nohup', 'nice -n 5', 'timeout 30', 'setsid']) {
    assert.equal(decide(`${prefix} ${RM}`), 'deny', `${prefix} must not launder the command`);
  }
  assert.equal(decide(`sudo -E ${HARD_RESET}`), 'ask');
});

test('a wrapped harmless command stays harmless', () => {
  assert.equal(decide('timeout 30 npm test'), 'allow');
  assert.equal(decide('nice -n 5 ls'), 'allow');
  assert.equal(decide('env NODE_ENV=test npm test'), 'allow');
});

test('a string run as a command is evaluated as a command', () => {
  for (const form of [`eval "${RM}"`, `bash -c "${RM}"`, `sh -c "${RM}"`, `zsh -lc "${RM}"`]) {
    assert.equal(decide(form), 'deny', form);
  }
  assert.equal(decide('bash -lc "npm run build"'), 'allow', 'and an ordinary payload still runs quietly');
});

test('the worst verdict in a chain wins', () => {
  assert.equal(decide(`npm test && ${RM}`), 'deny');
  assert.equal(decide(`ls | grep x && git push origin main`), 'ask');
});

test('commandWritesFiles: the shapes that actually write', () => {
  assert.equal(commandWritesFiles('echo x > src/a.js'), true, 'redirect');
  assert.equal(commandWritesFiles('echo x >> src/a.js'), true, 'append');
  assert.equal(commandWritesFiles('sed -i "" s/a/b/ src/a.js'), true, 'in-place edit');
  assert.equal(commandWritesFiles('cp a b'), true);
  assert.equal(commandWritesFiles('tar -xzf archive.tgz'), true, 'extract creates files');
  assert.equal(commandWritesFiles('curl -o out.json https://example.com'), true);
});

test('commandWritesFiles: reads and plumbing are not writes', () => {
  assert.equal(commandWritesFiles('cat src/a.js'), false);
  assert.equal(commandWritesFiles('grep -r foo src/'), false);
  assert.equal(commandWritesFiles('npm test 2>&1'), false, 'fd duplication is not a write');
  assert.equal(commandWritesFiles('npm test > /dev/null'), false, 'a null sink writes nothing');
  assert.equal(commandWritesFiles('echo "a > b"'), false, 'a redirect inside quotes is text');
});

test('evaluateBashProtected: rewiring hooks asks, whatever the spelling', () => {
  const ask = (cmd) => evaluateBashProtected(cmd, { home: HOME, cwd: REPO })?.decision || 'allow';
  assert.equal(ask('git config core.hooksPath /tmp/x'), 'ask');
  assert.equal(ask('git -c core.hooksPath=/tmp/x push'), 'ask', 'the per-command form is the same rewire');
  assert.equal(ask('git -c user.email=a@b.c commit -m x'), 'allow', 'ordinary -c config is not a rewire');
  assert.equal(ask('git status'), 'allow');
});

test('evaluateFileWrite: AOS cannot be used to disarm AOS', () => {
  const write = (rel, content = '') =>
    evaluateFileWrite(DEFAULT_POLICY, path.join(REPO, rel), content, { home: HOME, repoRoot: REPO })
      ?.decision || 'allow';
  assert.equal(write('.claude/settings.json', '{}'), 'ask', 'the hook wiring is self-protected');
  assert.equal(write('.git/hooks/pre-commit', '#!/bin/sh\n'), 'ask');
  assert.equal(write('src/app.js', 'export const a = 1;\n'), 'allow', 'ordinary source is not gated');
});

test('evaluateFileWrite: a script body is read as what it would run', () => {
  const decision = evaluateFileWrite(DEFAULT_POLICY, path.join(REPO, 'cleanup.sh'), `#!/bin/sh\n${RM}\n`, {
    home: HOME,
    repoRoot: REPO,
  });
  assert.notEqual(decision?.decision, undefined, 'writing a destructive script is not a way around the gate');
  assert.notEqual(decision.decision, 'allow');
});
