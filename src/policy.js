import path from 'node:path';
import YAML from 'yaml';
import { projectDir, readIfExists } from './paths.js';

export const DEFAULT_POLICY = {
  version: 1,
  plan_gate: 'auto',
  tiers: {
    forbidden: [
      { pattern: 'push\\s+[^|;&]*(--force|-f)\\b', reason: 'Force-push is forbidden by policy' },
      { pattern: 'rm\\s+-rf\\s+(/|~)(\\s|$)', reason: 'Recursive delete of root/home is forbidden by policy' },
    ],
    gated: [
      { pattern: '\\bgit\\s+push\\b', action: 'git-push' },
      { pattern: '\\bgh\\s+pr\\s+merge\\b', action: 'merge' },
      { pattern: '\\bdeploy\\b', action: 'deploy' },
    ],
  },
  verification: {
    adversarial_review: true,
    contracts: [],
  },
};

export function policyPath(projectId) {
  return path.join(projectDir(projectId), 'policy.yaml');
}

export function loadPolicy(projectId) {
  const raw = readIfExists(policyPath(projectId));
  if (!raw) return DEFAULT_POLICY;
  try {
    const parsed = YAML.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_POLICY;
    return {
      ...DEFAULT_POLICY,
      ...parsed,
      tiers: { ...DEFAULT_POLICY.tiers, ...(parsed.tiers || {}) },
      verification: { ...DEFAULT_POLICY.verification, ...(parsed.verification || {}) },
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

function matchRule(rules, command) {
  for (const rule of rules || []) {
    if (!rule || !rule.pattern) continue;
    let re;
    try {
      re = new RegExp(rule.pattern, 'i');
    } catch {
      continue; // a broken pattern must never take the gate down
    }
    if (re.test(command)) return rule;
  }
  return null;
}

// Returns { decision: 'allow' | 'ask' | 'deny', reason, action }
export function evaluateCommand(policy, command) {
  const cmd = String(command || '');
  const forbidden = matchRule(policy.tiers?.forbidden, cmd);
  if (forbidden) {
    return {
      decision: 'deny',
      action: forbidden.action || 'forbidden',
      reason: forbidden.reason || 'Command is forbidden by project policy',
    };
  }
  const gated = matchRule(policy.tiers?.gated, cmd);
  if (gated) {
    return {
      decision: 'ask',
      action: gated.action || 'gated',
      reason: gated.reason || `Action "${gated.action || 'gated'}" requires human approval per project policy`,
    };
  }
  return { decision: 'allow', action: 'auto', reason: '' };
}
