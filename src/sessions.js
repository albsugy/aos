import path from 'node:path';
import { projectDir, readIfExists } from './paths.js';

// Per-session token accounting, read back correctly.
//
// The write side records a session's usage as summed from its WHOLE
// transcript — a cumulative total, not a delta. Claude Code ends the same
// session more than once (resume, /clear, logout each fire SessionEnd against
// the same, still-growing transcript file), so that cumulative total lands in
// sessions.jsonl once per ending. Summing every line therefore multiplies a
// resumed session's spend by the number of times it ended: a heavily resumed
// session can be counted the better part of ten times over, which is enough to
// make the reported token and dollar totals wrong by a multiple.
//
// The log stays append-only — context.js reads it as an event sequence to
// find the learnings-debt marker, and each SessionEnd genuinely is an event.
// Deduplication belongs here, on read.
export function sessionsPath(projectId) {
  return path.join(projectDir(projectId), 'sessions.jsonl');
}

const MODEL_BUCKET_KEYS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];

// Raw parse, in file order, malformed lines skipped. For consumers that want
// the event sequence rather than per-session totals.
export function readSessionLines(projectId) {
  const raw = readIfExists(sessionsPath(projectId));
  if (!raw) return [];
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // skip malformed lines
    }
  }
  return out;
}

function totalTokens(entry) {
  return (entry.input_tokens || 0) + (entry.output_tokens || 0) + (entry.cache_read_tokens || 0);
}

// One entry per session id, in first-seen order. The winner is the line with
// the LARGEST total, not the last: a rotated or truncated transcript makes a
// later line report less, and under-reporting is the failure mode to avoid.
// Flags (learnings_owed / memory_write) always take the latest value — they
// describe the session's final state, not its usage. Entries with no session
// id can't be attributed, so they're never merged.
export function readSessions(projectId) {
  const bySession = new Map();
  const out = [];
  for (const entry of readSessionLines(projectId)) {
    const id = entry.session;
    if (!id) {
      out.push(entry);
      continue;
    }
    const seen = bySession.get(id);
    if (!seen) {
      bySession.set(id, entry);
      out.push(entry);
      continue;
    }
    const flags = {
      ts: entry.ts ?? seen.ts,
      learnings_owed: entry.learnings_owed ?? seen.learnings_owed,
      memory_write: entry.memory_write ?? seen.memory_write,
    };
    // Mutating in place keeps the merged entry at its original position in
    // `out` (the console plots these in order).
    if (totalTokens(entry) >= totalTokens(seen)) Object.assign(seen, entry);
    Object.assign(seen, flags);
  }
  return out;
}

// Project-wide totals, deduplicated. `models` buckets are what the dollar
// estimate is computed from; the flat fields stay for pre-0.9 sessions that
// have no per-model breakdown.
export function sumSessions(projectId) {
  const total = { input: 0, output: 0, cache_read: 0, models: {} };
  for (const s of readSessions(projectId)) {
    total.input += s.input_tokens || 0;
    total.output += s.output_tokens || 0;
    total.cache_read += s.cache_read_tokens || 0;
    for (const [id, u] of Object.entries(s.models || {})) {
      const bucket = (total.models[id] = total.models[id] || {
        input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0,
      });
      for (const k of MODEL_BUCKET_KEYS) bucket[k] += u[k] || 0;
    }
  }
  return total;
}
