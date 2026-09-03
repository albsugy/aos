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
  const adapter = getAdapter(agent) || getAdapter('claude');
  let out = '';
  try {
    if (HOOKS.has(name)) {
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
          out = adapter.respond(name, decision);
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
        appendLine(log, JSON.stringify({ ts: nowIso(), hook: name, agent, error: String((e && e.stack) || e) }));
      }
    } catch {
      // logging must never throw either
    }
  }
  process.exit(0);
}
