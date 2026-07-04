import fs from 'node:fs';
import path from 'node:path';
import { aosHome, projectDir, appendLine, nowIso } from './paths.js';
import { findProjectByCwd } from './registry.js';
import { loadPolicy, evaluateCommand, evaluateFileWrite } from './policy.js';
import { appendAudit, getActiveRun, addRunTokens, bindRunSession, runDir, runMeta } from './run.js';
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
// plan (aos run approve), file writes outside the run's own folder are gated.
// Writes to the run folder and project memory stay open so the agent can
// still produce ticket.md and plan.md.
function planGateVerdict(projectId, absPath, sessionId) {
  const active = getActiveRun(projectId);
  if (!active) return null;
  const meta = runMeta(projectId, active);
  if (!meta || meta.plan_gate !== 'ask' || meta.plan_approved) return null;
  if (meta.session && sessionId && meta.session !== sessionId) return null; // another session's run
  if (absPath.startsWith(runDir(projectId, active) + path.sep)) return null;
  if (absPath.startsWith(projectDir(projectId) + path.sep)) return null;
  return {
    decision: 'ask',
    action: 'plan-gate',
    reason: `Plan for run ${active} is not approved yet — review plan.md, then run \`aos run approve\` (or approve this prompt to allow this single write)`,
  };
}

export async function hookPreTool() {
  const input = JSON.parse(await readStdin());
  const project = resolveProject(input);
  if (!project) return; // not an AOS project — stay out of the way

  const policy = loadPolicy(project.id);
  let verdict;
  let target;

  if (input.tool_name === 'Bash') {
    target = String(input.tool_input?.command || '').slice(0, 300);
    verdict = evaluateCommand(policy, input.tool_input?.command || '');
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
  // bind the new active run to it, so concurrent sessions' audit and tokens
  // stay out of this run from here on.
  if (input.tool_name === 'Bash' && input.session_id) {
    const command = String(input.tool_input?.command || '');
    if (command.includes('aos') && /\brun\s+start\b/.test(command)) {
      const active = getActiveRun(project.id);
      if (active) bindRunSession(project.id, active, input.session_id);
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
function sumTranscriptUsage(transcriptPath) {
  const usage = { input: 0, output: 0, cache_read: 0 };
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const u = entry?.message?.usage;
        if (u) {
          usage.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          usage.output += u.output_tokens || 0;
          usage.cache_read += u.cache_read_input_tokens || 0;
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
    : { input: 0, output: 0, cache_read: 0 };
  appendLine(
    path.join(projectDir(project.id), 'sessions.jsonl'),
    JSON.stringify({
      ts: nowIso(),
      session: input.session_id || null,
      input_tokens: usage.input,
      output_tokens: usage.output,
      cache_read_tokens: usage.cache_read,
    })
  );
  const active = getActiveRun(project.id);
  if (active) {
    // Only attribute this session's tokens to the run it is bound to.
    const bound = runMeta(project.id, active)?.session;
    if (!bound || !input.session_id || bound === input.session_id) {
      addRunTokens(project.id, active, usage);
    }
  }
  appendAudit(project.id, { event: 'session-end', session: input.session_id || null });
}

export async function runHook(name) {
  // A broken hook must never break the user's session: swallow everything.
  try {
    if (name === 'pre-tool') await hookPreTool();
    else if (name === 'post-tool') await hookPostTool();
    else if (name === 'session-start') await hookSessionStart();
    else if (name === 'session-end') await hookSessionEnd();
  } catch {
    // intentionally silent
  }
  process.exit(0);
}
