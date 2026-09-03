// The audit chain: append → verify round-trip, tamper detection, rotation,
// and legacy tolerance. Pure file-level tests against a temp ledger — the
// full CLI surface (`aos audit verify`) is exercised by the smoke suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-chain-'));
process.env.AOS_HOME = path.join(WORK, 'aos-home');

const { appendChainedTo, verifyLedger, chainStateFromFile, buildChainedLine, lastLineOf, GENESIS } = await import('../../src/chain.js');

const LEDGER = path.join(WORK, 'audit.jsonl');
const ROTATED = LEDGER.replace(/audit\.jsonl$/, 'audit.1.jsonl');
const append = (entry) => appendChainedTo(LEDGER, ROTATED, entry);

test('an empty ledger verifies with zero lines', () => {
  const r = verifyLedger([LEDGER]);
  assert.equal(r.ok, true);
  assert.equal(r.lines, 0);
});

test('appended lines verify, and the chain state advances', () => {
  append({ ts: '2026-01-01T00:00:00Z', event: 'tool', tool: 'Bash', summary: 'ls' });
  append({ ts: '2026-01-01T00:00:01Z', event: 'gate', decision: 'ask', command: 'git push' });
  const state = chainStateFromFile(LEDGER);
  assert.equal(state.seq, 1, 'two lines → seq 1');
  const r = verifyLedger([LEDGER]);
  assert.equal(r.ok, true);
  assert.equal(r.chained, 2);
  assert.equal(r.legacy, 0);
});

test('editing a line after it was written is detected', () => {
  const lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
  const parsed = JSON.parse(lines[0]);
  parsed.summary = 'rm -rf / (rewritten)';
  lines[0] = JSON.stringify(parsed);
  fs.writeFileSync(LEDGER, lines.join('\n') + '\n');
  const r = verifyLedger([LEDGER]);
  assert.equal(r.ok, false);
  assert.match(r.problems[0].issue, /hash mismatch/);
});

test('deleting a middle line is detected (seq gap)', () => {
  append({ ts: '2026-01-01T00:00:02Z', event: 'tool', tool: 'Edit', summary: 'a.js' });
  append({ ts: '2026-01-01T00:00:03Z', event: 'tool', tool: 'Edit', summary: 'b.js' });
  const lines = fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);
  lines.splice(1, 1); // remove a middle line
  fs.writeFileSync(LEDGER, lines.join('\n') + '\n');
  const r = verifyLedger([LEDGER]);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /seq/.test(p.issue)), JSON.stringify(r.problems));
});

test('a pre-chain (legacy) prefix is tolerated, not failed', () => {
  const fresh = path.join(WORK, 'legacy', 'audit.jsonl');
  fs.mkdirSync(path.dirname(fresh), { recursive: true });
  fs.writeFileSync(fresh, JSON.stringify({ ts: '2025-01-01T00:00:00Z', event: 'tool', tool: 'Bash', summary: 'old' }) + '\n');
  appendChainedTo(fresh, fresh + '.rot', { ts: '2026-01-01T00:00:00Z', event: 'run-start', run: 'r1' });
  const r = verifyLedger([fresh]);
  assert.equal(r.ok, true);
  assert.equal(r.legacy, 1);
  assert.equal(r.chained, 1);
});

test('an unchained line AFTER the chain started is flagged', () => {
  const fresh = path.join(WORK, 'mixed', 'audit.jsonl');
  fs.mkdirSync(path.dirname(fresh), { recursive: true });
  appendChainedTo(fresh, fresh + '.rot', { ts: '2026-01-01T00:00:00Z', event: 'run-start' });
  fs.appendFileSync(fresh, JSON.stringify({ ts: '2026-01-01T00:00:01Z', event: 'tool', injected: true }) + '\n');
  const r = verifyLedger([fresh]);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /unchained/.test(p.issue)));
});

test('rotation continues the chain across files', () => {
  const dir = path.join(WORK, 'rot');
  fs.mkdirSync(dir, { recursive: true });
  const cur = path.join(dir, 'audit.jsonl');
  const rot = path.join(dir, 'audit.1.jsonl');
  appendChainedTo(cur, rot, { ts: '2026-01-01T00:00:00Z', event: 'run-start' });
  // Simulate a rotation: move current → rotated, then keep appending.
  fs.renameSync(cur, rot);
  appendChainedTo(cur, rot, { ts: '2026-01-01T00:00:01Z', event: 'run-state', state: 'done' });
  const r = verifyLedger([rot, cur]);
  assert.equal(r.ok, true);
  assert.equal(r.chained, 2);
});

test('deleting trailing chained lines is detected via the head file', () => {
  const dir = path.join(WORK, 'tail');
  fs.mkdirSync(dir, { recursive: true });
  const cur = path.join(dir, 'audit.jsonl');
  const rot = path.join(dir, 'audit.1.jsonl');
  appendChainedTo(cur, rot, { ts: '2026-01-01T00:00:00Z', event: 'run-start' });
  appendChainedTo(cur, rot, { ts: '2026-01-01T00:00:01Z', event: 'tool', tool: 'Bash', summary: 'ls' });
  appendChainedTo(cur, rot, { ts: '2026-01-01T00:00:02Z', event: 'tool', tool: 'Edit', summary: 'a.js' });
  const lines = fs.readFileSync(cur, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(cur, lines.slice(0, 1).join('\n') + '\n');
  const r = verifyLedger([cur]);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /head|trailing/i.test(p.issue)), JSON.stringify(r.problems));
});

test('lastLineOf does not treat a mid-file fragment as the last line', () => {
  const p = path.join(WORK, 'longline.jsonl');
  const first = JSON.stringify({ a: 1, pad: 'x'.repeat(9000) });
  const second = JSON.stringify({ a: 2, ok: true });
  fs.writeFileSync(p, first + '\n' + second + '\n');
  assert.equal(lastLineOf(p), second);
  const noNl = path.join(WORK, 'nonl.jsonl');
  fs.writeFileSync(noNl, 'y'.repeat(70_000));
  assert.equal(lastLineOf(noNl), null);
});

test('the genesis line hashes deterministically', () => {
  const { line, state } = buildChainedLine(null, { a: 1 });
  const parsed = JSON.parse(line);
  assert.equal(parsed.chain.seq, 0);
  assert.equal(state.hash, parsed.chain.hash);
  // The same payload under the same prev always hashes the same — this is
  // what makes verification reproducible.
  const again = buildChainedLine(null, { a: 1 });
  assert.equal(again.state.hash, state.hash);
  assert.notEqual(GENESIS, state.hash);
});

test('a non-object entry is wrapped, never string-spread', () => {
  // The easy mistake: passing a pre-stringified JSON string to appendChainedTo.
  // Spreading it produced {"0":"{","1":"\""...} — a line that verifies fine and
  // carries no payload. The guard wraps instead; the smoke suite asserts the
  // receipt's actual content, this pins the mechanism.
  const dir = path.join(WORK, 'guard');
  fs.mkdirSync(dir, { recursive: true });
  const ledger = path.join(dir, 'audit.jsonl');
  appendChainedTo(ledger, ledger + '.rot', JSON.stringify({ id: 'gone', purged: false }));
  const parsed = JSON.parse(fs.readFileSync(ledger, 'utf8'));
  assert.equal(parsed.value, '{"id":"gone","purged":false}');
  assert.ok(!('0' in parsed), 'no numeric-keys mangling');
  assert.ok(parsed.chain);
});
