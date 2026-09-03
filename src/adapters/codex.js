import {
  shellEvent,
  fileEvent,
  lifecycleEvent,
  codexFileOperation,
} from '../core/events.js';

// Codex — verified against the official hooks documentation
// (developers.openai.com/codex/hooks):
//
//   • PreToolUse CAN deny (`permissionDecision: "deny"`) and covers Bash and
//     `apply_patch` (file edits), so AOS gates + audit are real enforcement.
//   • `permissionDecision: "ask"` is PARSED BUT NOT SUPPORTED — a hook that
//     returns it is treated as failed and the call proceeds. So an AOS
//     `require_approval` decision must become deny + an external approval
//     (`aos approve`), never a native prompt, and never a silent allow.
//   • SessionStart supports `additionalContext`; Stop supports
//     `{continue: false, stopReason}` — the same nudges Claude gets.
//   • Hooks must be trusted in the CLI (`/hooks`) before they run; the
//     installer prints that warning.
//
// Codex file edits arrive as an `apply_patch` command; we parse it into
// per-path writes so the same file gates apply (see core/events.js).

export const codexAdapter = {
  id: 'codex',
  label: 'Codex',
  capabilities: { context: true, audit: true, deny: true, ask: false, writes: true, tokens: false },

  hookCommands: {
    PreToolUse: 'pre-tool',
    PostToolUse: 'post-tool',
    SessionStart: 'session-start',
    SessionEnd: 'session-end',
    Stop: 'stop',
  },

  toEvent(hook, payload) {
    const p = payload || {};
    switch (hook) {
      case 'pre-tool':
      case 'post-tool': {
        const name = String(p.tool_name || '');
        const input = p.tool_input || {};
        let event;
        if (name === 'Bash') {
          event = shellEvent('codex', p, name);
        } else if (name === 'apply_patch') {
          const op = codexFileOperation(String(input.command || ''));
          if (!op.paths.length) return null;
          event = fileEvent('codex', p, name, { paths: op.paths, contents: op.contents });
          event.operation.ops = op.ops; // per-file add/update/delete, for gating deletes
        } else if (hook === 'post-tool') {
          // Audit every other tool call (MCP, update_plan, …) — Codex's
          // PostToolUse covers all local function tools.
          event = lifecycleEvent('codex', p, 'tool.after');
          event.tool = { kind: 'other', name };
          event.otherInput = input;
        } else {
          return null;
        }
        event.event = hook === 'pre-tool' ? 'tool.before' : 'tool.after';
        return event;
      }
      case 'session-start':
        return lifecycleEvent('codex', p, 'session.start');
      case 'session-end':
        return lifecycleEvent('codex', p, 'session.end');
      case 'stop':
        return lifecycleEvent('codex', p, 'stop');
      default:
        return null;
    }
  },

  summarize(event) {
    const cap = (s, n) => {
      const t = String(s || '');
      return t.length > n ? t.slice(0, n) : t;
    };
    if (event.tool?.kind === 'shell') return cap(event.operation.command, 300);
    if (event.tool?.kind === 'file') return cap((event.operation.paths || []).join(' '), 300);
    const keys = Object.keys(event.otherInput || {}).slice(0, 3).join(',');
    return keys ? `{${keys}}` : '';
  },

  respond(hook, decision) {
    if (hook === 'session-start') {
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: decision.context },
      });
    }
    if (hook === 'stop') {
      if (!decision.asks?.length) return '';
      // Codex Stop contract: continue:false ends the turn; stopReason is fed
      // back. Same effect as Claude's `{decision: "block"}`.
      return JSON.stringify({ continue: false, stopReason: decision.asks.join('\n\n') });
    }
    if (decision.effect === 'allow') return '';
    // `ask` is not supported by Codex's PreToolUse — the pipeline converts
    // require_approval into deny + a pending external approval before we get
    // here, so a genuine `ask` reaching this branch would be a bug. Fail
    // closed rather than emit a decision Codex treats as a failed hook
    // (which would let the call through).
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[aos policy] ${decision.reason}`,
      },
    });
  },
};
