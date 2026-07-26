import fs from 'node:fs';
import path from 'node:path';
import { aosHome, projectDir, appendLine, nowIso, canonicalPath } from './paths.js';
import { findProjectByCwd } from './registry.js';
import os from 'node:os';
import {
  loadPolicy,
  evaluateCommand,
  evaluateFileWrite,
  evaluateBashProtected,
  commandWritesFiles,
  commandSegments,
  stripQuoted,
} from './policy.js';
import {
  appendAudit,
  getActiveRun,
  settleRunTokens,
  bindRunSession,
  findRunBySession,
  runDir,
  runMeta,
  sessionMemoryActivity,
} from './run.js';
import { buildContext } from './context.js';
import { recordSignoffTicket } from './signoff.js';
import { sessionsPath } from './sessions.js';
import { runScope, inScope } from './scope.js';
import { stampRunCost } from './cost.js';

// Gate actions whose permission prompt doubles as a human sign-off. Kept in
// step with the `plan-approve` / `review-close` rules in the policy template.
const SIGNOFF_ACTIONS = new Set(['plan-approve', 'review-close']);

// States a run only reaches by actually finishing. `blocked` is absent on
// purpose — it is parked, not done, and can still spend more tokens.
const FINISHED_STATES = new Set(['awaiting-review', 'done', 'shipped']);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function summarizeToolInput(toolName, toolInput = {}) {
  if (toolName === 'Bash') return String(toolInput.command || '').slice(0, 300);
  if (toolInput.file_path) return toolInput.file_path;
  if (toolInput.pattern) return String(toolInput.pattern).slice(0, 120);
  if (toolInput.url) return toolInput.url;
  const keys = Object.keys(toolInput).slice(0, 3).join(',');
  return keys ? `{${keys}}` : '';
}

function resolveProject(input) {
  const cwd = input.cwd || process.cwd();
  return findProjectByCwd(cwd);
}

