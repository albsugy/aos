import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeAdapter } from '../../src/adapters/claude.js';
import { codexAdapter } from '../../src/adapters/codex.js';
import { cursorAdapter } from '../../src/adapters/cursor.js';
import { parseApplyPatch, codexFileOperation, operationFingerprint } from '../../src/core/events.js';

// ── adapters translate payloads from the OFFICIAL hook schemas ────────────
// Payload shapes verified against: Claude Code hooks docs, Codex hooks docs
// (developers.openai.com/codex/hooks), Cursor hooks docs (cursor.com/docs).

test('claude: Bash payload → shell event', () => {
  const e = claudeAdapter.toEvent('pre-tool', {
    cwd: '/repo',
    session_id: 's1',
    permission_mode: 'default',
    tool_name: 'Bash',
    tool_input: { command: 'git push origin main' },
  });
  assert.equal(e.provider, 'claude');
  assert.equal(e.event, 'tool.before');
  assert.equal(e.tool.kind, 'shell');
  assert.equal(e.operation.command, 'git push origin main');
  assert.equal(e.session, 's1');
  assert.equal(e.permissionMode, 'default');
});

test('claude: Write payload → file event', () => {
  const e = claudeAdapter.toEvent('pre-tool', {
    cwd: '/repo',
    session_id: 's1',
    tool_name: 'Edit',
    tool_input: { file_path: '/repo/src/a.js', new_string: 'x' },
  });
  assert.equal(e.tool.kind, 'file');
  assert.deepEqual(e.operation.paths, ['/repo/src/a.js']);
  assert.deepEqual(e.operation.contents, ['x']);
});

test('claude: non-gated tools are null pre-tool but audited post-tool', () => {
  const payload = { cwd: '/repo', session_id: 's1', tool_name: 'Grep', tool_input: { pattern: 'x' } };
  assert.equal(claudeAdapter.toEvent('pre-tool', payload), null);
  const after = claudeAdapter.toEvent('post-tool', payload);
  assert.equal(after.event, 'tool.after');
  assert.equal(after.tool.kind, 'other');
  assert.equal(claudeAdapter.summarize(after), 'x');
});

test('claude: responses keep the exact historical shapes', () => {
  assert.equal(claudeAdapter.respond('pre-tool', { effect: 'allow' }), '');
  const ask = JSON.parse(claudeAdapter.respond('pre-tool', { effect: 'require_approval', reason: 'why' }));
  assert.equal(ask.hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(ask.hookSpecificOutput.permissionDecisionReason, '[aos policy] why');
  const deny = JSON.parse(claudeAdapter.respond('pre-tool', { effect: 'deny', reason: 'no' }));
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  const ctx = JSON.parse(claudeAdapter.respond('session-start', { context: 'hello' }));
  assert.equal(ctx.hookSpecificOutput.additionalContext, 'hello');
  const stop = JSON.parse(claudeAdapter.respond('stop', { asks: ['do it'] }));
  assert.equal(stop.decision, 'block');
  assert.equal(claudeAdapter.respond('stop', { asks: [] }), '');
});

test('codex: Bash payload → shell event', () => {
  const e = codexAdapter.toEvent('pre-tool', {
    session_id: 'thr_1',
    cwd: '/repo',
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf /' },
    permission_mode: 'default',
  });
  assert.equal(e.provider, 'codex');
  assert.equal(e.tool.kind, 'shell');
  assert.equal(e.operation.command, 'rm -rf /');
});

test('codex: apply_patch parses into per-path writes', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: src/a.js',
    ' context line',
    '-old',
    '+new content',
    '*** Add File: src/b.sh',
    '+#!/bin/sh',
    '+rm -rf /',
    '*** Delete File: src/old.js',
    '*** End Patch',
  ].join('\n');
  const ops = parseApplyPatch(patch);
  assert.deepEqual(
    ops.map((o) => o.op),
    ['update', 'add', 'delete']
  );
  assert.deepEqual(
    ops.map((o) => o.path),
    ['src/a.js', 'src/b.sh', 'src/old.js']
  );
  assert.equal(ops[1].added.join('\n'), '#!/bin/sh\nrm -rf /');

  const e = codexAdapter.toEvent('pre-tool', {
    session_id: 'thr_1',
    cwd: '/repo',
    tool_name: 'apply_patch',
    tool_input: { command: patch },
  });
  assert.equal(e.tool.kind, 'file');
  assert.deepEqual(e.operation.paths, ['src/a.js', 'src/b.sh', 'src/old.js']);
  // the added content of the script file reaches the content scan
  assert.ok(e.operation.contents[1].includes('rm -rf /'));
});

