import path from 'node:path';
import { aosHome, projectDir, readIfExists } from './paths.js';
import { loadPolicy, loadPolicyFile, evaluateCommand, evaluateBashProtected } from './policy.js';
import { listRuns, runDir } from './run.js';
import { getProject } from './registry.js';

// Policy CI: replay the commands that ACTUALLY ran against a policy that
// hasn't been switched on yet (`aos policy test --file candidate.yaml`), or
// against the current one (no --file) to see what it would do to history.
//
// The evidence is the audit ledger itself — every Bash command the gate saw
// (event "gate") and every one that actually executed (event "tool", written
// by the post-tool hook) plus everything ingested from session transcripts
// (event "tool", source "ingested"). That last source is the point of the
// pairing: install AOS today, ingest a month of transcripts, and tune the
// policy against the real traffic instead of a guess.
//
// Honest limits, stated here because the output says them quieter:
// - Commands are recorded truncated at 300 characters. A rule whose pattern
//   only matches past that point cannot be evaluated against a truncated
//   record; those rows are counted and reported as `truncated`, never
//   silently treated as clean.
// - Replay re-judges the command text, not the session state around it: the
//   plan gate and scope gate are stateful and are deliberately NOT replayed.
//   This tool answers "what do the command tiers and write-protection do to
//   real traffic", nothing else.

function ledgerFiles(projectId) {
  const files = [];
  const push = (p) => {
    files.push(p.replace(/audit\.jsonl$/, 'audit.1.jsonl'), p);
  };
  push(path.join(projectDir(projectId), 'audit.jsonl'));
  for (const r of listRuns(projectId)) push(path.join(runDir(projectId, r.run), 'audit.jsonl'));
  return files;
}

// Every recorded Bash command with the decision it actually got.
// Entries: { command, recorded, ts, source }. `recorded` is 'allow' for tool
// events (they ran — whatever asked first was approved or nothing asked),
// and the gate's own decision for gate events. Duplicates are preserved as
// counts and the replay evaluates uniques.
export function collectBashHistory(projectId, sinceMs = 0) {
  const byCommand = new Map();
  let scanned = 0;
  let truncated = 0;
  for (const file of ledgerFiles(projectId)) {
    const raw = readIfExists(file);
    if (!raw) continue;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const command = typeof entry.command === 'string' ? entry.command : entry.tool === 'Bash' ? String(entry.summary || '') : '';
      if (!command) continue;
      if (entry.ts && sinceMs && Date.parse(entry.ts) < sinceMs) continue;
      scanned++;
      if (command.length >= 300) truncated++;
      const source = entry.source === 'ingested' ? 'ingested' : entry.event === 'gate' ? 'gate' : 'tool';
      const recorded = entry.event === 'gate' && entry.decision ? entry.decision : 'allow';
      const prev = byCommand.get(command) || { command, count: 0, recorded, ts: entry.ts || null, source };
      prev.count++;
      // A command both asked (gate) and ran (tool) later: the strictest
      // recorded outcome is the gate's — that is what the policy did.
      if (entry.event === 'gate' && entry.decision && entry.decision !== 'allow') prev.recorded = entry.decision;
      byCommand.set(command, prev);
    }
  }
  return { scanned, truncated, unique: [...byCommand.values()] };
}

// Re-judge every unique command under `policy`. Only the stateless layers run:
// command tiers, then (on allow) shell-path write protection. cwd is the
// project's registered repo root — the same anchor the live gate uses.
export function replayPolicy(projectId, policy, cwd, sinceMs = 0) {
  const history = collectBashHistory(projectId, sinceMs);
  const wouldDeny = [];
  const wouldAsk = [];
  const wouldTighten = [];
  const wouldUnblock = [];
  let unchanged = 0;
  let errors = 0;
  for (const row of history.unique) {
    let verdict;
    try {
      verdict = evaluateCommand(policy, row.command, { cwd });
      if (verdict.decision === 'allow') {
        verdict = evaluateBashProtected(row.command, { home: aosHome(), cwd }) || verdict;
      }
    } catch {
      errors++;
      continue;
    }
    const now = verdict.decision;
    if (row.recorded === 'allow' && now === 'deny') {
      wouldDeny.push({ ...row, action: verdict.action || null, reason: verdict.reason || null });
    } else if (row.recorded === 'allow' && now === 'ask') {
      wouldAsk.push({ ...row, action: verdict.action || null, reason: verdict.reason || null });
    } else if (row.recorded === 'ask' && now === 'deny') {
      // Previously gated-and-approved, now forbidden outright: a real change,
      // not "unchanged" — someone tightening a policy needs to see it.
      wouldTighten.push({ ...row, action: verdict.action || null, reason: verdict.reason || null, was: 'ask' });
    } else if (row.recorded !== 'allow' && now === 'allow') {
      wouldUnblock.push({ ...row, was: row.recorded });
    } else {
      unchanged++;
    }
  }
  return { ...history, wouldDeny, wouldAsk, wouldTighten, wouldUnblock, unchanged, errors };
}

// `--file` names a candidate; without it the project's current policy is
// replayed against its own history (a drift reading: what the enforced policy
// would do to the traffic that already ran under it).
export function runPolicyTest(projectId, { file = null, sinceMs = 0 } = {}) {
  const policy = file ? loadPolicyFile(file) : loadPolicy(projectId);
  const cwd = getProject(projectId)?.repos?.[0] || process.cwd();
  const result = replayPolicy(projectId, policy, cwd, sinceMs);
  return { policy, cwd, ...result };
}
