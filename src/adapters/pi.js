import {
  shellEvent,
  fileEvent,
  lifecycleEvent,
} from '../core/events.js';

// pi (@earendil-works/pi-coding-agent) — enforcement via a project extension
// (`.pi/extensions/pi-aos.ts`, installed by AOS). pi's extension API fires
// `tool_call` before execution and honors `{ block: true, reason }`, which is
// a real deny. It has no native "ask" concept for tool calls, so gated
// operations go through the external-approval flow (`aos approve`).
//
// The payload shape is defined by the extension AOS ships (we control both
// sides); it mirrors the Claude shape so this adapter stays a thin translator:
//   { session_id, cwd, tool_name: "Bash"|"Write"|"Edit", tool_input: {...} }
//
// Skills: pi reads `.agents/skills/` natively (Agent Skills standard) plus
// `.pi/skills/` — the installer uses the shared `.agents/skills/`.

const FILE_TOOLS = new Set(['Write', 'Edit']);

export const piAdapter = {
  id: 'pi',
  label: 'pi',
  capabilities: { context: true, audit: true, deny: true, ask: false, writes: true, tokens: false },

  hookCommands: {
    'tool_call': 'pre-tool',
    'tool_execution_end': 'post-tool',
    'before_agent_start': 'session-start',
    'session_shutdown': 'session-end',
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
          event = shellEvent('pi', p, name);
        } else if (FILE_TOOLS.has(name)) {
          const filePath = input.file_path || input.path || '';
          if (!filePath) return null;
          event = fileEvent('pi', p, name, {
            paths: [String(filePath)],
            contents: [String(input.content || '')],
          });
        } else if (hook === 'post-tool') {
          event = lifecycleEvent('pi', p, 'tool.after');
          event.tool = { kind: 'other', name };
          event.otherInput = input;
        } else {
          return null;
        }
        event.event = hook === 'pre-tool' ? 'tool.before' : 'tool.after';
        return event;
      }
      case 'session-start':
        return lifecycleEvent('pi', p, 'session.start');
      case 'session-end':
        return lifecycleEvent('pi', p, 'session.end');
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
      // Consumed by the extension as a one-shot injected message.
      return JSON.stringify({
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: decision.context },
      });
    }
    if (decision.effect === 'allow') return '';
    // The pipeline converts require_approval into deny + external approval
    // before adapters see it (pi cannot ask); fail closed on a stray ask.
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[aos policy] ${decision.reason}`,
      },
    });
  },
};
