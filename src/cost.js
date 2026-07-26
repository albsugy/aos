import fs from 'node:fs';
import path from 'node:path';
import { listRuns, runDir } from './run.js';
import { readSessions } from './sessions.js';
import { costOf, fmtUsd } from './pricing.js';
import { readIfExists } from './paths.js';

// Cost attribution.
//
// Two numbers that must never be conflated, so this module always reports both:
//
//   session spend — every token the agent burned in this repo, tracked or not
//   run spend     — the part of it that happened inside a run
//
// The gap between them is the honest answer to "how much of my agent bill is
// actually going through the pipeline". Collapsing them into one figure would
// overstate the pipeline's coverage, which is exactly the kind of flattering
// arithmetic this project refuses elsewhere.
//
// Everything here is an estimate at published API list prices. Subscription
// (Max/Pro) usage is not billed per token at all, and Bedrock/Vertex differ —
// `unpriced` counts tokens whose model has no rule rather than guessing.

const MODEL_BUCKET_KEYS = ['input', 'output', 'cache_read', 'cache_write_5m', 'cache_write_1h'];

// `7d`, `24h`, `2w`, or any date Date.parse understands. Returns a timestamp,
// null for "no bound", or NaN for input we could not read (the caller errors
// rather than silently reporting everything).
export function parseSince(value) {
  if (!value || value === true) return null;
  const rel = /^(\d+)\s*([hdw])$/i.exec(String(value).trim());
  if (rel) {
    const ms = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[rel[2].toLowerCase()];
    return Date.now() - Number(rel[1]) * ms;
  }
  const abs = Date.parse(value);
  return Number.isFinite(abs) ? abs : NaN;
}

function after(ts, since) {
  if (since === null) return true;
  const t = Date.parse(ts || '');
  // An entry with no usable timestamp predates the filter's reliability; keep
  // it out of a windowed report rather than inventing a date for it.
  return Number.isFinite(t) && t >= since;
}

function mergeBuckets(target, models) {
  for (const [id, u] of Object.entries(models || {})) {
    const bucket = (target[id] = target[id] || {
      input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0,
    });
    for (const k of MODEL_BUCKET_KEYS) bucket[k] += u[k] || 0;
  }
  return target;
}

function bucketTotals(models) {
  const t = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  for (const u of Object.values(models || {})) {
    t.input += u.input || 0;
    t.output += u.output || 0;
    t.cache_read += u.cache_read || 0;
    t.cache_write += (u.cache_write_5m || 0) + (u.cache_write_1h || 0);
  }
  return t;
}

// Per-contract history, read from the audit's `verify` events. These record
// what each contract did on every attempt across every run, which is the only
// place that history exists — meta.json keeps just the latest outcome.
function contractHistory(projectId, since) {
  const stats = new Map();
  const note = (name, pass) => {
    const s =
      stats.get(name) ||
      { name, attempts: 0, failures: 0, runs: new Set(), failedRuns: new Set(), failedCost: 0 };
    s.attempts++;
    if (!pass) s.failures++;
    stats.set(name, s);
    return s;
  };
  for (const run of listRuns(projectId)) {
    if (!after(run.created, since)) continue;
    const raw = readIfExists(path.join(runDir(projectId, run.run), 'audit.jsonl'));
    if (!raw) continue;
    const runUsd = costOf(run.tokens?.models).usd || 0;
    const failedHere = new Set();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry.event !== 'verify' || !Array.isArray(entry.contracts)) continue;
      for (const c of entry.contracts) {
        if (!c || !c.name) continue;
        const s = note(c.name, c.pass);
        s.runs.add(run.run);
        if (!c.pass) failedHere.add(c.name);
      }
    }
    // Attributed once per run, not once per failing attempt: this is "what the
    // runs where this contract failed cost in total", NOT "what this contract's
    // failures caused". We cannot measure the latter — the retry tokens are not
    // separable — and the column header says so.
    for (const name of failedHere) {
      const s = stats.get(name);
      s.failedRuns.add(run.run);
      s.failedCost += runUsd;
    }
  }
  return [...stats.values()].sort((a, b) => b.failures - a.failures || a.name.localeCompare(b.name));
}