test('codex: responses follow the documented output contract', () => {
  assert.equal(codexAdapter.respond('pre-tool', { effect: 'allow' }), '');
  const deny = JSON.parse(codexAdapter.respond('pre-tool', { effect: 'deny', reason: 'no' }));
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  const ctx = JSON.parse(codexAdapter.respond('session-start', { context: 'hello' }));
  assert.equal(ctx.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.equal(ctx.hookSpecificOutput.additionalContext, 'hello');
  const stop = JSON.parse(codexAdapter.respond('stop', { asks: ['x'] }));
  assert.equal(stop.continue, false);
  assert.ok(stop.stopReason);
});

test('cursor: Shell and Write payloads normalize', () => {
  const shell = cursorAdapter.toEvent('pre-tool', {
    conversation_id: 'c1',
    workspace_roots: ['/repo'],
    hook_event_name: 'preToolUse',
    tool_name: 'Shell',
    tool_input: { command: 'git push', working_directory: '/repo' },
  });
  assert.equal(shell.provider, 'cursor');
  assert.equal(shell.tool.kind, 'shell');
  assert.equal(shell.session, 'c1');
  assert.equal(shell.cwd, '/repo');

  const write = cursorAdapter.toEvent('pre-tool', {
    conversation_id: 'c1',
    cwd: '/repo',
    tool_name: 'Write',
    tool_input: { file_path: '/repo/x.md', content: 'hi' },
  });
  assert.equal(write.tool.kind, 'file');
  assert.deepEqual(write.operation.paths, ['/repo/x.md']);
});

test('cursor: Delete is a file event, including hook-file targets', () => {
  const del = cursorAdapter.toEvent('pre-tool', {
    conversation_id: 'c1',
    cwd: '/repo',
    tool_name: 'Delete',
    tool_input: { path: '/repo/.cursor/hooks.json' },
  });
  assert.equal(del.tool.kind, 'file');
  assert.equal(del.tool.name, 'Delete');
  assert.deepEqual(del.operation.paths, ['/repo/.cursor/hooks.json']);
});

test('cursor: a mutating file tool with no path still becomes a file event', () => {
  const e = cursorAdapter.toEvent('pre-tool', {
    conversation_id: 'c1',
    cwd: '/repo',
    tool_name: 'Write',
    tool_input: {},
  });
  assert.equal(e.tool.kind, 'file');
  assert.deepEqual(e.operation.paths, []);
});

test('cursor: deny uses the native permission shape; ask fails closed', () => {
  const deny = JSON.parse(cursorAdapter.respond('pre-tool', { effect: 'deny', reason: 'no' }));
  assert.equal(deny.permission, 'deny');
  assert.ok(deny.agent_message);
  const ask = JSON.parse(cursorAdapter.respond('pre-tool', { effect: 'ask', reason: 'r' }));
  assert.equal(ask.permission, 'deny'); // "ask" is not enforced by Cursor preToolUse
  const ctx = JSON.parse(cursorAdapter.respond('session-start', { context: 'hello' }));
  assert.equal(ctx.additional_context, 'hello');
  const stop = JSON.parse(cursorAdapter.respond('stop', { asks: ['x'] }));
  assert.ok(stop.followup_message);
});

// The acceptance criterion from the architecture plan: the same policy
// fixtures run against normalized events from every adapter and agree.
const FIXTURES = [
  { cmd: 'git push origin main', expect: 'ask' },
  { cmd: 'git push --force origin main', expect: 'deny' },
  { cmd: 'rm -rf /', expect: 'deny' },
  { cmd: 'ls -la', expect: 'allow' },
  { cmd: 'git reset --hard', expect: 'ask' },
];

test('policy fixtures agree across every adapter shell event', async () => {
  const { evaluateCommand, DEFAULT_POLICY } = await import('../../src/policy.js');
  const adapters = [claudeAdapter, codexAdapter, cursorAdapter];
  const toolNames = { claude: 'Bash', codex: 'Bash', cursor: 'Shell' };
  for (const fx of FIXTURES) {
    const verdicts = new Set();
    for (const a of adapters) {
      const e = a.toEvent('pre-tool', {
        session_id: 's',
        conversation_id: 's',
        cwd: '/repo',
        tool_name: toolNames[a.id],
        tool_input: { command: fx.cmd },
      });
      const v = evaluateCommand(DEFAULT_POLICY, e.operation.command, { cwd: '/repo' });
      verdicts.add(v.decision);
    }
    assert.deepEqual([...verdicts], [fx.expect], `${fx.cmd} must evaluate identically everywhere`);
  }
});

test('operation fingerprints: stable per operation, distinct across operations', () => {
  const a = codexAdapter.toEvent('pre-tool', {
    session_id: 's',
    cwd: '/r',
    tool_name: 'Bash',
    tool_input: { command: 'deploy --prod' },
  });
  const b = cursorAdapter.toEvent('pre-tool', {
    conversation_id: 'other-session',
    cwd: '/r/elsewhere',
    tool_name: 'Shell',
    tool_input: { command: 'deploy --prod' },
  });
  const c = codexAdapter.toEvent('pre-tool', {
    session_id: 's',
    cwd: '/r',
    tool_name: 'Bash',
    tool_input: { command: 'deploy --staging' },
  });
  assert.equal(operationFingerprint(a), operationFingerprint(b)); // same op, any agent/session
  assert.notEqual(operationFingerprint(a), operationFingerprint(c));
  const write = cursorAdapter.toEvent('pre-tool', {
    conversation_id: 'c1',
    cwd: '/repo',
    tool_name: 'Write',
    tool_input: { file_path: '/repo/.cursor/hooks.json', content: 'x' },
  });
  const del = cursorAdapter.toEvent('pre-tool', {
    conversation_id: 'c1',
    cwd: '/repo',
    tool_name: 'Delete',
    tool_input: { path: '/repo/.cursor/hooks.json' },
  });
  assert.notEqual(operationFingerprint(write), operationFingerprint(del), 'Write approval must not unlock Delete');
});

test('apply_patch: malformed or empty patches are inert', () => {
  assert.deepEqual(parseApplyPatch(''), []);
  assert.deepEqual(parseApplyPatch('just some text\nwith lines'), []);
  assert.equal(codexAdapter.toEvent('pre-tool', {
    tool_name: 'apply_patch',
    tool_input: { command: 'nothing here' },
    cwd: '/r',
    session_id: 's',
  }), null);
});

test('a file event with no path is denied, not skipped', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-empty-path-'));
  process.env.AOS_HOME = dir;
  const repo = path.join(dir, 'repo');
  fs.mkdirSync(repo);
  const { addProject } = await import('../../src/registry.js');
  const { handleToolBefore } = await import('../../src/core/pipeline.js');
  addProject({ id: 'empty-path', name: 'empty-path', repo });
  const e = cursorAdapter.toEvent('pre-tool', {
    conversation_id: 'c1',
    cwd: repo,
    tool_name: 'Write',
    tool_input: {},
  });
  const d = handleToolBefore(e, cursorAdapter);
  assert.equal(d.effect, 'deny');
  fs.rmSync(dir, { recursive: true, force: true });
});
