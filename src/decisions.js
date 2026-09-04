import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectDir, ensureDir, readJson, writeJson, nowIso } from './paths.js';
import { appendAudit } from './run.js';

// External approvals — for providers whose hooks can DENY but cannot ASK
// (Codex and Cursor today: their pre-tool protocols parse "ask" but do not
// enforce it). The flow, per the architecture plan:
//
//   1. A gate verdict that would `ask` becomes a DENY carrying the exact
//      approval command, plus a pending decision bound to the operation.
//   2. A human approves OUTSIDE the agent: `aos approve <id>` (itself gated
//      so an agent can't self-approve where prompts exist, and refused
//      outright where they don't).
//   3. The agent retries the SAME operation; the approved token matches by
//      fingerprint, is consumed single-use, and the call proceeds.
//
// Never silently converted to allow (that would be enforcement theater) and
// never a permanent deny (the human must have a way to say yes).

// How long a pending decision waits for a human, and how long an approval
// stays spendable once granted. Short on purpose: these are "let this one
// command through" tokens, not standing permissions.
export const PENDING_TTL_MS = 30 * 60 * 1000;
const APPROVED_TTL_MS = 15 * 60 * 1000;
// Bound the directories: approvals are created per denied call, and expired
// ones must not accumulate forever.
const MAX_TRACKED = 200;

function decisionsDir(projectId) {
  return path.join(projectDir(projectId), 'decisions');
}

function pendingPath(projectId, id) {
  return path.join(decisionsDir(projectId), 'pending', `${id}.json`);
}

function approvedPath(projectId, id) {
  return path.join(decisionsDir(projectId), 'approved', `${id}.json`);
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch {
    return [];
  }
}

function pruneExpired(projectId) {
  const now = Date.now();
  for (const sub of ['pending', 'approved']) {
    const dir = path.join(decisionsDir(projectId), sub);
    const entries = listDir(dir)
      .map((id) => {
        const d = readJson(path.join(dir, `${id}.json`), null);
        const t = Date.parse(d?.approved_at || d?.created || '') || 0;
        return { id, d, t };
      })
      .sort((a, b) => a.t - b.t);
    const overflow = Math.max(0, entries.length - MAX_TRACKED);
    for (const e of entries.slice(0, overflow)) {
      try {
        fs.unlinkSync(path.join(dir, `${e.id}.json`));
      } catch {
        /* already gone */
      }
    }
    for (const e of entries.slice(overflow)) {
      if (!e.d) continue;
      const ttl = e.d.approved_at ? APPROVED_TTL_MS : PENDING_TTL_MS;
      if (Number.isFinite(e.t) && e.t > 0 && now - e.t > ttl) {
        try {
          fs.unlinkSync(path.join(dir, `${e.id}.json`));
        } catch {
          /* already gone */
        }
      }
    }
  }
}

function capList(v, n, each) {
  if (!Array.isArray(v)) return null;
  return v.slice(0, n).map((x) => String(x || '').slice(0, each));
}

export function createPendingDecision(projectId, { provider, session, action, rule, reason, fingerprint, tool, command, paths }) {
  pruneExpired(projectId);
  const id = `dec_${crypto.randomBytes(8).toString('hex')}`;
  const decision = {
    id,
    project: projectId,
    provider: provider || null,
    session: session || null,
    // the policy rule/action that fired (e.g. git-push, plan-gate)
    action: action || rule || 'gated',
    rule: rule || null,
    reason: String(reason || '').slice(0, 500),
    fingerprint,
    tool: tool || null,
    command: command ? String(command).slice(0, 300) : null,
    paths: capList(paths, 20, 300),
    created: nowIso(),
  };
  ensureDir(path.join(decisionsDir(projectId), 'pending'));
  writeJson(pendingPath(projectId, id), decision);
  appendAudit(projectId, {
    event: 'approval-pending',
    decision: id,
    action: decision.action,
    provider: provider || undefined,
    session: session || null,
  });
  return decision;
}

export function listPendingDecisions(projectId) {
  pruneExpired(projectId);
  const now = Date.now();
  return listDir(path.join(decisionsDir(projectId), 'pending'))
    .map((id) => readJson(pendingPath(projectId, id), null))
    .filter((d) => {
      if (!d) return false;
      const age = now - Date.parse(d.created || '');
      return Number.isFinite(age) && age >= 0 && age <= PENDING_TTL_MS;
    })
    .sort((a, b) => String(a.created).localeCompare(String(b.created)));
}

export function getPendingDecision(projectId, id) {
  if (!/^dec_[A-Za-z0-9_-]{1,64}$/.test(String(id || ''))) return null;
  return readJson(pendingPath(projectId, id), null);
}

// The human act. Moves pending → approved; single-use; the clock restarts so
// the agent has a fresh window to retry. `by` records who and via which route.
export function approveDecision(projectId, id, by = null) {
  const decision = getPendingDecision(projectId, id);
  if (!decision) return { ok: false, error: `No pending decision "${id}" — it may already be approved, consumed, or expired.` };
  const age = Date.now() - Date.parse(decision.created || '');
  if (!Number.isFinite(age) || age < 0 || age > PENDING_TTL_MS) {
    try {
      fs.unlinkSync(pendingPath(projectId, id));
    } catch {
      /* already gone */
    }
    return { ok: false, error: `Decision ${id} expired pending approval (created ${decision.created}). The agent must retry the operation to raise a fresh one.` };
  }
  const approved = { ...decision, approved_by: by || undefined, approved_at: nowIso() };
  ensureDir(path.join(decisionsDir(projectId), 'approved'));
  writeJson(approvedPath(projectId, id), approved);
  try {
    fs.unlinkSync(pendingPath(projectId, id));
  } catch {
    /* already gone */
  }
  appendAudit(projectId, {
    event: 'approval-granted',
    decision: id,
    action: decision.action,
    by: by || undefined,
  });
  return { ok: true, decision: approved };
}

// The gate side: does a valid, approved token exist for EXACTLY this
// operation? Single-use — consumed whether the retry matches or not is wrong,
// so consume only on a fingerprint match; unmatched approvals expire on their
// own. Returns the decision when it unlocks the call, else null.
export function consumeApproval(projectId, fingerprint) {
  const dir = path.join(decisionsDir(projectId), 'approved');
  for (const id of listDir(dir)) {
    const d = readJson(path.join(dir, `${id}.json`), null);
    if (!d || d.fingerprint !== fingerprint) continue;
    try {
      fs.unlinkSync(path.join(dir, `${id}.json`));
    } catch {
      /* raced — treat as consumed by someone else */
      continue;
    }
    const age = Date.now() - Date.parse(d.approved_at || d.created || '');
    if (!Number.isFinite(age) || age < 0 || age > APPROVED_TTL_MS) {
      appendAudit(projectId, { event: 'approval-expired', decision: id, action: d.action });
      continue;
    }
    appendAudit(projectId, {
      event: 'approval-consumed',
      decision: id,
      action: d.action,
      provider: d.provider || undefined,
    });
    return d;
  }
  return null;
}