export function projectCost(project, since) {
  const sessionModels = {};
  for (const s of readSessions(project.id)) {
    if (!after(s.ts, since)) continue;
    mergeBuckets(sessionModels, s.models);
  }
  const runModels = {};
  const runs = [];
  for (const run of listRuns(project.id)) {
    if (!after(run.created, since)) continue;
    mergeBuckets(runModels, run.tokens?.models);
    runs.push({ ...run, cost: costOf(run.tokens?.models) });
  }
  const session = costOf(sessionModels);
  const inRuns = costOf(runModels);
  return {
    id: project.id,
    name: project.name,
    sessionModels,
    runModels,
    session,
    inRuns,
    runs,
    totals: bucketTotals(sessionModels),
    // What share of the spend went through a run at all. Null when there is no
    // session spend to compare against (nothing recorded, or all pre-0.9).
    tracked: session.usd ? Math.round(((inRuns.usd || 0) / session.usd) * 100) : null,
  };
}

// --- rendering -------------------------------------------------------------

function fmtTokens(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(n || 0);
}

function usd(v) {
  return v === null || v === undefined ? '—' : fmtUsd(v);
}

// Left-aligns the first column, right-aligns the rest — the shape numbers want.
function table(headers, rows) {
  if (!rows.length) return [];
  const all = [headers, ...rows].map((r) => r.map((c) => String(c ?? '')));
  const widths = headers.map((_, i) => Math.max(...all.map((r) => (r[i] || '').length)));
  const line = (cells) =>
    '  ' + cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join('  ');
  return [line(all[0]), '  ' + widths.map((w) => '─'.repeat(w)).join('  '), ...all.slice(1).map(line)];
}

function unpricedNote(...costs) {
  const total = costs.reduce((n, c) => n + (c?.unpriced || 0), 0);
  return total ? [`  (${fmtTokens(total)} tokens on models with no pricing rule are excluded)`] : [];
}

export function printCost({ projects, since, by, sinceLabel }) {
  const reports = projects.map((p) => projectCost(p, since));
  const window = sinceLabel ? ` since ${sinceLabel}` : ' (all time)';
  const out = [`Estimated cost at API list prices${window}`, ''];

  if (by === 'run') {
    for (const r of reports) {
      if (!r.runs.length) continue;
      out.push(`■ ${r.name}`);
      out.push(
        ...table(
          ['Run', 'State', 'Verify', 'Tries', 'Est. cost'],
          r.runs.map((run) => [
            run.run,
            run.state,
            run.verification || '—',
            String(run.verification_attempts ?? 0),
            usd(run.cost.usd),
          ])
        ),
        ''
      );
    }
    if (out.length === 2) out.push('  No runs in this window.', '');
  } else if (by === 'model') {
    const models = {};
    for (const r of reports) mergeBuckets(models, r.sessionModels);
    const rows = Object.entries(models)
      .map(([id, u]) => ({ id, u, usd: costOf({ [id]: u }).usd }))
      .sort((a, b) => (b.usd || 0) - (a.usd || 0));
    out.push(
      ...table(
        ['Model', 'Input', 'Output', 'Cache read', 'Cache write', 'Est. cost'],
        rows.map((r) => [
          r.id,
          fmtTokens(r.u.input),
          fmtTokens(r.u.output),
          fmtTokens(r.u.cache_read),
          fmtTokens((r.u.cache_write_5m || 0) + (r.u.cache_write_1h || 0)),
          usd(r.usd),
        ])
      ),
      ''
    );
  } else if (by === 'contract') {
    let any = false;
    for (const r of reports) {
      const history = contractHistory(r.id, since);
      if (!history.length) continue;
      any = true;
      out.push(`■ ${r.name}`);
      out.push(
        ...table(
          ['Contract', 'Attempts', 'Failed', 'Fail rate', 'Runs it failed in', 'Cost of those runs'],
          history.map((c) => [
            c.name,
            String(c.attempts),
            String(c.failures),
            `${Math.round((c.failures / c.attempts) * 100)}%`,
            `${c.failedRuns.size}/${c.runs.size}`,
            usd(c.failedCost || null),
          ])
        ),
        ''
      );
    }
    if (!any) return console.log('No contract results recorded in this window.');
    out.push(
      '  "Cost of those runs" is the total spend of runs where the contract failed —',
      '  not the cost its failures caused. Retry tokens are not separable from the rest.',
      ''
    );
  } else {
    out.push(
      ...table(
        ['Project', 'Input', 'Output', 'Cache read', 'Session spend', 'In runs', 'Tracked'],
        reports.map((r) => [
          r.name,
          fmtTokens(r.totals.input),
          fmtTokens(r.totals.output),
          fmtTokens(r.totals.cache_read),
          usd(r.session.usd),
          usd(r.inRuns.usd),
          r.tracked === null ? '—' : `${r.tracked}%`,
        ])
      ),
      ''
    );
    const totalSession = reports.reduce((n, r) => n + (r.session.usd || 0), 0);
    const totalRuns = reports.reduce((n, r) => n + (r.inRuns.usd || 0), 0);
    if (reports.length > 1) out.push(`  Total: ${fmtUsd(totalSession)} — ${fmtUsd(totalRuns)} of it inside runs`, '');
    out.push(
      '  Session spend is everything the agent burned in the repo; "in runs" is the part',
      '  that went through the pipeline. Subscription usage is not billed per token.',
      ''
    );
  }

  out.push(...unpricedNote(...reports.map((r) => r.session)));
  console.log(out.join('\n'));
}

