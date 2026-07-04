import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry } from './registry.js';
import { listRuns, getActiveRun } from './run.js';
import { projectDir, readIfExists } from './paths.js';

function sumSessions(projectId) {
  const raw = readIfExists(path.join(projectDir(projectId), 'sessions.jsonl'));
  const total = { input: 0, output: 0, cache_read: 0 };
  if (!raw) return total;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line);
      total.input += s.input_tokens || 0;
      total.output += s.output_tokens || 0;
      total.cache_read += s.cache_read_tokens || 0;
    } catch {
      /* skip */
    }
  }
  return total;
}

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(n);
}

export function projectSummary(p) {
  const runs = listRuns(p.id);
  const byState = {};
  for (const r of runs) byState[r.state] = (byState[r.state] || 0) + 1;
  const finished = runs.filter((r) => ['awaiting-review', 'done', 'shipped'].includes(r.state));
  const cleanFirstPass = finished.filter(
    (r) => r.verification === 'pass' && (r.verification_attempts || 0) <= 1
  );
  const tokens = sumSessions(p.id);
  return {
    id: p.id,
    name: p.name,
    repos: p.repos,
    runs,
    counts: byState,
    activeRun: getActiveRun(p.id),
    leverage: finished.length ? Math.round((cleanFirstPass.length / finished.length) * 100) : null,
    tokens,
  };
}

export function fullState() {
  const reg = loadRegistry();
  return { projects: reg.projects.map(projectSummary) };
}

export function printStatus() {
  const state = fullState();
  if (!state.projects.length) {
    console.log('No AOS projects yet. Run `aos init` inside a repo to register one.');
    return;
  }
  for (const p of state.projects) {
    const counts = Object.entries(p.counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ') || 'no runs';
    console.log(`\n■ ${p.name}  (${p.id})`);
    console.log(`  runs: ${counts}`);
    if (p.activeRun) console.log(`  active: ${p.activeRun}`);
    if (p.leverage !== null) console.log(`  leverage ratio: ${p.leverage}% clean-first-pass`);
    const cache = p.tokens.cache_read ? ` (+${fmtTokens(p.tokens.cache_read)} cache-read)` : '';
    console.log(`  tokens: ${fmtTokens(p.tokens.input)} in / ${fmtTokens(p.tokens.output)} out${cache}`);
    const awaiting = p.runs.filter((r) => r.state === 'awaiting-review');
    for (const r of awaiting) {
      console.log(`  ⏳ awaiting review: ${r.run}${r.ticket ? ` — ${r.ticket}` : ''}`);
    }
  }
  console.log('');
}
