// Unit tests for the plan-scope parser and matcher — the gate that asks when a
// write lands outside what the plan declared.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseScope, inScope } from '../../src/scope.js';

test('parseScope: reads the scope section and stops at the next heading', () => {
  const plan = [
    '# Plan',
    '',
    '## Files in scope',
    '- src/gate.js',
    '- src/policy.js',
    '',
    '## Approach',
    '- src/not-declared.js',
  ].join('\n');
  assert.deepEqual(parseScope(plan), ['src/gate.js', 'src/policy.js']);
});

test('parseScope: a plan with no scope section declares nothing', () => {
  assert.deepEqual(parseScope('# Plan\n\n## Approach\n- do the thing'), []);
  assert.deepEqual(parseScope(''), []);
  assert.deepEqual(parseScope(null), []);
});

test('parseScope: entries are deduplicated', () => {
  const plan = '## Files in scope\n- src/a.js\n- src/a.js\n- `src/a.js`\n';
  assert.deepEqual(parseScope(plan), ['src/a.js']);
});

test('inScope: exact file, directory prefix, and glob all match', () => {
  const entries = ['src/gate.js', 'test/', 'docs/**/*.md'];
  assert.equal(inScope('src/gate.js', entries), true, 'exact');
  assert.equal(inScope('test/smoke.sh', entries), true, 'directory prefix');
  assert.equal(inScope('docs/a/b/guide.md', entries), true, 'nested glob');
  assert.equal(inScope('src/other.js', entries), false);
  assert.equal(inScope('testament.md', entries), false, 'a directory prefix is not a string prefix');
});

test('inScope: `/**/` means zero or more directories', () => {
  // The flat form is the half people hit first: declaring src/**/*.test.js and
  // then writing src/a.test.js must not read as drift.
  const entries = ['src/**/*.test.js'];
  assert.equal(inScope('src/a.test.js', entries), true, 'zero directories');
  assert.equal(inScope('src/a/b.test.js', entries), true, 'one directory');
  assert.equal(inScope('src/a/b/c.test.js', entries), true, 'many directories');
  assert.equal(inScope('src/a.js', entries), false);
});

test('inScope: a leading `**/` also matches a root-level file', () => {
  assert.equal(inScope('README.md', ['**/*.md']), true);
  assert.equal(inScope('docs/x.md', ['**/*.md']), true);
});

test('inScope: matching is case-sensitive', () => {
  // A glob matching more loosely than exact and directory matching do would
  // quietly widen the declared scope.
  assert.equal(inScope('SRC/Gate.js', ['src/gate.js']), false);
  assert.equal(inScope('src/GATE.js', ['src/*.js']), true, 'case only matters to the literal parts');
});

test('inScope: a broken glob never takes the gate down', () => {
  assert.doesNotThrow(() => inScope('src/a.js', ['src/[.js']));
  assert.equal(inScope('src/a.js', ['src/[.js']), false);
});

test('inScope: paths normalize before comparison', () => {
  assert.equal(inScope('./src/gate.js', ['src/gate.js']), true);
  assert.equal(inScope('src\\gate.js', ['src/gate.js']), true, 'windows-style separators');
});

test('inScope: an empty plan matches nothing', () => {
  assert.equal(inScope('src/gate.js', []), false);
});