// --- the price tag on the run ----------------------------------------------

// Delimited on both sides so replacing the stamp is an exact slice. A single
// opening marker would force "replace to the next heading", and getting that
// wrong deletes whatever a human appended below the cost table.
const COST_START = '<!-- aos:cost -->';
const COST_END = '<!-- /aos:cost -->';

// Stamp the finished run's cost into outcome.md, so a PR drafted from it
// carries its own price tag. Called from the post-tool hook AFTER tokens are
// settled — at `aos run finish` time the numbers are not final yet.
//
// Append-only, marked, and idempotent: an existing stamp is replaced, never
// duplicated, and a run with no outcome.md is left alone rather than having
// one invented for it.
export function stampRunCost(projectId, runId, meta) {
  const file = path.join(runDir(projectId, runId), 'outcome.md');
  let existing;
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // no outcome.md — nothing to stamp
  }
  const { usd: amount, unpriced } = costOf(meta?.tokens?.models);
  if (amount === null && !unpriced) return null;
  const t = bucketTotals(meta?.tokens?.models);
  const block = [
    COST_START,
    '## Cost',
    '',
    `**${fmtUsd(amount) ?? 'unpriced'}** estimated at API list prices` +
      (unpriced ? ` (+${fmtTokens(unpriced)} tokens on unpriced models)` : ''),
    '',
    `${fmtTokens(t.input)} input · ${fmtTokens(t.output)} output · ` +
      `${fmtTokens(t.cache_read)} cache read · ${fmtTokens(t.cache_write)} cache write`,
    '',
    `<sub>Subscription usage is not billed per token; see \`aos cost\`.</sub>`,
    COST_END,
    '',
  ].join('\n');
  // Replace ONLY between the markers — everything a human wrote above or below
  // the stamp survives. A run that is reopened and re-finished must not lose
  // the reviewer notes somebody appended after the last cost table.
  const start = existing.indexOf(COST_START);
  const end = existing.indexOf(COST_END);
  if (start !== -1 && end > start) {
    const after = existing.slice(end + COST_END.length).replace(/^\n/, '');
    fs.writeFileSync(file, existing.slice(0, start) + block + after);
    return amount;
  }
  // Malformed markers (only one present, or END before START) can't delimit
  // anything. Appending on top of them would re-append on every finish and grow
  // the file without bound, so sweep out every complete block and any orphan
  // marker first — this always converges on exactly one stamp.
  const swept = existing
    .replace(/<!-- aos:cost -->[\s\S]*?<!-- \/aos:cost -->\n?/g, '')
    .split(COST_START)
    .join('')
    .split(COST_END)
    .join('');
  fs.writeFileSync(file, swept.trimEnd() + '\n\n' + block);
  return amount;
}
