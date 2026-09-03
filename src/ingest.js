import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectDir, canonicalPath, readJson, writeJson, appendLineRotated, nowIso } from './paths.js';
import { loadRegistry } from './registry.js';
import { appendChainedTo } from './chain.js';
import { sessionsPath } from './sessions.js';
import { sumTranscriptUsage } from './hooks.js';

// History ingest: reconstruct AOS's audit trail and token ledger from what
// Claude Code already wrote on disk (~/.claude/projects/<slug>/<session>.jsonl),
// no runtime cooperation required.
//
// Why that matters: the audit ledger and `aos policy test` only know what
// happened since AOS was installed. Most of a repo's real agent traffic —
// the evidence you actually want when tuning a policy — predates the install.
// Ingest backfills it: tool calls become chained audit lines (marked
// `source: "ingested"`, original timestamps preserved), and each session's
// cumulative usage lands in sessions.jsonl in the same shape the SessionEnd
// hook writes (readers dedup by largest total per session id, so re-ingesting
// a grown file replaces rather than adds).
//
// What ingest deliberately does NOT claim:
// - Gate decisions are not in transcripts. Ingested lines record no allow/deny
//   verdict; they are activity history, not gate history.
// - Sidechain (subagent) turns are included, matching the SessionEnd hook,
//   which also sums them — consistency with the live ledger beats a split view.
// - Only Claude Code transcripts are read today. Other runtimes need their own
//   adapter with the same output shape.
//
// Idempotency: projects/<id>/ingest.json records, per session id, how many raw
// lines were consumed. Re-running ingests only the delta (Claude Code appends
// to a session file across resume), so tool calls are never duplicated and
// token totals only ever grow. A file that shrank (cleaned, recreated) is
// skipped with a warning rather than double-counted.

export function claudeProjectsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

function ingestStatePath(projectId) {
  return path.join(projectDir(projectId), 'ingest.json');
}

// The registry's longest-prefix match, applied to a transcript's recorded
// cwd instead of the live process's.
function projectForCwds(cwds, registry) {
  let best = null;
  let bestLen = -1;
  for (const cwd of cwds) {
    let resolved;
    try {
      resolved = canonicalPath(cwd);
    } catch {
      continue;
    }
    for (const p of registry.projects) {
      for (const repo of p.repos || []) {
        if (resolved === repo || resolved.startsWith(repo + path.sep)) {
          if (repo.length > bestLen) {
            best = p;
            bestLen = repo.length;
          }
        }
      }
    }
  }
  return best;
}

// Same summary semantics the post-tool hook uses, so an ingested Bash line is
// indistinguishable from a live one downstream (scope checks, policy replay).
export function summarizeToolUse(name, input = {}) {
  if (name === 'Bash') return String(input.command || '').slice(0, 300);
  if (input.file_path) return input.file_path;
  if (input.notebook_path) return input.notebook_path;
  if (input.pattern) return String(input.pattern).slice(0, 120);
  if (input.url) return input.url;
  const keys = Object.keys(input).slice(0, 3).join(',');
  return keys ? `{${keys}}` : '';
}

function toolCallsOf(entry) {
  if (entry.type !== 'assistant' || !entry.message) return [];
  const content = entry.message.content;
  if (!Array.isArray(content)) return [];
  const calls = [];
  for (const block of content) {
    if (!block || block.type !== 'tool_use') continue;
    calls.push({
      ts: entry.timestamp || null,
      tool: block.name,
      summary: summarizeToolUse(block.name, block.input || {}),
    });
  }
  return calls;
}

// One parsed session file: the facts ingest needs, nothing else. Each tool
// call carries its row index, so the delta slice ("everything at/after the
// watermark") is a filter over ONE parse — no second read of the file.
// Facts (sessionId/cwds/lines) always scan the whole file: they are the match
// key and the new watermark.
export function parseTranscript(file) {
  const out = { file, lines: 0, sessionId: null, cwds: new Set(), toolCalls: [], lastTs: null };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const rows = raw.split('\n');
  let lastNonEmpty = -1;
  for (let i = 0; i < rows.length; i++) {
    const line = rows[i];
    if (!line.trim()) continue;
    lastNonEmpty = i;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.sessionId) out.sessionId = entry.sessionId;
    if (entry.cwd) out.cwds.add(entry.cwd);
    if (entry.timestamp) out.lastTs = entry.timestamp;
    for (const call of toolCallsOf(entry)) out.toolCalls.push({ ...call, row: i });
  }
  out.lines = lastNonEmpty + 1;
  if (!out.sessionId) out.sessionId = path.basename(file).replace(/\.jsonl$/, '');
  return out;
}