// The REPO root, not the session's working directory.
//
// A session opened in packages/web of a monorepo has cwd two levels below the
// repo. Slicing repo-relative paths against cwd there makes every declared
// scope entry look wrong and everything genuinely out of scope look invisible,
// and it silently stops user `protected_paths` globs (`src/**`, `.env*`) from
// matching. The registry already knows the real root — and canonicalizes it —
// so use it, and realpath the cwd so a symlinked checkout still lines up.
// Both the root and the write target are canonicalized, so the comparison
// happens in one spelling — see canonicalPath.
function repoRootFor(project, cwd) {
  const resolved = canonicalPath(cwd);
  const match = (project.repos || []).find((r) => resolved === r || resolved.startsWith(r + path.sep));
  return match || resolved;
}

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// plan_gate: ask — enforced, not remembered: until the human approves the
// plan (aos run approve), writes outside the run's own folder are gated.
// Writes to the run folder and project memory stay open so the agent can
// still produce ticket.md and plan.md.
function unapprovedPlanRun(projectId, sessionId) {
  const active = getActiveRun(projectId);
  if (!active) return null;
  const meta = runMeta(projectId, active);
  if (!meta || meta.plan_gate !== 'ask' || meta.plan_approved) return null;
  if (meta.session && sessionId && meta.session !== sessionId) return null; // another session's run
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

// Scope gate: the run's plan.md declared which files it expects to touch, and
// this write is not one of them. Self-activating — a plan with no Files section
// declares no scope and gates nothing — so it only ever fires where somebody
// wrote the list down. See scope.js.
//
// Runs regardless of plan_gate: an approved plan is exactly when scope drift
// matters, because approval is what unblocked the writes.
function scopeGateVerdict(projectId, absPath, sessionId, repoRoot) {
  const active = getActiveRun(projectId);
  if (!active || !repoRoot) return null;
  const meta = runMeta(projectId, active);
  if (!meta) return null;
  if (meta.session && sessionId && meta.session !== sessionId) return null; // another session's run
  if (absPath.startsWith(canonicalPath(runDir(projectId, active)) + path.sep)) return null;
  if (absPath.startsWith(canonicalPath(projectDir(projectId)) + path.sep)) return null;
  if (!absPath.startsWith(repoRoot + path.sep)) return null; // outside the repo entirely — not ours to judge
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

// The Bash side of the plan gate: `tee`, `> file`, `sed -i`, `git apply`
// would otherwise implement the whole change while the plan sits unapproved.
// Writes aimed at the run folder or project memory stay open (writing plan.md
// via shell is fine) — checked per pipeline segment, so chaining a repo write
// with a run-folder note doesn't exempt the repo write.
function exemptDirVariants(dir) {
  const home = os.homedir();
  const variants = [dir];
  if (dir.startsWith(home + path.sep)) {
    variants.push('~' + dir.slice(home.length), '$HOME' + dir.slice(home.length));
  }
  return variants;
}

function planGateBashVerdict(projectId, command, sessionId) {
  const active = unapprovedPlanRun(projectId, sessionId);
  if (!active) return null;
  const exempt = [
    ...exemptDirVariants(runDir(projectId, active)),
    ...exemptDirVariants(projectDir(projectId)),
  ];
  // Segment over quote-stripped text — splitting on `(` inside a quoted
  // string would otherwise strand things like "x => x*2" in their own
  // segment, where the > reads as a redirect.
  let sawSegmentWrite = false;
  for (const segment of commandSegments(stripQuoted(command))) {
    if (!commandWritesFiles(segment)) continue;
    sawSegmentWrite = true;
    if (exempt.some((d) => segment.includes(d))) continue;
    return { decision: 'ask', action: 'plan-gate', reason: planGateReason(active) };
  }
  // Interpreter one-liners span segment splits (the `(` in `open(…)` is a
  // split point), so re-check the whole command; exemption then falls back to
  // a whole-command dir mention.
  if (!sawSegmentWrite && commandWritesFiles(command) && !exempt.some((d) => command.includes(d))) {
    return { decision: 'ask', action: 'plan-gate', reason: planGateReason(active) };
  }
  return null;
}

export async function hookPreTool() {
  const input = JSON.parse(await readStdin());
  const project = resolveProject(input);
  if (!project) return; // not an AOS project — stay out of the way

  const policy = loadPolicy(project.id);
  let verdict;
  let target;

  if (input.tool_name === 'Bash') {
    const command = String(input.tool_input?.command || '');
    target = command.slice(0, 300);
    verdict = evaluateCommand(policy, command, { cwd: input.cwd || process.cwd() });
    if (verdict.decision === 'allow') {
      verdict =
        evaluateBashProtected(command, { home: aosHome(), cwd: input.cwd || process.cwd() }) ||
        planGateBashVerdict(project.id, command, input.session_id || null);
      if (!verdict) return;
    }
  } else if (FILE_TOOLS.has(input.tool_name)) {
    const filePath = input.tool_input?.file_path || input.tool_input?.notebook_path || '';
    if (!filePath) return;
    const cwd = input.cwd || process.cwd();
    const abs = canonicalPath(path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath));
    const content = String(
      input.tool_input?.content || input.tool_input?.new_string || input.tool_input?.new_source || ''
    );
    const repoRoot = repoRootFor(project, cwd);
    target = abs;
    // `home` is canonicalized to match `abs`: these are path comparisons, and
    // AOS_HOME under a symlinked /tmp would otherwise never prefix-match, which
    // would quietly switch the self-protection off. (evaluateBashProtected
    // keeps the raw spelling — it matches against command TEXT, not paths.)
    verdict = evaluateFileWrite(policy, abs, content, { home: canonicalPath(aosHome()), repoRoot });
    if (verdict.decision === 'allow') {
      verdict =
        planGateVerdict(project.id, abs, input.session_id || null) ||
        (policy.scope_gate === false
          ? null
          : scopeGateVerdict(project.id, abs, input.session_id || null, repoRoot));
      if (!verdict) return;
    }
  } else {
    return;
  }

  if (verdict.decision === 'allow') return;

  // Dry run: record what the gate WOULD have done and let the tool through.
  // The point is to let someone tune a policy against their real workflow
  // before switching it on — `aos doctor` and `aos status` both say loudly
  // that gates are recording rather than enforcing, because a forgotten
  // dry_run is a project that believes it is protected and is not.
  if (policy.dry_run === true) {
    appendAudit(project.id, {
      event: 'gate',
      dry_run: true,
      decision: verdict.decision,
      action: verdict.action,
      tool: input.tool_name,
      command: target,
      session: input.session_id || null,
    });
    return;
  }

  // The human is about to see a permission prompt for a sign-off command.
  // Approving it IS the sign-off — mint the ticket the CLI will consume, so
  // closing a run no longer requires the human to leave the session for a
  // terminal they never actually go to. See signoff.js.
  //
  // Ordering is load-bearing: this MUST stay below the dry_run return. In dry
  // run no prompt is ever shown, so a ticket minted here would be sign-off
  // nobody gave.
  if (verdict.decision === 'ask' && SIGNOFF_ACTIONS.has(verdict.action)) {
    recordSignoffTicket(project.id, {
      action: verdict.action,
      command: target,
      session: input.session_id || null,
    });
  }

  appendAudit(project.id, {
    event: 'gate',
    decision: verdict.decision,
    action: verdict.action,
    tool: input.tool_name,
    command: target,
    session: input.session_id || null,
  });

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: verdict.decision,
        permissionDecisionReason: `[aos policy] ${verdict.reason}`,
      },
    })
  );
}

