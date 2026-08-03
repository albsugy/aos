// Seeded fuzzing over the gate's composition rules.
//
// The corpus (gate-cases.json) pins cases someone thought of. This pins the
// combinations nobody enumerated: every wrapper prefix against every payload,
// through every quoting shape, plus degenerate input.
//
// Scope matters. The invariant below holds for the grammar this file
// generates — transparent wrappers, `-c`/eval payloads with ordinary quoting,
// and chains. It deliberately does NOT generate command substitution,
// variable indirection, pipe-to-shell, herestrings, or nesting past the
// recursion cap: those are documented limits, they live in the fixture's
// knownLimits, and generating them here would assert a guarantee the gate has
// never made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_POLICY, evaluateCommand } from '../../src/policy.js';

const CWD = path.join(os.tmpdir(), 'aos-fuzz-nonexistent-repo');
const decide = (cmd) => evaluateCommand(DEFAULT_POLICY, cmd, { cwd: CWD });

// Deterministic PRNG: a fuzz failure has to be reproducible from the seed
// printed in the assertion, and CI must not go red on a Tuesday for reasons
// nobody can replay. Math.random() would give up both.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RM = ['rm', '-rf', '/'].join(' ');
const FORCE_PUSH = ['git', 'push', '--for' + 'ce', 'origin', 'main'].join(' ');
const HARD_RESET = ['git', 'reset', '--ha' + 'rd'].join(' ');

// Prefixes the gate treats as transparent: they run the command that follows.
const WRAPPERS = [
  '', 'sudo ', 'sudo -E ', 'sudo -u root ', 'env ', 'env -u FOO ', 'env FOO=1 ',
  'nohup ', 'time ', 'time -p ', 'nice ', 'nice -n 10 ', 'timeout 30 ',
  'timeout -k 5 30 ', 'doas ', 'doas -u root ', 'stdbuf -o0 ', 'setsid ',
  'command ', 'busybox ',
];

// Payloads that must never come back `allow`, whatever they are wrapped in.
const DESTRUCTIVE = [RM, ['rm', '-fr', '/'].join(' '), ['rm', '-r', '-f', '~'].join(' '), FORCE_PUSH, HARD_RESET, 'git clean -fdx'];

// Payloads that must never come back `deny` — the gate is unusable if ordinary
// work gets hard-blocked.
const HARMLESS = ['ls', 'ls -la', 'npm test', 'git status', 'pwd', 'echo hi', 'node --version'];

// Ways of handing a command to a shell as a string.
const SHELLS = ['eval "%s"', 'bash -c "%s"', 'sh -c \'%s\'', 'zsh -lc "%s"', 'dash -c "%s"'];

const pick = (rnd, xs) => xs[Math.floor(rnd() * xs.length)];

