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

const { appendChainedTo, verifyLedger, chainStateFromFile, buildChainedLine, GENESIS } = await import('../../src/chain.js');

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