export function discoverSessionFiles(dir = claudeProjectsDir()) {
  const out = [];
  let slugs;
  try {
    slugs = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const slug of slugs) {
    const full = path.join(dir, slug);
    let entries;
    try {
      entries = fs.readdirSync(full, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith('.jsonl')) out.push(path.join(full, e.name));
    }
  }
  return out;
}

// Ingest every transcript that maps to a registered project. Returns a
// per-project report; with dryRun nothing is written.
export function ingestTranscripts({ dryRun = false, onlyProjectId = null } = {}) {
  const registry = loadRegistry();
  const files = discoverSessionFiles();
  const states = new Map(); // projectId → parsed ingest.json (mutations accumulate here)
  const reports = new Map(); // projectId → report
  const warnings = [];

  const reportFor = (id) => {
    if (!reports.has(id)) {
      reports.set(id, {
        project: id, files: 0, sessionsNew: 0, sessionsDelta: 0, sessionsSkipped: 0,
        toolCalls: 0, tokens: { input: 0, output: 0, cache_read: 0 },
      });
    }
    return reports.get(id);
  };

  for (const file of files) {
    const peek = parseTranscript(file);
    if (!peek || peek.lines === 0) continue;
    const project = projectForCwds(peek.cwds, registry);
    if (!project) continue;
    if (onlyProjectId && project.id !== onlyProjectId) continue;

    if (!states.has(project.id)) {
      states.set(project.id, readJson(ingestStatePath(project.id), { files: {} }));
    }
    const state = states.get(project.id);
    state.files = state.files || {};
    const prior = state.files[file];

    if (prior && prior.lines === peek.lines) continue; // nothing new — not even a report row

    const report = reportFor(project.id);
    report.files++;

    if (prior && prior.lines > peek.lines) {
      // The file got SHORTER — cleaned or recreated under the same path. Re-ingest
      // would double-count tokens; skip and say so.
      report.sessionsSkipped++;
      warnings.push(`${path.basename(file)}: shrank since last ingest (${prior.lines} → ${peek.lines} lines) — skipped to avoid double-counting`);
      continue;
    }

    // Delta slice from the SAME parse — calls carry their row index.
    const deltaCalls = prior ? peek.toolCalls.filter((c) => c.row >= prior.lines) : peek.toolCalls;
    report.toolCalls += deltaCalls.length;
    if (prior) report.sessionsDelta++; else report.sessionsNew++;

    if (dryRun) continue;

    // Audit lines: chained, straight into the PROJECT ledger — never a run's,
    // because historical traffic belongs to no active run.
    const audit = path.join(projectDir(project.id), 'audit.jsonl');
    const rotated = audit.replace(/audit\.jsonl$/, 'audit.1.jsonl');
    for (const call of deltaCalls) {
      appendChainedTo(audit, rotated, {
        ts: call.ts || peek.lastTs || nowIso(),
        event: 'tool',
        tool: call.tool,
        summary: call.summary,
        session: peek.sessionId,
        source: 'ingested',
      });
    }
    // Session usage: cumulative for the whole file, same shape SessionEnd
    // writes; sessions.js dedups by largest total per session id.
    const usage = sumTranscriptUsage(file);
    if (usage.input || usage.output || usage.cache_read) {
      appendLineRotated(
        sessionsPath(project.id),
        JSON.stringify({
          ts: nowIso(),
          session: peek.sessionId,
          source: 'ingested',
          input_tokens: usage.input,
          output_tokens: usage.output,
          cache_read_tokens: usage.cache_read,
          models: Object.keys(usage.models || {}).length ? usage.models : undefined,
        })
      );
      report.tokens.input += usage.input;
      report.tokens.output += usage.output;
      report.tokens.cache_read += usage.cache_read;
    }
    state.files[file] = { session: peek.sessionId, lines: peek.lines, ts: nowIso() };
  }

  if (!dryRun) {
    for (const [id, state] of states) writeJson(ingestStatePath(id), state);
  }
  return { files: files.length, projects: [...reports.values()], warnings };
}
