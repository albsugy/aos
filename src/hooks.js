import fs from 'node:fs';
import path from 'node:path';
import { aosHome, appendLine, nowIso } from './paths.js';
import { getAdapter } from './adapters/index.js';
import {
  handleToolBefore,
  handleToolAfter,
  handleSessionStart,
  handleSessionEnd,
  handleStop,
} from './core/pipeline.js';

// ── The hook dispatcher ──────────────────────────────────────────────────
//
// Historically this file WAS the gate: Claude payload parsing, policy
// evaluation, and Claude response formatting in one place. The
// provider-neutral refactor moved the policy into src/core/pipeline.js (which
// speaks only normalized events) and the protocol into src/adapters/*. This
// file is now deliberately boring: read stdin, pick the adapter, dispatch,
// print the adapter's response.

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const HOOKS = new Set(['pre-tool', 'post-tool', 'session-start', 'session-end', 'stop']);

export async function runHook(name, { agent = 'claude' } = {}) {
  const id = agent || 'claude';
  const adapter = getAdapter(id);
  let out = '';
  try {
    if (!adapter) {
      try {
        const log = path.join(aosHome(), 'hook-errors.log');
        if (!fs.existsSync(log) || fs.statSync(log).size < 1_000_000) {
          appendLine(log, JSON.stringify({ ts: nowIso(), hook: name, agent: id, error: `unknown agent "${id}"` }));
        }
      } catch {
        /* logging must never throw */
      }
      if (name === 'pre-tool') {
        // Union deny: Cursor reads `permission`, Claude/Codex read
        // hookSpecificOutput.permissionDecision. Unknown agents must not
        // inherit Claude's native-ask shape (Codex treats ask as fail-open).
        out = JSON.stringify({
          permission: 'deny',
          user_message: `[aos] unknown agent "${id}" — hook refused`,
          agent_message: `unknown agent "${id}"`,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `[aos] unknown agent "${id}" — hook refused`,
          },
        });
      }
    } else if (HOOKS.has(name)) {
      const raw = await readStdin();
      if (raw.trim()) {
        const payload = JSON.parse(raw);
        const event = adapter.toEvent(name, payload);
        if (event) {
          let decision;
          if (name === 'pre-tool') decision = handleToolBefore(event, adapter);
          else if (name === 'post-tool') {
            handleToolAfter(event, adapter);
            decision = { effect: 'allow' };
          } else if (name === 'session-start') decision = handleSessionStart(event);
          else if (name === 'session-end') {
            handleSessionEnd(event, adapter);
            decision = { effect: 'allow' };
          } else decision = handleStop(event);
          // A null decision means "nothing to say" (e.g. not an AOS project):
          // stay silent rather than crash into hook-errors.log — old behavior.
          out = decision ? adapter.respond(name, decision) : '';
        }
      }
    }
    if (out) process.stdout.write(out);
  } catch (e) {
    // A broken hook must never break the user's session: swallow everything.
    // But a swallowed pre-tool error means the gate failed OPEN — so leave a
    // trace. `aos doctor` surfaces the log; the cap keeps it from growing forever.
    try {
      const log = path.join(aosHome(), 'hook-errors.log');
      if (!fs.existsSync(log) || fs.statSync(log).size < 1_000_000) {
        appendLine(log, JSON.stringify({ ts: nowIso(), hook: name, agent: id, error: String((e && e.stack) || e) }));
      }
    } catch {
      // logging must never throw either
    }
  }
  process.exit(0);
}