export async function hookPostTool() {
  const input = JSON.parse(await readStdin());
  const project = resolveProject(input);
  if (!project) return;
  // The Bash call that ran `aos run start` just completed inside this session:
  // bind the new active run to it (with the session's usage so far as its
  // token baseline), so concurrent sessions' audit and tokens stay out of this
  // run — and the run isn't charged for tokens spent before it started.
  if (input.tool_name === 'Bash' && input.session_id) {
    const command = String(input.tool_input?.command || '');
    if (command.includes('aos') && /\brun\s+start\b/.test(command)) {
      const active = getActiveRun(project.id);
      if (active) {
        const baseline = input.transcript_path ? sumTranscriptUsage(input.transcript_path) : null;
        bindRunSession(project.id, active, input.session_id, baseline);
      }
    } else if (command.includes('aos') && /\brun\s+finish\b/.test(command)) {
      // Settle the finished run's tokens now, at its actual end — not at
      // SessionEnd, when later runs' spend would be lumped in.
      const bound = findRunBySession(project.id, input.session_id);
      // Only when the finish actually took, i.e. the run reached a FINISHED
      // state. The review gate refusing is the designed common path, and
      // settling there latches tokens_settled at a mid-work total — every token
      // spent fixing the review then vanishes and outcome.md keeps a fraction
      // of the real price. Testing `!== 'in-progress'` was not enough: a run
      // parked at `blocked` is equally unfinished, and a finish refused from
      // there froze it just the same.
      if (bound && FINISHED_STATES.has(bound.state) && input.transcript_path) {
        const meta = settleRunTokens(
          project.id,
          bound.run,
          sumTranscriptUsage(input.transcript_path),
          input.session_id
        );
        // Stamp the price tag now that the numbers are final — at `run finish`
        // time they are not, because this hook is what settles them.
        if (meta) stampRunCost(project.id, bound.run, meta);
      }
    }
  }
  appendAudit(project.id, {
    event: 'tool',
    tool: input.tool_name,
    summary: summarizeToolInput(input.tool_name, input.tool_input),
    session: input.session_id || null,
  });
}

export async function hookSessionStart() {
  const input = JSON.parse(await readStdin());
  const project = resolveProject(input);
  if (!project) return;
  appendAudit(project.id, { event: 'session-start', session: input.session_id || null });
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: buildContext(project.id, project.name),
      },
    })
  );
}

// Best-effort token accounting from the session transcript. Cache reads are
// tracked separately from fresh input: they cost ~10% of a fresh token, so
// folding them into `input` would wildly overstate spend.
//
// The legacy totals (input incl. cache writes) stay for continuity; the
// per-model `models` buckets split cache writes out (they bill at 1.25x/2x
// input, not 1x) so dollar estimates can be honest.
function sumTranscriptUsage(transcriptPath) {
  const usage = { input: 0, output: 0, cache_read: 0, models: {} };
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const u = entry?.message?.usage;
        if (!u) continue;
        usage.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        usage.output += u.output_tokens || 0;
        usage.cache_read += u.cache_read_input_tokens || 0;
        const model = entry?.message?.model;
        if (!model) continue;
        const b = (usage.models[model] = usage.models[model] || {
          input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0,
        });
        b.input += u.input_tokens || 0;
        b.output += u.output_tokens || 0;
        b.cache_read += u.cache_read_input_tokens || 0;
        const cc = u.cache_creation;
        if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
          b.cache_write_5m += cc.ephemeral_5m_input_tokens || 0;
          b.cache_write_1h += cc.ephemeral_1h_input_tokens || 0;
        } else {
          b.cache_write_5m += u.cache_creation_input_tokens || 0; // no TTL breakdown — assume 5m
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // transcript unavailable — return zeros
  }
  return usage;
}

