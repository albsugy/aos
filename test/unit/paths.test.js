// Unit tests for the storage primitives every other module builds on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  slugify,
  tailLines,
  canonicalPath,
  readJson,
  writeJson,
  appendLine,
  appendLineRotated,
  withLock,
  LOG_ROTATE_BYTES,
} from '../../src/paths.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aos-unit-'));

test('slugify: collapses to a safe run id', () => {
  assert.equal(slugify('LIN-482 Fix the gate!'), 'lin-482-fix-the-gate');
  assert.equal(slugify('  ---  '), 'run', 'an all-punctuation title still needs an id');
  assert.equal(slugify(''), 'run');
  assert.ok(slugify('x'.repeat(200)).length <= 60, 'run ids are capped');
});

test('tailLines: keeps the END of the window, not the start', () => {
  // Memory sections append newest-at-bottom, so a tail that kept the head
  // would silently drop exactly the newest entries.
  const text = ['one', 'two', 'three', 'four'].join('\n');
  assert.equal(tailLines(text, 2), 'three\nfour');
  assert.equal(tailLines(text, 99), text, 'asking for more lines than exist is not an error');
  assert.equal(tailLines('solo\n\n\n', 1), 'solo', 'trailing blank lines are not content');
});

test('canonicalPath: resolves symlinks, survives paths that do not exist yet', () => {
  const dir = tmp();
  const real = path.join(dir, 'real');
  fs.mkdirSync(real);
  const link = path.join(dir, 'link');
  fs.symlinkSync(real, link);
  assert.equal(canonicalPath(link), fs.realpathSync(real), 'a symlinked dir resolves to its target');
  assert.equal(
    canonicalPath(path.join(link, 'not', 'created', 'yet.txt')),
    path.join(fs.realpathSync(real), 'not', 'created', 'yet.txt'),
    'the existing prefix resolves and the missing tail is preserved'
  );
});

test('readJson: a corrupt file yields the fallback rather than throwing', () => {
  const dir = tmp();
  const p = path.join(dir, 'meta.json');
  assert.deepEqual(readJson(p, { fallback: true }), { fallback: true }, 'missing file');
  fs.writeFileSync(p, '{not json');
  assert.deepEqual(readJson(p, { fallback: true }), { fallback: true }, 'unparseable file');
  writeJson(p, { real: 1 });
  assert.deepEqual(readJson(p, null), { real: 1 });
});

test('appendLineRotated: rolls one generation past the threshold', () => {
  const dir = tmp();
  const p = path.join(dir, 'sessions.jsonl');
  const rotated = p + '.1';

  appendLine(p, 'first');
  appendLineRotated(p, 'second');
  assert.equal(fs.existsSync(rotated), false, 'a small log does not rotate');
  assert.equal(fs.readFileSync(p, 'utf8'), 'first\nsecond\n');

  // Sparse file: the threshold is on size, so there is no need to write 10MB.
  fs.truncateSync(p, LOG_ROTATE_BYTES + 1);
  appendLineRotated(p, 'third');
  assert.ok(fs.existsSync(rotated), 'past the threshold the log rolls aside');
  assert.equal(fs.readFileSync(p, 'utf8'), 'third\n', 'the live log starts fresh');
  assert.match(fs.readFileSync(rotated, 'utf8'), /^first\nsecond\n/, 'the old generation is intact');

  // One generation only — a second rotation overwrites the first, which is the
  // difference between a bound and unbounded growth wearing a rotation costume.
  fs.truncateSync(p, LOG_ROTATE_BYTES + 1);
  appendLineRotated(p, 'fourth');
  assert.equal(fs.readdirSync(dir).filter((f) => f.startsWith('sessions.jsonl')).length, 2);
  assert.equal(fs.readFileSync(p, 'utf8'), 'fourth\n');
});

test('appendLineRotated: an un-rotatable log still gets its line', () => {
  // Enforcing the bound is never worth losing an audit line.
  const dir = tmp();
  const p = path.join(dir, 'audit.jsonl');
  fs.writeFileSync(p, '');
  fs.truncateSync(p, LOG_ROTATE_BYTES + 1);
  appendLineRotated(p, 'kept', path.join(dir, 'no', 'such', 'dir', 'audit.1.jsonl'));
  assert.match(fs.readFileSync(p, 'utf8'), /kept\n$/);
});

test('withLock: returns the value and releases for the next caller', () => {
  const dir = tmp();
  const p = path.join(dir, 'state.json');
  assert.equal(withLock(p, () => 'a'), 'a');
  assert.equal(withLock(p, () => 'b'), 'b', 'the lock is not held after the callback returns');
});

test('withLock: a throwing callback still releases the lock', () => {
  const dir = tmp();
  const p = path.join(dir, 'state.json');
  assert.throws(() => withLock(p, () => { throw new Error('boom'); }), /boom/);
  assert.equal(withLock(p, () => 'after'), 'after');
});
