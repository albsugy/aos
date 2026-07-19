import fs from 'node:fs';
import path from 'node:path';
import { aosHome, projectDir, appendLine, nowIso } from './paths.js';
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
  if (absPath.startsWith(runDir(projectId, active) + path.sep)) return null;
  if (absPath.startsWith(projectDir(projectId) + path.sep)) return null;
  return { decision: 'ask', action: 'plan-gate', reason: planGateReason(active) };
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
    verdict = evaluateCommand(policy, command);
    if (verdict.decision === 'allow') {
      verdict =
        evaluateBashProtected(command, { home: aosHome() }) ||
        planGateBashVerdict(project.id, command, input.session_id || null);
      if (!verdict) return;
    }
  } else if (FILE_TOOLS.has(input.tool_name)) {
    const filePath = input.tool_input?.file_path || input.tool_input?.notebook_path || '';
    if (!filePath) return;
    const cwd = input.cwd || process.cwd();
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(cwd, filePath);
    const content = String(
      input.tool_input?.content || input.tool_input?.new_string || input.tool_input?.new_source || ''
    );
    target = abs;
    verdict = evaluateFileWrite(policy, abs, content, { home: aosHome(), repoRoot: cwd });
    if (verdict.decision === 'allow') {
      verdict = planGateVerdict(project.id, abs, input.session_id || null);
      if (!verdict) return;
    }
  } else {
    return;
  }

  if (verdict.decision === 'allow') return;

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
      if (bound && input.transcript_path) {
        settleRunTokens(project.id, bound.run, sumTranscriptUsage(input.transcript_path));
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
  appendLine(
    path.join(projectDir(project.id), 'sessions.jsonl'),
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
  if (target) settleRunTokens(project.id, target, usage);
  appendAudit(project.id, { event: 'session-end', session: input.session_id || null });
}

// Assisted learnings extraction, no separate model call: when the session's
// run has finished but nothing was written to learnings.md, block the stop
// ONCE and hand the extraction back to the very model that did the work —
// it still has the whole session in context. Deliberately narrow trigger
// (finished run only, once per session) so ordinary mid-conversation stops
// are never nagged; run-less sessions are covered by the SessionEnd debt
// marker instead.
export async function hookStop() {
  const input = JSON.parse(await readStdin());
  // stop_hook_active means this stop already follows a blocked stop — never
  // block again or a stubborn model loops forever.
  if (input.stop_hook_active) return;
  const project = resolveProject(input);
  if (!project) return;
  if (loadPolicy(project.id).learnings_capture === false) return;
  const act = sessionMemoryActivity(project.id, input.session_id);
  const finished = act.bound && !['in-progress', 'blocked'].includes(act.bound.state);
  if (!finished || act.memoryWrite || act.nudged) return;
  appendAudit(project.id, {
    event: 'learnings-nudge',
    run: act.bound.run,
    session: input.session_id || null,
  });
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        `Run ${act.bound.run} finished but nothing was recorded to learnings.md this session. ` +
        `Distill 1-3 concrete, actionable learnings from this session and append them to ` +
        `${path.join(projectDir(project.id), 'learnings.md')} (significant choices go to ` +
        `context/decisions.md in the decision format). If genuinely nothing is worth ` +
        `recording, say so and stop — you won't be asked again.`,
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
