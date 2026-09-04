import { loadRegistry } from './registry.js';
import { listRuns, getActiveRun, dryRunGateSummary } from './run.js';
import { sumSessions } from './sessions.js';
import { loadPolicy } from './policy.js';
import { costOf, fmtUsd } from './pricing.js';

// A percentage over a handful of runs is noise dressed as a metric: 1 of 3
// reads as "33%" and moves 33 points on the next run. Below this the raw
// fraction is reported instead, so the sample size is impossible to miss.
export const LEVERAGE_MIN_RUNS = 10;

function fmtTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return Math.round(n / 1_000) + 'k';
  return String(n);
}

export function projectSummary(p) {
  const runs = listRuns(p.id).map((r) => ({
    ...r,
    cost_usd: costOf(r.tokens?.models).usd,
  }));
  const byState = {};
  for (const r of runs) byState[r.state] = (byState[r.state] || 0) + 1;
  const finished = runs.filter((r) => ['awaiting-review', 'done', 'shipped'].includes(r.state));
  const cleanFirstPass = finished.filter(
    (r) => r.verification === 'pass' && (r.verification_attempts || 0) <= 1
  );
  const tokens = sumSessions(p.id);
  const cost = costOf(tokens.models);
  const dryRun = loadPolicy(p.id).dry_run === true;
  return {
    id: p.id,
    name: p.name,
    repos: p.repos,
    // Which coding agents this project is wired for (see agents.js / doctor).
    agents: p.agents || [],
    runs,
    counts: byState,
    activeRun: getActiveRun(p.id),
    // null until the sample can carry a rate — `leverage_sample` is always
    // present, so a consumer can show the fraction either way.
    leverage:
      finished.length >= LEVERAGE_MIN_RUNS
        ? Math.round((cleanFirstPass.length / finished.length) * 100)
        : null,
    leverage_sample: { clean: cleanFirstPass.length, total: finished.length },
    // Only computed when it's on: the summary reads every run's audit.
    dry_run: dryRun ? dryRunGateSummary(p.id) : null,
    tokens,
    // Estimated at API list prices from per-model usage; null when no model
    // data exists yet (sessions recorded before v0.9 have no buckets).
    cost_usd: cost.usd,
    cost_unpriced_tokens: cost.unpriced,
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
    if (p.dry_run) {
      // Loud, and above everything else: a dry-run project looks perfectly
      // healthy from inside a session, because nothing ever prompts.
      const breakdown = Object.entries(p.dry_run.byAction)
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${n}× ${k}`)
        .join(', ');
      console.log(
        `  ⚠ DRY RUN — gates are recording, not enforcing. ${p.dry_run.total} decision(s) suppressed` +
          `${breakdown ? `: ${breakdown}` : ''}.\n` +
          `    Set dry_run: false in policy.yaml to enforce them.`
      );
    }
    console.log(`  runs: ${counts}`);
    if (p.activeRun) console.log(`  active: ${p.activeRun}`);
    const sample = p.leverage_sample;
    if (sample?.total) {
      console.log(
        p.leverage !== null
          ? `  leverage ratio: ${p.leverage}% clean-first-pass (${sample.clean}/${sample.total})`
          : `  clean-first-pass: ${sample.clean}/${sample.total} runs (too few to rate)`
      );
    }
    const cache = p.tokens.cache_read ? ` (+${fmtTokens(p.tokens.cache_read)} cache-read)` : '';
    const cost = p.cost_usd !== null ? `  ≈ ${fmtUsd(p.cost_usd)} est. at API rates` : '';
    console.log(`  tokens: ${fmtTokens(p.tokens.input)} in / ${fmtTokens(p.tokens.output)} out${cache}${cost}`);
    const awaiting = p.runs.filter((r) => r.state === 'awaiting-review');
    for (const r of awaiting) {
      // `forced` and the legacy `absent`/`present` states can still appear on
      // runs finished before the gate existed (or forced past it).
      const adv =
        r.adversarial_review === 'forced'
          ? '  ⚠ review gate forced'
          : r.adversarial_review === 'absent'
            ? '  ⚠ no adversarial review'
            : r.adversarial_review === 'unproven'
              ? '  ⚠ review unproven — a reproduce command was never run'
              : r.adversarial_review === 'resolved'
                ? `  ✓ review: ${r.review?.total || 0} finding(s) resolved`
                : ['clean', 'present'].includes(r.adversarial_review)
                  ? '  ✓ adversarial review'
                  : '';
      console.log(`  ⏳ awaiting review: ${r.run}${r.ticket ? ` — ${r.ticket}` : ''}${adv}`);
    }
  }
  console.log('');
}
