import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadPolicy, evaluateCommand, evaluateBashProtected } from './policy.js';
import { getActiveRun, runDir, runMeta, mutateRunMeta, appendAudit } from './run.js';
import {
  reviewMode,
  reviewPath,
  executionsPath,
  validateReview,
  executableFindingsFromPolicy,
  DEMONSTRABLE_STATUSES,
} from './review.js';
import { aosHome, nowIso, writeJson } from './paths.js';
import { planGateBashVerdict } from './core/pipeline.js';

function runContract(contract, cwd) {
  const started = Date.now();
  try {
    // Shell execution is intentional: contracts are authored by the project
    // owner in their own policy.yaml (same trust model as package.json
    // scripts) and need shell features like `&&` and pipes.
    const out = execSync(contract.command, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: contract.timeout_ms || 10 * 60 * 1000,
      encoding: 'utf8',
    });
    return { name: contract.name, required: !!contract.required, pass: true, ms: Date.now() - started, output: tail(out) };
  } catch (e) {
    const output = tail(`${e.stdout || ''}\n${e.stderr || ''}`.trim() || String(e.message));
    return { name: contract.name, required: !!contract.required, pass: false, ms: Date.now() - started, output };
  }
}

function tail(s, n = 1500) {
  const str = String(s || '');
  return str.length > n ? '…' + str.slice(-n) : str;
}

export function verifyContracts(projectId, cwd) {
  const policy = loadPolicy(projectId);
  const contracts = policy.verification?.contracts || [];
  // No contracts → nothing was verified. Recording a "pass" here would count
  // the run as clean-first-pass in the leverage ratio without a single check
  // having run — the run's verification stays as it was.
  if (!contracts.length) {
    appendAudit(projectId, { event: 'verify', verdict: 'none', contracts: [] });
    return {
      verdict: 'none',
      results: [],
      // gate | warn | off — reviewMode is the one source of truth for the
      // tri-state setting; deriving `!== false` here would misreport warn as
      // a hard gate.
      review_mode: reviewMode(projectId),
    };
  }
  const results = contracts.map((c) => runContract(c, cwd));
  const requiredFailed = results.filter((r) => r.required && !r.pass);
  const verdict = requiredFailed.length === 0 ? 'pass' : 'fail';

  const active = getActiveRun(projectId);
  if (active) {
    mutateRunMeta(projectId, active, (meta) => {
      meta.verification = verdict;
      meta.verification_attempts = (meta.verification_attempts || 0) + 1;
      // Latest per-contract outcome — the console aggregates these across
      // runs to show which contracts fail most.
      meta.contracts = results.map((r) => ({ name: r.name, pass: r.pass, required: r.required }));
    });
    writeVerificationReport(projectId, active, results, verdict);
  }
  appendAudit(projectId, {
    event: 'verify',
    verdict,
    contracts: results.map((r) => ({ name: r.name, pass: r.pass, required: r.required })),
  });
  return { verdict, results, review_mode: reviewMode(projectId) };
}

function writeVerificationReport(projectId, runId, results, verdict) {
  const file = path.join(runDir(projectId, runId), 'verification.md');
  const attempt = (runMeta(projectId, runId)?.verification_attempts || 1);
  const lines = [
    `## Contract check — attempt ${attempt} (${nowIso()})`,
    '',
    `**Verdict: ${verdict.toUpperCase()}**`,
    '',
    '| Contract | Required | Result | Time |',
    '|---|---|---|---|',
    ...results.map((r) => `| ${r.name} | ${r.required ? 'yes' : 'no'} | ${r.pass ? '✅ pass' : '❌ FAIL'} | ${r.ms}ms |`),
    '',
  ];
  for (const r of results.filter((x) => !x.pass)) {
    lines.push(`### ${r.name} output (tail)`, '', '```', r.output, '```', '');
  }
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Verification\n\n';
  fs.writeFileSync(file, existing + lines.join('\n') + '\n');
}

