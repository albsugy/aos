import fs from 'node:fs';
import path from 'node:path';
import { projectDir, readJson, writeJson, nowIso } from './paths.js';

// In-session human sign-off.
//
// Requiring a TTY to close a run was right about WHO may close one and wrong
// about WHERE: the human is in the Claude Code session, not a second terminal,
// so the close needed a context switch and runs piled up at awaiting-review
// instead. The gate already stops `aos run state done` and shows the human the
// exact command, so it mints a single-use ticket when it asks and the CLI
// consumes it as sign-off.
//
// What the ticket proves: the command was gated, then it ran — a sequence that
// cannot occur without someone approving the prompt. What it does not prove:
// that no agent invoked `aos hook pre-tool` to mint one itself. That is the
// deliberately-adversarial model the hook layer already declines to cover, and
// such an agent would simply pass --force instead.
const TICKET_FILE = 'signoff.json';
// Short enough that an approval can't be banked for later, long enough to
// survive the agent narrating its summary between the prompt and the command.
const TICKET_TTL_MS = 5 * 60 * 1000;

function ticketPath(projectId) {
  return path.join(projectDir(projectId), TICKET_FILE);
}

// Called by the PreToolUse gate, at the moment it decides to ask, and by the
// external-approval unlock when a human-granted approval releases the exact
// command (`via: 'external-approval'`).
export function recordSignoffTicket(projectId, { action, command, session, mode, via = null }) {
  try {
    writeJson(ticketPath(projectId), {
      action,
      command: String(command || '').slice(0, 300),
      session: session || null,
      // The permission mode the prompt was shown under — the caller only mints
      // a ticket in modes where a prompt actually reaches a human, and this
      // records which one so the audit can be checked after the fact.
      mode: mode || null,
      // How this ticket was minted: null = the gate's own permission prompt;
      // 'external-approval' = the human granted an aos approve for exactly
      // this command. The CLI records which when consuming.
      via,
      ts: nowIso(),
    });
  } catch {
    // A ticket that can't be written just falls back to the TTY requirement —
    // never let this break the gate.
  }
}

// Single-use: the ticket is removed whether or not it matched, so a stale or
// mismatched approval can never be spent on a later command.
//
// `target` binds the ticket to the run it approves. Without it, a prompt shown
// for one run authorized closing any other run for the next five minutes — the
// gate asks about `--run A`, and a close of `--run B` inside the window spent
// that approval. An approval is for a specific thing or it is not an approval.
// A ticket whose command names no run (the active-run form, and plan approval)
// is unbound and matches whatever the caller is closing.
export function consumeSignoffTicket(projectId, action, target = null, mustInclude = null) {
  const file = ticketPath(projectId);
  const ticket = readJson(file, null);
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone (or never existed)
  }
  if (!ticket || ticket.action !== action) return null;
  const age = Date.now() - Date.parse(ticket.ts || '');
  if (!Number.isFinite(age) || age < 0 || age > TICKET_TTL_MS) return null;
  // Bind a prompt to the exact operand it named (e.g. `aos approve <id>`).
  // Without this, any in-window aos-approve ticket unlocks any decision.
  if (mustInclude && !String(ticket.command || '').includes(String(mustInclude))) return null;
  if (target) {
    const named = /--run[=\s]+(\S+)/.exec(ticket.command || '');
    if (named && named[1] !== target) return null;
  }
  return ticket;
}
