import path from 'node:path';
import os from 'node:os';
import { aosHome, projectDir, appendLineRotated, nowIso, canonicalPath } from '../paths.js';
import { findProjectByCwd } from '../registry.js';
import {
  loadPolicy,
  evaluateCommand,
  evaluateFileWrite,
  evaluateBashProtected,
  commandWritesFiles,
  commandSegments,
  stripQuoted,
} from '../policy.js';
import {
  appendAudit,
  getActiveRun,
  settleRunTokens,
  bindRunSession,
  findRunBySession,
  runDir,
  runMeta,
  sessionMemoryActivity,
} from '../run.js';
import { buildContext } from '../context.js';
import { recordSignoffTicket } from '../signoff.js';
import { sessionsPath } from '../sessions.js';
import { runScope, inScope } from '../scope.js';
import { stampRunCost } from '../cost.js';
import { sumTranscriptUsage } from '../transcripts.js';
import { createPendingDecision, consumeApproval } from '../decisions.js';
import { operationFingerprint, absoluteTargets } from './events.js';

// ── The provider-neutral gate pipeline ───────────────────────────────────
//
// Everything here consumes normalized events (core/events.js) and produces
// normalized decisions; adapters translate at the edges. No provider tool
// name appears in this file — the audit trail records the provider's own
// spelling as evidence, never as logic.

// Gate actions whose permission prompt doubles as a human sign-off (Claude;
// providers without native `ask` reach these only through `aos approve`).
const SIGNOFF_ACTIONS = new Set(['plan-approve', 'review-close', 'project-remove']);

// States a run only reaches by actually finishing — see hooks' token settle.
const FINISHED_STATES = new Set(['awaiting-review', 'done', 'shipped']);

// Permission modes in which an `ask` is guaranteed to reach a human.
// Claude Code and Codex both send `permission_mode`; adapters that never
// carry it get null, and providers without native ask never mint tickets.
const PROMPTING_MODES = new Set(['default', 'plan']);

export function promptReachesHuman(event) {
  const mode = event.permissionMode;
  return !mode || PROMPTING_MODES.has(mode);
}

export function resolveProject(event) {
  return findProjectByCwd(event.cwd || process.cwd());
}

// The REPO root, not the session's working directory (see hooks history:
// sessions open in monorepo subdirectories; the registry knows the real root).
export function repoRootFor(project, cwd) {
  const resolved = canonicalPath(cwd);
  const match = (project.repos || []).find((r) => resolved === r || resolved.startsWith(r + path.sep));
  return match || resolved;
}

// ── plan gate ─────────────────────────────────────────────────────────────

function unapprovedPlanRun(projectId, sessionId) {
  const active = getActiveRun(projectId);
  if (!active) return null;
  const meta = runMeta(projectId, active);
  if (!meta || meta.plan_gate !== 'ask' || meta.plan_approved) return null;
  if (meta.session && sessionId && meta.session !== sessionId) return null;
  return active;
}

function planGateReason(runId) {
  return `Plan for run ${runId} is not approved yet — review plan.md, then run \`aos run approve\` (or approve this prompt to allow this single write)`;
}

function planGateVerdict(projectId, absPath, sessionId) {
  const active = unapprovedPlanRun(projectId, sessionId);
  if (!active) return null;
  if (absPath.startsWith(canonicalPath(runDir(projectId, active)) + path.sep)) return null;
  if (absPath.startsWith(canonicalPath(projectDir(projectId)) + path.sep)) return null;
  return { decision: 'ask', action: 'plan-gate', reason: planGateReason(active) };
}

function scopeGateVerdict(projectId, absPath, sessionId, repoRoot) {
  const active = getActiveRun(projectId);
  if (!active || !repoRoot) return null;
  const meta = runMeta(projectId, active);
  if (!meta) return null;
  if (meta.session && sessionId && meta.session !== sessionId) return null;
  if (absPath.startsWith(canonicalPath(runDir(projectId, active)) + path.sep)) return null;
  if (absPath.startsWith(canonicalPath(projectDir(projectId)) + path.sep)) return null;
  if (!absPath.startsWith(repoRoot + path.sep)) return null;
  const entries = runScope(projectId, active);
  if (!entries.length) return null;
  const rel = absPath.slice(repoRoot.length + 1);
  if (inScope(rel, entries)) return null;
  return {
    decision: 'ask',
    action: 'plan-scope',
    reason:
      `${rel} is outside the scope plan.md declared for run ${active} ` +
      `(${entries.slice(0, 6).join(', ')}${entries.length > 6 ? `, +${entries.length - 6} more` : ''}). ` +
      `Approve this write if the plan was incomplete — and update plan.md so the record matches the work.`,
  };
}