export async function hookSessionEnd() {
  const input = JSON.parse(await readStdin());
  const project = resolveProject(input);
  if (!project) return;
  const usage = input.transcript_path
    ? sumTranscriptUsage(input.transcript_path)
    : { input: 0, output: 0, cache_read: 0, models: {} };
  // Learnings debt: a session that did substantive work but never wrote to
  // learnings.md/decisions.md loses that knowledge silently when it dies.
  // Flag it here so the next SessionStart can surface the debt (buildContext).
  // The hook can't author the learning — only the model can — so the most it
  // can do is make the loss visible instead of silent.
  const policy = loadPolicy(project.id);
  let learningsOwed = false;
  let memoryWrite = false;
  if (policy.learnings_capture !== false && input.session_id) {
    const act = sessionMemoryActivity(project.id, input.session_id);
    learningsOwed = act.substantive && !act.memoryWrite;
    memoryWrite = act.memoryWrite;
  }
  // Append-only, and deliberately re-appended on every SessionEnd (resume,
  // /clear and logout each end the same session): the sequence is what
  // buildContext reads for the learnings-debt marker. The totals here are
  // cumulative for the session, so readers must deduplicate — see sessions.js.
  appendLine(
    sessionsPath(project.id),
    JSON.stringify({
      ts: nowIso(),
      session: input.session_id || null,
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_tokens: usage.cache_read,
      // per-model buckets — what the $ estimates are computed from
      models: Object.keys(usage.models).length ? usage.models : undefined,
      learnings_owed: learningsOwed || undefined,
      // Lets buildContext treat older owed entries as addressed once a later
      // session actually wrote memory.
      memory_write: memoryWrite || undefined,
    })
  );
  if (learningsOwed) {
    appendAudit(project.id, { event: 'learnings-owed', session: input.session_id });
  }
  // Attribute tokens to the run this session belongs to. The active run wins
  // when it's ours (or unbound); otherwise fall back to the run bound to this
  // session — the standard pipeline ends with `aos run finish` INSIDE the
  // session, which clears the active pointer before SessionEnd fires, and
  // without the fallback every normally-completed run would report 0 tokens.
  // settleRunTokens subtracts the run's bind-time baseline and is once-only,
  // so a run already settled at finish is not double-counted here.
  let target = null;
  const active = getActiveRun(project.id);
  if (active) {
    const bound = runMeta(project.id, active)?.session;
    if (!bound || !input.session_id || bound === input.session_id) target = active;
  }
  if (!target) target = findRunBySession(project.id, input.session_id)?.run || null;
  if (target) settleRunTokens(project.id, target, usage, input.session_id || null);
  appendAudit(project.id, { event: 'session-end', session: input.session_id || null });
}

// Everything the pipeline owes at the end of a session, collected in-session
// while the model that did the work still has it all in context.
//
// Two debts, each blocking the stop at most once:
//
//   review-close  — the run reached awaiting-review, which is a queue with one
//                   entry and no reader. Nobody opens a dashboard tomorrow to
//                   drain it; every run this project ever finished proved that.
//                   So the close happens HERE: the agent presents what it
//                   built and what the review found, and runs the close, which
//                   the gate turns into a permission prompt. That prompt is
//                   the human sign-off (see signoff.js) — same authority as a
//                   TTY, in the place the human actually is.
//   learnings     — a finished run with nothing written to learnings.md. Only
//                   a model can author one, and this model still can.
//
// Both triggers are deliberately narrow (a bound, finished run) so ordinary
// mid-conversation stops are never nagged; run-less sessions are covered by
// the SessionEnd debt marker instead.
export async function hookStop() {
  const input = JSON.parse(await readStdin());
  // stop_hook_active means this stop already follows a blocked stop — never
  // block again or a stubborn model loops forever.
  if (input.stop_hook_active) return;
  const project = resolveProject(input);
  if (!project) return;
  const policy = loadPolicy(project.id);
  // Both asks off → skip the scan entirely. sessionMemoryActivity walks every
  // run's meta plus up to three audit logs, and this hook fires on every turn.
  if (policy.review_capture === false && policy.learnings_capture === false) return;
  const act = sessionMemoryActivity(project.id, input.session_id);
  if (!act.bound) return;
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

  if (!asks.length) return;
  for (const e of events) appendAudit(project.id, { ...e, session: input.session_id || null });
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: asks.join('\n\n'),
    })
  );
}

export async function runHook(name) {
  // A broken hook must never break the user's session: swallow everything.
  // But a swallowed pre-tool error means the gate failed OPEN — so leave a
  // trace. `aos doctor` surfaces the log; the cap keeps it from growing forever.
  try {
    if (name === 'pre-tool') await hookPreTool();
    else if (name === 'post-tool') await hookPostTool();
    else if (name === 'session-start') await hookSessionStart();
    else if (name === 'session-end') await hookSessionEnd();
    else if (name === 'stop') await hookStop();
  } catch (e) {
    try {
      const log = path.join(aosHome(), 'hook-errors.log');
      if (!fs.existsSync(log) || fs.statSync(log).size < 1_000_000) {
        appendLine(log, JSON.stringify({ ts: nowIso(), hook: name, error: String((e && e.stack) || e) }));
      }
    } catch {
      // logging must never throw either
    }
  }
  process.exit(0);
}
