// Unit tests for in-session sign-off tickets. The property under test: an
// approval is for a specific thing, once, recently — or it is not an approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-signoff-'));

const { recordSignoffTicket, consumeSignoffTicket } = await import('../../src/signoff.js');
const { projectDir } = await import('../../src/paths.js');

const PROJECT = 'demo';
const ticketFile = () => path.join(projectDir(PROJECT), 'signoff.json');
fs.mkdirSync(projectDir(PROJECT), { recursive: true });

const mint = (command, action = 'run-close') =>
  recordSignoffTicket(PROJECT, { action, command, session: 's1', mode: 'default' });

test('a minted ticket is spendable for the action it was shown for', () => {
  mint('aos run state done --run 2026-08-03-alpha');
  const ticket = consumeSignoffTicket(PROJECT, 'run-close', '2026-08-03-alpha');
  assert.ok(ticket, 'the approval the human gave should be honoured');
  assert.equal(ticket.mode, 'default', 'the permission mode the prompt ran under is recorded');
});

test('a ticket is single-use', () => {
  mint('aos run state done --run 2026-08-03-alpha');
  assert.ok(consumeSignoffTicket(PROJECT, 'run-close', '2026-08-03-alpha'));
  assert.equal(consumeSignoffTicket(PROJECT, 'run-close', '2026-08-03-alpha'), null,
    'the same approval must not close a second run');
});

test('a ticket is bound to the run it was shown for', () => {
  // A prompt shown for run A authorized closing run B for five minutes.
  mint('aos run state done --run alpha');
  assert.equal(consumeSignoffTicket(PROJECT, 'run-close', 'beta'), null);
});

test('both --run spellings are read', () => {
  mint('aos run state done --run=alpha');
  assert.equal(consumeSignoffTicket(PROJECT, 'run-close', 'beta'), null, '--run=X binds too');
  mint('aos run state done --run=alpha');
  assert.ok(consumeSignoffTicket(PROJECT, 'run-close', 'alpha'));
});

test('a ticket naming no run is unbound and matches the active run', () => {
  mint('aos run state done');
  assert.ok(consumeSignoffTicket(PROJECT, 'run-close', 'whatever-is-active'));
});

test('a mismatched ticket is still spent, not left lying around', () => {
  // Otherwise a rejected approval sits there until it happens to match — the
  // flaky-test shape that surfaced this rule in the first place.
  mint('aos run state done --run alpha');
  assert.equal(consumeSignoffTicket(PROJECT, 'run-close', 'beta'), null);
  assert.equal(fs.existsSync(ticketFile()), false);
  assert.equal(consumeSignoffTicket(PROJECT, 'run-close', 'alpha'), null, 'nothing left to spend');
});

test('a ticket for a different action is refused', () => {
  mint('aos run approve', 'plan-approve');
  assert.equal(consumeSignoffTicket(PROJECT, 'run-close', 'alpha'), null);
});

test('an expired ticket is refused', () => {
  mint('aos run state done --run alpha');
  const stale = JSON.parse(fs.readFileSync(ticketFile(), 'utf8'));
  stale.ts = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  fs.writeFileSync(ticketFile(), JSON.stringify(stale));
  assert.equal(consumeSignoffTicket(PROJECT, 'run-close', 'alpha'), null, 'approvals cannot be banked');
});

test('a ticket dated in the future is refused', () => {
  mint('aos run state done --run alpha');
  const skewed = JSON.parse(fs.readFileSync(ticketFile(), 'utf8'));
  skewed.ts = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  fs.writeFileSync(ticketFile(), JSON.stringify(skewed));
  assert.equal(consumeSignoffTicket(PROJECT, 'run-close', 'alpha'), null);
});

test('a corrupt or absent ticket is simply no approval', () => {
  fs.rmSync(ticketFile(), { force: true });
  assert.equal(consumeSignoffTicket(PROJECT, 'run-close', 'alpha'), null);
  fs.writeFileSync(ticketFile(), '{not json');
  assert.equal(consumeSignoffTicket(PROJECT, 'run-close', 'alpha'), null);
});

test('mustInclude binds a ticket to the operand the prompt named', () => {
  mint('aos approve dec_aaa', 'aos-approve');
  assert.equal(consumeSignoffTicket(PROJECT, 'aos-approve', null, 'dec_bbb'), null, 'other id cannot spend it');
  mint('aos approve dec_aaa', 'aos-approve');
  assert.ok(consumeSignoffTicket(PROJECT, 'aos-approve', null, 'dec_aaa'));
});

test('the recorded command is bounded', () => {
  mint('aos run state done --run alpha # ' + 'x'.repeat(1000));
  const ticket = JSON.parse(fs.readFileSync(ticketFile(), 'utf8'));
  assert.ok(ticket.command.length <= 300, 'a ticket is not a place to store arbitrary input');
});