function exemptDirVariants(dir) {
  const home = os.homedir();
  const variants = [dir];
  if (dir.startsWith(home + path.sep)) {
    variants.push('~' + dir.slice(home.length), '$HOME' + dir.slice(home.length));
  }
  return variants;
}

export function planGateBashVerdict(projectId, command, sessionId) {
  const active = unapprovedPlanRun(projectId, sessionId);
  if (!active) return null;
  const exempt = [
    ...exemptDirVariants(runDir(projectId, active)),
    ...exemptDirVariants(projectDir(projectId)),
  ];
  let sawSegmentWrite = false;
  for (const segment of commandSegments(stripQuoted(command))) {
    if (!commandWritesFiles(segment)) continue;
    sawSegmentWrite = true;
    if (exempt.some((d) => segment.includes(d))) continue;
    return { decision: 'ask', action: 'plan-gate', reason: planGateReason(active) };
  }
  if (!sawSegmentWrite && commandWritesFiles(command) && !exempt.some((d) => command.includes(d))) {
    return { decision: 'ask', action: 'plan-gate', reason: planGateReason(active) };
  }
  return null;
}

// ── decisions ─────────────────────────────────────────────────────────────
//
//   { effect: 'allow' | 'deny' | 'require_approval', rule, reason }
//
// `require_approval` means a human must say yes; the ADAPTER decides how that
// reaches the human (Claude: native ask prompt; Codex/Cursor: deny + a
// pending external approval — never a silent allow, never a permanent deny).

const ALLOW = { effect: 'allow' };

function deny(rule, reason) {
  return { effect: 'deny', rule, reason };
}

function ask(action, reason) {
  return { effect: 'require_approval', rule: action, reason };
}

// A verdict from the policy engine ({decision: allow|ask|deny, action, reason})
// mapped to the normalized decision shape.
function fromVerdict(verdict) {
  if (!verdict || verdict.decision === 'allow') return ALLOW;
  if (verdict.decision === 'deny') return deny(verdict.action || 'forbidden', verdict.reason);
  return ask(verdict.action || 'gated', verdict.reason);
}

// ── tool.before ───────────────────────────────────────────────────────────

export function handleToolBefore(event, adapter) {
  const project = resolveProject(event);
  if (!project) return ALLOW; // not an AOS project — stay out of the way
  const policy = loadPolicy(project.id);
  const session = event.session || null;

  let verdict = null;
  let target = '';

  if (event.tool.kind === 'shell') {
    const command = event.operation.command || '';
    target = command.slice(0, 300);
    verdict = evaluateCommand(policy, command, { cwd: event.cwd });
    if (verdict.decision === 'allow') {
      verdict =
        evaluateBashProtected(command, { home: aosHome(), cwd: event.cwd }) ||
        planGateBashVerdict(project.id, command, session);
      if (!verdict) return ALLOW;
    }
  } else if (event.tool.kind === 'file') {
    const targets = absoluteTargets(event);
    const contents = event.operation.contents || [];
    const repoRoot = repoRootFor(project, event.cwd);
    // Multi-path writes (Codex apply_patch): the first non-allow verdict
    // wins — one gated path gates the whole patch.
    for (let i = 0; i < targets.length; i++) {
      const abs = canonicalPath(targets[i]);
      let v = evaluateFileWrite(policy, abs, contents[i] || '', {
        home: canonicalPath(aosHome()),
        repoRoot,
      });
      if (v.decision === 'allow') {
        v =
          planGateVerdict(project.id, abs, session) ||
          (policy.scope_gate === false ? null : scopeGateVerdict(project.id, abs, session, repoRoot));
        if (!v) continue; // no gate fired for this path
      }
      if (v.decision !== 'allow') {
        verdict = v;
        target = abs;
        break;
      }
    }
    if (!verdict) return ALLOW;
  } else {
    return ALLOW;
  }

  let decision = fromVerdict(verdict);

  // Dry run: record what the gate WOULD have done and let the tool through.
  if (policy.dry_run === true) {
    appendAudit(project.id, {
      event: 'gate',
      dry_run: true,
      decision: decision.effect === 'require_approval' ? 'ask' : decision.effect,
      action: decision.rule,
      tool: event.tool.name,
      command: target,
      session,
      provider: event.provider,
      tool_kind: event.tool.kind,
      mode: event.permissionMode || undefined,
    });
    return ALLOW;
  }

  // The human is about to see a permission prompt for a sign-off command —
  // approving the prompt IS the sign-off (providers with native ask only).
  // Ordering is load-bearing: below the dry_run return, as before.
  if (
    decision.effect === 'require_approval' &&
    adapter.capabilities.ask &&
    SIGNOFF_ACTIONS.has(decision.rule) &&
    promptReachesHuman(event)
  ) {
    recordSignoffTicket(project.id, {
      action: decision.rule,
      command: target,
      session,
      mode: event.permissionMode || null,
    });
  }

  // Providers that cannot ask: convert require_approval into deny + an
  // external approval the human grants outside the agent. `aos approve`
  // itself is terminal-only there — an agent approving its own unlock is
  // exactly the loop the outside-the-agent rule exists to break.
  if (decision.effect === 'require_approval' && !adapter.capabilities.ask) {
    if (decision.rule === 'aos-approve') {
      const denyDecision = deny(
        'aos-approve',
        'Approving an AOS decision is reserved for the human. Run the `aos approve …` command shown in the earlier denial message in your own terminal — not through the agent.'
      );
      auditGate(project.id, denyDecision, event, target);
      return denyDecision;
    }
    const pending = createPendingDecision(project.id, {
      provider: event.provider,
      session,
      action: decision.rule,
      rule: decision.rule,
      reason: decision.reason,
      fingerprint: operationFingerprint(event),
      tool: event.tool.name,
    });
    const converted = deny(
      decision.rule,
      decision.reason +
        `\n\nBlocked pending human approval. A human can approve this exact operation with:\n` +
        `  aos approve ${pending.id}\n` +
        `After approval, retry the same operation — it will be allowed once (the approval is single-use and expires).`
    );
    auditGate(project.id, converted, event, target, { approval: pending.id });
    return converted;
  }

  // An approval the human already granted unlocks this exact operation once.
  // Checked after evaluation (a deny-tier verdict can never be unlocked) and
  // only for ask-tier decisions.
  if (decision.effect === 'require_approval') {
    const approval = consumeApproval(project.id, operationFingerprint(event));
    if (approval) {
      const unlocked = { effect: 'allow', rule: decision.rule, approval: approval.id };
      appendAudit(project.id, {
        event: 'gate',
        decision: 'ask',
        action: decision.rule,
        tool: event.tool.name,
        command: target,
        session,
        provider: event.provider,
        tool_kind: event.tool.kind,
        approval: approval.id,
        mode: event.permissionMode || undefined,
      });
      return unlocked;
    }
  }

  auditGate(project.id, decision, event, target);
  return decision;
}