// Execute the reproduce commands recorded in a run's review.json, and write
// the results to an AOS-owned sidecar (`executions.json`). review.json is
// agent-authored — a `pass: true` array in it is not evidence.
//
// This is the executable half of executable findings: `aos run review` runs
// every demonstrable finding's command (open → it must FAIL, fixed → it must
// PASS) in a real subprocess, the same way contracts run. What it proves:
// the finding's claim was checked against the machine, not asserted. What it
// does not prove: that the command is a fair test — a skeptic can point
// `reproduce` at a command that trivially passes. The severity bar and the
// human reading the run still matter; this makes the cheap lie expensive.
//
// The runner lives in verify.js rather than review.js because review.js sits
// below run.js in the import graph (run.js imports reviewState from it), and
// appending the audit line needs run.js's appendAudit.
// A reproduce command is AGENT-AUTHORED (review.json is written by the skeptic
// subagent), which is a lower trust level than the policy.yaml contracts — so
// it must clear the same gate every other agent-issued Bash command clears
// before AOS will execute it, including the plan gate (this path is not a
// hook, so `ask` is treated as refuse). Denied or gated → not run, recorded
// honestly, the finding stays unproven.
function policyVerdictFor(projectId, command, cwd) {
  const policy = loadPolicy(projectId);
  let verdict = evaluateCommand(policy, command, { cwd });
  if (verdict.decision === 'allow') {
    verdict = evaluateBashProtected(command, { home: aosHome(), cwd }) || verdict;
  }
  if (verdict.decision === 'allow') {
    // Non-interactive: a plan-gate `ask` has no human to prompt, so refuse.
    const plan = planGateBashVerdict(projectId, command, null);
    if (plan) verdict = plan;
  }
  return verdict;
}

export function executeReview(projectId, runId, { cwd = null, timeoutMs = 120_000, force = false } = {}) {
  if (!force && !executableFindingsFromPolicy(loadPolicy(projectId))) {
    return { skipped: true, reason: 'executable_findings is off — pass --execute to run anyway' };
  }
  const file = reviewPath(projectId, runId);
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (!raw.trim()) {
    return { error: `No review recorded at ${file} — run the skeptic first (/aos-verify).` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { error: `review.json is not valid JSON — ${e.message}` };
  }
  const { errors, findings } = validateReview(parsed);
  if (errors.length) {
    return { error: 'review.json does not validate — fix it before executing it:', detail: errors };
  }
  const executions = [];
  findings.forEach((f, i) => {
    if (!f.reproduce || !DEMONSTRABLE_STATUSES.includes(f.status)) return;
    // A command for an `open` finding must fail — it is the bug, demonstrated.
    // A command for a `fixed` finding must pass — it is the fix, holding.
    const expectFailure = f.status === 'open';
    const started = Date.now();
    const gate = policyVerdictFor(projectId, f.reproduce, cwd || process.cwd());
    if (gate.decision !== 'allow') {
      // The gate said no (or would ask). Record it without running: a command
      // the policy refuses must not execute silently from inside a review file.
      executions.push({
        finding: i,
        status: f.status,
        command: f.reproduce,
        expected: f.status,
        exit: gate.decision === 'deny' ? 'denied-by-policy' : 'gated-by-policy',
        pass: false,
        reason: gate.reason || `the policy would ${gate.decision} this command`,
        ts: nowIso(),
      });
      return;
    }
    let exit = null;
    let output = '';
    try {
      execSync(f.reproduce, { cwd: cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, encoding: 'utf8' });
      exit = 0;
    } catch (e) {
      // execSync throws on non-zero exit AND on timeout/spawn failure — the
      // status tells them apart, and a killed command is not a demonstrated
      // anything.
      exit = e.status ?? null;
      if (exit === null || exit === undefined) {
        exit = 'timeout-or-unrunnable';
      }
      output = tail(`${e.stdout || ''}\n${e.stderr || ''}`.trim() || String(e.message || e));
    }
    // A timeout or unrunnable command demonstrates nothing, either way.
    const demonstrated = expectFailure ? exit !== 0 : exit === 0;
    const pass = exit === 'timeout-or-unrunnable' ? false : demonstrated;
    executions.push({
      finding: i,
      status: f.status,
      command: f.reproduce,
      expected: f.status,
      exit,
      pass,
      ms: Date.now() - started,
      output: output ? tail(output, 400) : undefined,
      ts: nowIso(),
    });
  });
  const passed = executions.filter((e) => e.pass).length;
  writeJson(executionsPath(projectId, runId), { run: runId, ts: nowIso(), executions });
  appendAudit(projectId, {
    event: 'review-exec',
    run: runId,
    executed: executions.length,
    passed,
    findings: executions.map((e) => ({
      finding: e.finding,
      expected: e.expected,
      exit: e.exit,
      pass: e.pass,
      command: String(e.command || '').slice(0, 300),
    })),
  });
  return { executions, passed, total: executions.length };
}
