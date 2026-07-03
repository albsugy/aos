import fs from 'node:fs';
import path from 'node:path';
import { projectDir, appendLine, nowIso } from './paths.js';
import { findProjectByCwd } from './registry.js';
import { loadPolicy, evaluateCommand } from './policy.js';
import { appendAudit, getActiveRun, addRunTokens } from './run.js';
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

export async function hookPreTool() {
  const input = JSON.parse(await readStdin());
  const project = resolveProject(input);
  if (!project) return; // not an AOS project — stay out of the way
  if (input.tool_name !== 'Bash') return;

  const command = input.tool_input?.command || '';
  const policy = loadPolicy(project.id);
  const verdict = evaluateCommand(policy, command);
  if (verdict.decision === 'allow') return;

  appendAudit(project.id, {
    event: 'gate',
    decision: verdict.decision,
    action: verdict.action,
    command: command.slice(0, 300),
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

// Best-effort token accounting from the session transcript.
function sumTranscriptUsage(transcriptPath) {
  const usage = { input: 0, output: 0 };
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
  const usage = input.transcript_path ? sumTranscriptUsage(input.transcript_path) : { input: 0, output: 0 };
  appendLine(
    path.join(projectDir(project.id), 'sessions.jsonl'),
    JSON.stringify({
      ts: nowIso(),
      session: input.session_id || null,
      input_tokens: usage.input,
      output_tokens: usage.output,
    })
  );
  const active = getActiveRun(project.id);
  if (active) addRunTokens(project.id, active, usage);
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