function auditGate(projectId, decision, event, target, extra = {}) {
  appendAudit(projectId, {
    event: 'gate',
    decision: decision.effect === 'require_approval' ? 'ask' : decision.effect,
    action: decision.rule,
    tool: event.tool.name,
    command: target,
    session: event.session || null,
    provider: event.provider,
    tool_kind: event.tool.kind,
    mode: event.permissionMode || undefined,
    ...extra,
  });
}

// ── tool.after ────────────────────────────────────────────────────────────

export function handleToolAfter(event, adapter) {
  const project = resolveProject(event);
  if (!project) return;
  const session = event.session || null;

  // The shell call that ran `aos run start` just completed inside this
  // session: bind the new active run to it, with the session's usage so far
  // as its token baseline (providers whose transcripts we can't parse yet
  // bind with no baseline — token accounting stays honest at zero).
  if (event.tool.kind === 'shell' && session) {
    const command = event.operation.command || '';
    if (command.includes('aos') && /\brun\s+start\b/.test(command)) {
      const active = getActiveRun(project.id);
      if (active) {
        const baseline =
          adapter.capabilities.tokens && event.transcriptPath
            ? sumTranscriptUsage(event.transcriptPath)
            : null;
        bindRunSession(project.id, active, session, baseline);
      }
    } else if (command.includes('aos') && /\brun\s+finish\b/.test(command)) {
      const bound = findRunBySession(project.id, session);
      if (bound && FINISHED_STATES.has(bound.state) && adapter.capabilities.tokens && event.transcriptPath) {
        const meta = settleRunTokens(project.id, bound.run, sumTranscriptUsage(event.transcriptPath), session);
        if (meta) stampRunCost(project.id, bound.run, meta);
      }
    }
  }

  appendAudit(project.id, {
    event: 'tool',
    tool: event.tool.name,
    tool_kind: event.tool.kind,
    summary: adapter.summarize(event),
    session,
    provider: event.provider,
    // Multi-path writes (apply_patch) record every target so touchedFiles
    // reconstructs the change exactly; single-path events keep the summary.
    ...(event.tool.kind === 'file' && (event.operation.paths?.length || 0) > 1
      ? { paths: event.operation.paths.slice(0, 50) }
      : {}),
  });
}

// ── session lifecycle ─────────────────────────────────────────────────────

