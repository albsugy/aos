import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { loadPolicy } from './policy.js';
import { getActiveRun, runDir, runMeta, mutateRunMeta, appendAudit } from './run.js';
import { nowIso } from './paths.js';

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
  const results = contracts.map((c) => runContract(c, cwd));
  const requiredFailed = results.filter((r) => r.required && !r.pass);
  const verdict = requiredFailed.length === 0 ? 'pass' : 'fail';

  const active = getActiveRun(projectId);
  if (active) {
    mutateRunMeta(projectId, active, (meta) => {
      meta.verification = verdict;
      meta.verification_attempts = (meta.verification_attempts || 0) + 1;
    });
    writeVerificationReport(projectId, active, results, verdict);
  }
  appendAudit(projectId, {
    event: 'verify',
    verdict,
    contracts: results.map((r) => ({ name: r.name, pass: r.pass, required: r.required })),
  });
  return { verdict, results, adversarial_review: policy.verification?.adversarial_review !== false };
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
