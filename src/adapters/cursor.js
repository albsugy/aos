import {
  shellEvent,
  fileEvent,
  lifecycleEvent,
} from '../core/events.js';

// Cursor — verified against the official hooks documentation
// (cursor.com/docs → Hooks):
//
//   • `preToolUse` fires for every tool (Shell, Write, Edit, MCP, Task) with a
//     Claude-like `{tool_name, tool_input, tool_use_id, cwd}` payload, and can
//     deny via `{"permission": "deny", ...}` (or exit code 2).
//   • `"ask"` is accepted by the schema but NOT enforced for preToolUse — so,
//     like Codex, an AOS require_approval becomes deny + `aos approve`.
//   • `sessionStart` output is `{additional_context}` (fire-and-forget);
//     `stop` output is `{followup_message}` — an auto-submitted follow-up,
//     Cursor's equivalent of Claude's Stop block. `loop_count` guards loops.
//   • Project hooks live in `.cursor/hooks.json` and run from the project root.
//
// Session identity: every hook carries `conversation_id` in the common schema;
// `session_id` only exists on sessionStart. Normalize to conversation_id.

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function cursorPayload(p) {
  // conversation_id is the stable per-conversation id; session_id appears on
  // sessionStart. Prefer session_id there, conversation_id everywhere.
  return { ...p, session: p.session_id || p.conversation_id || null };
}

export const cursorAdapter = {
  id: 'cursor',
  label: 'Cursor',
  capabilities: { context: true, audit: true, deny: true, ask: false, writes: true, tokens: false },

  hookCommands: {
    preToolUse: 'pre-tool',
    postToolUse: 'post-tool',
    sessionStart: 'session-start',
    sessionEnd: 'session-end',
    stop: 'stop',
  },

  toEvent(hook, payload) {
    const p = cursorPayload(payload || {});
    const cwd = p.cwd || (Array.isArray(p.workspace_roots) ? p.workspace_roots[0] : null) || process.cwd();
    const base = { ...p, cwd };
    switch (hook) {
      case 'pre-tool':
      case 'post-tool': {
        const name = String(p.tool_name || '');
        const input = p.tool_input || {};
        let event;
        if (name === 'Shell' || name === 'Bash') {
          event = shellEvent('cursor', base, name);
        } else if (FILE_TOOLS.has(name)) {
          const filePath = input.file_path || input.path || '';
          if (!filePath) return null;
          event = fileEvent('cursor', base, name, {
            paths: [String(filePath)],
            contents: [String(input.content || input.new_string || '')],
          });
        } else if (hook === 'post-tool') {
          event = lifecycleEvent('cursor', base, 'tool.after');
          event.tool = { kind: 'other', name };
          event.otherInput = input;
        } else {
          return null;
        }
        event.event = hook === 'pre-tool' ? 'tool.before' : 'tool.after';
        return event;
      }
      case 'session-start':
        return lifecycleEvent('cursor', base, 'session.start');
      case 'session-end':
        return lifecycleEvent('cursor', base, 'session.end');
      case 'stop':
        return {
          ...lifecycleEvent('cursor', base, 'stop'),
          loop_count: Number(p.loop_count || 0),
        };
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
    if (event.tool?.kind === 'file') return cap(event.operation.paths?.[0], 300);
    const keys = Object.keys(event.otherInput || {}).slice(0, 3).join(',');
    return keys ? `{${keys}}` : '';
  },

  respond(hook, decision) {
    if (hook === 'session-start') {
      // Fire-and-forget context injection, per the Cursor contract.
      return JSON.stringify({ additional_context: decision.context });
    }
    if (hook === 'stop') {
      if (!decision.asks?.length) return '';
      // A non-empty followup_message is auto-submitted as the next user
      // message — the loop_count guard in the pipeline caps repetition.
      return JSON.stringify({ followup_message: decision.asks.join('\n\n') });
    }
    if (decision.effect === 'allow') return '';
    if (decision.effect === 'ask') {
      // preToolUse does not enforce "ask"; the pipeline converts
      // require_approval before adapters see it, so treat a stray ask as a
      // deny (fail closed — a hook error would fail OPEN in Cursor).
      return JSON.stringify({
        permission: 'deny',
        user_message: `[aos policy] ${decision.reason}`,
        agent_message: decision.reason,
      });
    }
    return JSON.stringify({
      permission: 'deny',
      user_message: `[aos policy] ${decision.reason}`,
      agent_message: decision.reason,
    });
  },
};