export function handleSessionStart(event) {
  const project = resolveProject(event);
  if (!project) return null;
  appendAudit(project.id, { event: 'session-start', session: event.session || null, provider: event.provider });
  return { context: buildContext(project.id, project.name) };
}

export function handleSessionEnd(event, adapter) {
  const input = resolveProject(event);
  if (!input) return;
  const project = input;
  const session = event.session || null;
  const usage =
    adapter.capabilities.tokens && event.transcriptPath
      ? sumTranscriptUsage(event.transcriptPath)
      : { input: 0, output: 0, cache_read: 0, models: {} };

  const policy = loadPolicy(project.id);
  let learningsOwed = false;
  let memoryWrite = false;
  if (policy.learnings_capture !== false && session) {
    const act = sessionMemoryActivity(project.id, session);
    learningsOwed = act.substantive && !act.memoryWrite;
    memoryWrite = act.memoryWrite;
  }
  appendLineRotated(
    sessionsPath(project.id),
    JSON.stringify({
      ts: nowIso(),
      session,
      provider: event.provider,
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_tokens: usage.cache_read,
      models: Object.keys(usage.models || {}).length ? usage.models : undefined,
      learnings_owed: learningsOwed || undefined,
      memory_write: memoryWrite || undefined,
    })
  );
  if (learningsOwed) {
    appendAudit(project.id, { event: 'learnings-owed', session, provider: event.provider });
  }

  // Attribute tokens to the run this session belongs to (same precedence as
  // the Claude path: the active run when it's ours, else the bound run).
  let target = null;
  const active = getActiveRun(project.id);
  if (active) {
    const bound = runMeta(project.id, active)?.session;
    if (!bound || !session || bound === session) target = active;
  }
  if (!target) target = findRunBySession(project.id, session)?.run || null;
  if (target) settleRunTokens(project.id, target, usage, session);
  appendAudit(project.id, { event: 'session-end', session, provider: event.provider });
}

// ── stop ──────────────────────────────────────────────────────────────────
//
// The two debts a session can owe at the end of a turn (review-close,
// learnings), blocking at most once each per session — provider-neutral via
// the audit trail. Loop guards are per provider: Claude's stop_hook_active,
// Cursor's loop_count; Codex relies on the once-per-session nudge audit.

export function handleStop(event) {
  // Never block twice in a row: a stubborn model would otherwise loop.
  if (event.stop_hook_active) return { asks: [] };
  if (Number.isFinite(event.loop_count) && event.loop_count > 0) return { asks: [] };

  const project = resolveProject(event);
  if (!project) return { asks: [] };
  const policy = loadPolicy(project.id);
  if (policy.review_capture === false && policy.learnings_capture === false) return { asks: [] };
  const act = sessionMemoryActivity(project.id, event.session || null);
  if (!act.bound) return { asks: [] };
  const finished = !['in-progress', 'blocked'].includes(act.bound.state);

  const asks = [];
  const events = [];

  if (policy.review_capture !== false && act.bound.state === 'awaiting-review' && !act.reviewNudged) {
    asks.push(
      `Run ${act.bound.run} is sitting at awaiting-review, and you are the last one here who ` +
        `knows what it did. Close it out now rather than leaving it in the queue:\n` +
        `  1. Summarize for the human, in a few lines: what changed, what the contracts ` +
        `reported, and what the adversarial review found (runs/${act.bound.run}/review.json).\n` +
        `  2. State your recommendation — done (merged/complete) or shipped (released) — ` +
        `or say plainly if it should go back to in-progress.\n` +
        `  3. Run \`aos run state done --run ${act.bound.run}\` (or shipped). You will hit a ` +
        `permission prompt: that prompt IS the human's sign-off, so do not try to route ` +
        `around it, and do not pass --force.\n` +
        `If the human declines or does not answer, leave the run as it is and stop — ` +
        `you won't be asked again this session.`
    );
    events.push({ event: 'review-nudge', run: act.bound.run });
  }

  if (policy.learnings_capture !== false && finished && !act.memoryWrite && !act.nudged) {
    asks.push(
      `Run ${act.bound.run} finished but nothing was recorded to learnings.md this session. ` +
        `Distill 1-3 concrete, actionable learnings from this session and append them to ` +
        `${path.join(projectDir(project.id), 'learnings.md')} (significant choices go to ` +
        `context/decisions.md in the decision format). If genuinely nothing is worth ` +
        `recording, say so and stop — you won't be asked again.`
    );
    events.push({ event: 'learnings-nudge', run: act.bound.run });
  }

  if (!asks.length) return { asks: [] };
  for (const e of events) appendAudit(project.id, { ...e, session: event.session || null, provider: event.provider });
  return { asks };
}
