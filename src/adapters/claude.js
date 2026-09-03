import {
  shellEvent,
  fileEvent,
  lifecycleEvent,
} from '../core/events.js';

// Claude Code — the reference adapter. Its hook protocol is the one the
// others converged on (Codex accepts the same `hookSpecificOutput` shapes;
// Cursor accepts both this and its native flat form), so this file doubles
// as the template for new adapters: translate payload → event, decision →
// response. No policy logic lives here.

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export const claudeAdapter = {
  id: 'claude',
  label: 'Claude Code',
  // What the provider's hook surface can actually enforce. `ask` means a
  // decision can surface a NATIVE permission prompt to the human; providers
  // without it fall back to AOS external approvals (decisions.js).
  capabilities: { context: true, audit: true, deny: true, ask: true, writes: true, tokens: true },

  // Claude hook name → internal command name used by the installer.
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
          event = shellEvent('claude', p, name);
        } else if (FILE_TOOLS.has(name)) {
          const filePath = input.file_path || input.notebook_path || '';
          if (!filePath) return null;
          event = fileEvent('claude', p, name, {
            paths: [String(filePath)],
            contents: [String(input.content || input.new_string || input.new_source || '')],
          });
        } else if (hook === 'post-tool') {
          // Post-hoc audit of every other tool call — same evidence as before
          // the refactor. Pre-tool stays null for them: nothing to gate.
          event = lifecycleEvent('claude', p, 'tool.after');
          event.tool = { kind: 'other', name };
          event.otherInput = input;
        } else {
          return null;
        }
        event.event = hook === 'pre-tool' ? 'tool.before' : 'tool.after';
        event.transcriptPath = p.transcript_path || event.transcriptPath;
        return event;
      }
      case 'session-start':
        return lifecycleEvent('claude', p, 'session.start');
      case 'session-end':
        return lifecycleEvent('claude', p, 'session.end');
      case 'stop':
        return { ...lifecycleEvent('claude', p, 'stop'), stop_hook_active: Boolean(p.stop_hook_active) };
      default:
        return null;
    }
  },

  // A human-readable one-liner for the audit trail, derived from the
  // normalized operation (same output the old Claude-specific summarizer
  // produced, so existing audit readers keep working).
  summarize(event) {
    const cap = (s, n) => {
      const t = String(s || '');
      return t.length > n ? t.slice(0, n) : t;
    };
    if (event.tool?.kind === 'shell') return cap(event.operation.command, 300);
    if (event.tool?.kind === 'file') {
      const p = event.operation.paths?.[0];
      if (p) return cap(p, 300);
      return '';
    }
    // other tools: the old summarizeToolInput fallbacks
    const input = event.otherInput || {};
    if (input.pattern) return cap(input.pattern, 120);
    if (input.url) return cap(input.url, 300);
    const keys = Object.keys(input).slice(0, 3).join(',');
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
      return JSON.stringify({ decision: 'block', reason: decision.asks.join('\n\n') });
    }
    // pre-tool: allow stays silent, exactly as before.
    if (decision.effect === 'allow') return '';
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: decision.effect === 'deny' ? 'deny' : 'ask',
        permissionDecisionReason: `[aos policy] ${decision.reason}`,
      },
    });
  },
};
