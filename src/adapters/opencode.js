import {
  shellEvent,
  fileEvent,
  lifecycleEvent,
} from '../core/events.js';

// opencode (sst/opencode) — enforcement via a project plugin
// (`.opencode/plugins/aos.ts`, installed by AOS). opencode's plugin API fires
// `tool.execute.before` with the tool's args; throwing from the hook aborts
// the call with the error fed to the agent — a real deny. No native ask, so
// gated operations go through the external-approval flow (`aos approve`).
//
// The payload shape is defined by the plugin AOS ships (we control both
// sides); it mirrors the Claude shape so this adapter stays a thin translator:
//   { session_id, cwd, tool_name: "Bash"|"Write"|"Edit", tool_input: {...} }
//
// Skills: opencode reads `.agents/skills/` and `.claude/skills/` natively —
// the installer uses the shared `.agents/skills/`.
// Context: opencode reads AGENTS.md natively — the generated context file.

const FILE_TOOLS = new Set(['Write', 'Edit']);

export const opencodeAdapter = {
  id: 'opencode',
  label: 'opencode',
  capabilities: { context: 'file', audit: true, deny: true, ask: false, writes: true, tokens: false },

  hookCommands: {
    'tool.execute.before': 'pre-tool',
    'tool.execute.after': 'post-tool',
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
          event = shellEvent('opencode', p, name);
        } else if (FILE_TOOLS.has(name)) {
          // the plugin normalizes opencode's {filePath, content|newString}
          // into the claude-like {file_path, content} before calling aos
          const filePath = input.file_path || input.path || '';
          if (!filePath) return null;
          event = fileEvent('opencode', p, name, {
            paths: [String(filePath)],
            contents: [String(input.content || '')],
          });
        } else if (hook === 'post-tool') {
          event = lifecycleEvent('opencode', p, 'tool.after');
          event.tool = { kind: 'other', name };
          event.otherInput = input;
        } else {
          return null;
        }
        event.event = hook === 'pre-tool' ? 'tool.before' : 'tool.after';
        return event;
      }
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
    if (decision.effect === 'allow') return '';
    // opencode blocks by THROWING in the plugin; the plugin reads this JSON
    // and throws the reason. ask never reaches here (external-approval flow).
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `[aos policy] ${decision.reason}`,
      },
    });
  },
};