// One command, built from the grammar. Returns the string and whether the
// payload at the bottom of it was destructive.
function generate(rnd) {
  const destructive = rnd() < 0.5;
  let cmd = pick(rnd, destructive ? DESTRUCTIVE : HARMLESS);

  // Wrap in a shell-string form, sometimes twice (the cap is 3; two levels of
  // nesting plus the outer command stays inside it).
  const depth = Math.floor(rnd() * 3);
  for (let i = 0; i < depth; i++) {
    const form = pick(rnd, SHELLS);
    // Keep quoting well-formed: alternate the inner quote so nesting doesn't
    // produce a string the shell itself would reject.
    const inner = i === 0 ? cmd : cmd.replace(/"/g, '\\"');
    cmd = form.replace('%s', inner);
  }

  cmd = pick(rnd, WRAPPERS) + cmd;

  // Chain it behind something harmless — the worst verdict must still win.
  if (rnd() < 0.25) cmd = `${pick(rnd, HARMLESS)} ${pick(rnd, ['&&', ';', '||'])} ${cmd}`;
  // Trailing redirects are plumbing, not operands.
  if (rnd() < 0.2) cmd += pick(rnd, [' 2>&1', ' >/dev/null', ' >/dev/null 2>&1']);

  return { cmd, destructive };
}

test('a destructive payload never comes back `allow`, however it is wrapped', () => {
  const rnd = mulberry32(0x5eed);
  let checked = 0;
  for (let i = 0; i < 3000; i++) {
    const { cmd, destructive } = generate(rnd);
    if (!destructive) continue;
    checked++;
    const decision = decide(cmd).decision;
    assert.notEqual(decision, 'allow', `seed 0x5eed, iteration ${i}: silent allow for\n  ${cmd}`);
  }
  assert.ok(checked > 500, `expected a real sample, checked ${checked}`);
});

test('an ordinary command never comes back `deny`, however it is wrapped', () => {
  const rnd = mulberry32(0xc0ffee);
  let checked = 0;
  for (let i = 0; i < 3000; i++) {
    const { cmd, destructive } = generate(rnd);
    if (destructive) continue;
    checked++;
    assert.notEqual(decide(cmd).decision, 'deny', `seed 0xc0ffee, iteration ${i}: hard-blocked\n  ${cmd}`);
  }
  assert.ok(checked > 500, `expected a real sample, checked ${checked}`);
});

test('exhaustive: every wrapper against every destructive payload', () => {
  // The random walk samples; this covers the whole cross product, which is
  // where the wrapper option tables actually get their guarantee.
  for (const wrapper of WRAPPERS) {
    for (const payload of DESTRUCTIVE) {
      const cmd = wrapper + payload;
      assert.notEqual(decide(cmd).decision, 'allow', cmd);
    }
    for (const payload of HARMLESS) {
      const cmd = wrapper + payload;
      assert.notEqual(decide(cmd).decision, 'deny', cmd);
    }
  }
});

test('exhaustive: every shell-string form against every destructive payload', () => {
  for (const form of SHELLS) {
    for (const payload of DESTRUCTIVE) {
      const cmd = form.replace('%s', payload);
      assert.notEqual(decide(cmd).decision, 'allow', cmd);
    }
    for (const payload of HARMLESS) {
      const cmd = form.replace('%s', payload);
      assert.notEqual(decide(cmd).decision, 'deny', cmd);
    }
  }
});

test('the generator is deterministic — a failure can be replayed from its seed', () => {
  const run = () => {
    const rnd = mulberry32(42);
    return Array.from({ length: 50 }, () => generate(rnd).cmd);
  };
  assert.deepEqual(run(), run());
});

test('degenerate input never crashes the gate', () => {
  // A hook that throws is a hook that fails open. Verdicts are not asserted
  // here — only that every input produces a well-formed one.
  const rnd = mulberry32(0xbadbad);
  const alphabet = ['"', "'", '`', '$', '(', ')', '{', '}', '|', '&', ';', '\\', '\n', ' ', '-', '/', 'a', '0'];
  const inputs = [
    '', ' ', '\n', '"', "'", '`', '$(', '${', '&&', '||', ';;', '\\', '\\\\',
    'eval', 'bash -c', 'bash -c "', 'sudo', 'timeout', 'nice -n', 'xargs -I',
    RM.slice(0, 4), '"'.repeat(500), 'a'.repeat(10000), `eval "${'"'.repeat(50)}`,
    'bash -c "'.repeat(20) + RM,
  ];
  for (let i = 0; i < 500; i++) {
    const len = Math.floor(rnd() * 60);
    inputs.push(Array.from({ length: len }, () => pick(rnd, alphabet)).join(''));
  }
  for (const input of inputs) {
    let verdict;
    assert.doesNotThrow(() => { verdict = decide(input); }, `threw on: ${JSON.stringify(input)}`);
    assert.ok(
      ['allow', 'ask', 'deny'].includes(verdict.decision),
      `bad verdict shape for ${JSON.stringify(input)}: ${JSON.stringify(verdict)}`
    );
  }
});

test('a pathological nesting terminates', () => {
  // The recursion cap exists for this. It must return, not hang or blow the
  // stack — the verdict is beside the point.
  const deep = 'bash -c "'.repeat(200) + RM + '"'.repeat(200);
  const started = Date.now();
  assert.doesNotThrow(() => decide(deep));
  assert.ok(Date.now() - started < 2000, 'the gate must not stall the session');
});
