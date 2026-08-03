// Unit tests for cost estimation. The claim these defend: AOS counts what it
// cannot price rather than guessing at it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costOf, fmtUsd } from '../../src/pricing.js';

const M = 1_000_000;

test('costOf: prices a known family at its list rate', () => {
  // claude-sonnet-*: $3/M input, $15/M output.
  const { usd, unpriced } = costOf({ 'claude-sonnet-4-6': { input: M, output: M } });
  assert.equal(unpriced, 0);
  assert.ok(Math.abs(usd - 18) < 1e-9, `expected $18, got ${usd}`);
});

test('costOf: cache reads are a tenth of the input rate', () => {
  const { usd } = costOf({ 'claude-sonnet-4-6': { cache_read: M } });
  assert.ok(Math.abs(usd - 0.3) < 1e-9, `expected $0.30, got ${usd}`);
});

test('costOf: cache writes carry their multipliers (1.25x and 2x)', () => {
  const five = costOf({ 'claude-sonnet-4-6': { cache_write_5m: M } }).usd;
  const hour = costOf({ 'claude-sonnet-4-6': { cache_write_1h: M } }).usd;
  assert.ok(Math.abs(five - 3.75) < 1e-9, `5m write: expected $3.75, got ${five}`);
  assert.ok(Math.abs(hour - 6) < 1e-9, `1h write: expected $6, got ${hour}`);
});

test('costOf: specific rules win over family globs', () => {
  // Opus 4.1 kept the legacy $15/$75; the family rule is $5/$25.
  const legacy = costOf({ 'claude-opus-4-1-20250805': { input: M } }).usd;
  const current = costOf({ 'claude-opus-4-5': { input: M } }).usd;
  assert.equal(legacy, 15);
  assert.equal(current, 5);
});

test('costOf: an unpriced model is counted, never guessed at', () => {
  const { usd, unpriced } = costOf({ 'some-other-vendor-model': { input: 500, output: 500 } });
  assert.equal(usd, null, 'no invented dollar figure');
  assert.equal(unpriced, 1000, 'the tokens are still reported');
});

test('costOf: priced and unpriced models coexist in one report', () => {
  const { usd, unpriced } = costOf({
    'claude-sonnet-4-6': { input: M },
    'mystery-model': { output: 42 },
  });
  assert.equal(usd, 3);
  assert.equal(unpriced, 42);
});

test('costOf: no buckets means no claim', () => {
  assert.deepEqual(costOf({}), { usd: null, unpriced: 0 });
  assert.deepEqual(costOf(null), { usd: null, unpriced: 0 });
  assert.deepEqual(costOf('nonsense'), { usd: null, unpriced: 0 });
});

test('fmtUsd: small amounts do not round to zero', () => {
  assert.equal(fmtUsd(0.004), '<$0.01', 'rounding to $0.00 reads as free');
  assert.equal(fmtUsd(0), '$0.00', 'genuinely zero is zero');
  assert.equal(fmtUsd(1.239), '$1.24');
  assert.equal(fmtUsd(1234.5), '$1235', 'cents are noise at this scale');
  assert.equal(fmtUsd(null), null, 'unknown stays unknown');
  assert.equal(fmtUsd(undefined), null);
});
