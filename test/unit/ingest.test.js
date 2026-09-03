// Transcript ingest: the parser and the idempotent ingest loop against a
// synthetic Claude Code session file shaped like the real ones (assistant
// entries carrying tool_use blocks and cumulative usage, cwd/sessionId on
// entries). The CLI surface (`aos ingest`) is exercised by the smoke suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-ingest-'));
process.env.AOS_HOME = path.join(WORK, 'aos-home');
process.env.CLAUDE_CONFIG_DIR = path.join(WORK, 'claude');

const { parseTranscript, ingestTranscripts, discoverSessionFiles } = await import('../../src/ingest.js');
const { addProject } = await import('../../src/registry.js');

const REPO = path.join(WORK, 'repo');
fs.mkdirSync(REPO, { recursive: true });

const SESSION_DIR = path.join(WORK, 'claude', 'projects', '-fixture-repo');
fs.mkdirSync(SESSION_DIR, { recursive: true });
const SESSION_FILE = path.join(SESSION_DIR, 'sess-1.jsonl');

// A minimal but faithful transcript: sidechain flag, timestamps, tool_use,
// cumulative usage, and cwd on entries — the fields ingest reads.
const transcriptLines = [
  JSON.stringify({ type: 'mode', sessionId: 'sess-1', cwd: REPO, timestamp: '2026-08-01T10:00:00Z' }),
  JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    cwd: REPO,
    timestamp: '2026-08-01T10:00:01Z',
    message: {
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 7 },
      content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
        { type: 'tool_use', name: 'Edit', input: { file_path: path.join(REPO, 'src/a.js') } },
      ],
    },
  }),
  JSON.stringify({
    type: 'assistant',
    isSidechain: true,
    cwd: REPO,
    timestamp: '2026-08-01T10:00:02Z',
    message: {
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 50 },
      content: [{ type: 'tool_use', name: 'Bash', input: { command: 'grep -r TODO src' } }],
    },
  }),
];

test('the parser extracts session id, cwd, tool calls, and line watermark', () => {
  fs.writeFileSync(SESSION_FILE, transcriptLines.join('\n') + '\n');
  const parsed = parseTranscript(SESSION_FILE);
  assert.equal(parsed.sessionId, 'sess-1');
  assert.deepEqual([...parsed.cwds], [REPO]);
  assert.equal(parsed.lines, 3);
  assert.equal(parsed.toolCalls.length, 3);
  assert.equal(parsed.toolCalls[0].tool, 'Bash');
  assert.equal(parsed.toolCalls[0].summary, 'npm test');
  assert.equal(parsed.toolCalls[0].ts, '2026-08-01T10:00:01Z');
  assert.equal(parsed.toolCalls[2].summary, 'grep -r TODO src', 'sidechain calls are activity too');
});

test('a registered repo ingests: chained audit lines + a session token line', () => {
  addProject({ id: 'demo', name: 'demo', repo: REPO });
  const result = ingestTranscripts({ onlyProjectId: 'demo' });
  const report = result.projects.find((r) => r.project === 'demo');
  assert.ok(report, 'project matched by transcript cwd');
  assert.equal(report.sessionsNew, 1);
  assert.equal(report.toolCalls, 3);

  const audit = fs.readFileSync(path.join(process.env.AOS_HOME, 'projects', 'demo', 'audit.jsonl'), 'utf8');
  const lines = audit.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l) => l.source === 'ingested' && l.session === 'sess-1'));
  assert.ok(lines.every((l) => l.chain && Number.isInteger(l.chain.seq)), 'ingested lines are chained');
  assert.equal(lines[0].summary, 'npm test');
  assert.equal(lines[0].ts, '2026-08-01T10:00:01Z', 'original transcript timestamps preserved');

  const sessions = fs.readFileSync(path.join(process.env.AOS_HOME, 'projects', 'demo', 'sessions.jsonl'), 'utf8');
  const s = JSON.parse(sessions.split('\n').filter(Boolean)[0]);
  assert.equal(s.session, 'sess-1');
  assert.equal(s.source, 'ingested');
  // 10+7+3 input+cache-create, 5+2 output, 100+50 cache-read — the same
  // arithmetic the SessionEnd hook performs on the same fields.
  assert.equal(s.input_tokens, 20);
  assert.equal(s.output_tokens, 7);
  assert.equal(s.cache_read_tokens, 150);
});

test('re-ingest is a no-op until the file grows; a delta ingests only new lines', () => {
  const auditBefore = fs.readFileSync(path.join(process.env.AOS_HOME, 'projects', 'demo', 'audit.jsonl'), 'utf8');
  const again = ingestTranscripts({ onlyProjectId: 'demo' });
  assert.equal(again.projects.length, 0, 'unchanged file → nothing to do');

  fs.appendFileSync(
    SESSION_FILE,
    JSON.stringify({
      type: 'assistant',
      isSidechain: false,
      cwd: REPO,
      timestamp: '2026-08-01T11:00:00Z',
      message: {
        model: 'claude-sonnet-4-6',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
        content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } }],
      },
    }) + '\n'
  );
  const delta = ingestTranscripts({ onlyProjectId: 'demo' });
  const report = delta.projects.find((r) => r.project === 'demo');
  assert.equal(report.sessionsDelta, 1);
  assert.equal(report.toolCalls, 1, 'only the appended row');

  const auditAfter = fs.readFileSync(path.join(process.env.AOS_HOME, 'projects', 'demo', 'audit.jsonl'), 'utf8');
  const newLines = auditAfter
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((l) => l.summary === 'npm run build');
  assert.equal(newLines.length, 1, 'no duplicates of the old lines');
  assert.ok(auditAfter.length > auditBefore.length);
});

test('a file that shrank is skipped with a warning, never double-counted', () => {
  const before = fs.readFileSync(path.join(process.env.AOS_HOME, 'projects', 'demo', 'audit.jsonl'), 'utf8');
  fs.writeFileSync(SESSION_FILE, transcriptLines.slice(0, 2).join('\n') + '\n'); // shorter
  const result = ingestTranscripts({ onlyProjectId: 'demo' });
  const report = result.projects.find((r) => r.project === 'demo');
  assert.equal(report.sessionsSkipped, 1);
  assert.ok(result.warnings.some((w) => /shrank/.test(w)));
  const after = fs.readFileSync(path.join(process.env.AOS_HOME, 'projects', 'demo', 'audit.jsonl'), 'utf8');
  assert.equal(after, before, 'nothing written');
});

test('dry run writes nothing', () => {
  fs.writeFileSync(SESSION_FILE, transcriptLines.join('\n') + '\n'); // grown again
  const other = path.join(SESSION_DIR, 'sess-2.jsonl');
  fs.writeFileSync(other, transcriptLines.join('\n').replaceAll('sess-1', 'sess-2') + '\n');
  const auditBefore = fs.readFileSync(path.join(process.env.AOS_HOME, 'projects', 'demo', 'audit.jsonl'), 'utf8');
  const result = ingestTranscripts({ onlyProjectId: 'demo', dryRun: true });
  const report = result.projects.find((r) => r.project === 'demo');
  assert.ok(report.toolCalls > 0, 'dry run still reports what it would do');
  const auditAfter = fs.readFileSync(path.join(process.env.AOS_HOME, 'projects', 'demo', 'audit.jsonl'), 'utf8');
  assert.equal(auditAfter, auditBefore, 'nothing written in dry run');
  assert.equal(discoverSessionFiles().length, 2);
});
