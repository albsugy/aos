import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, readJson, writeJson } from '../paths.js';
import { launcherCommand, installSkillsInto } from './shared.js';

// Codex — hooks in .codex/hooks.json (project layer), skills in .agents/skills
// (the cross-agent convention Codex scans from cwd up to the repo root).
//
// Config shape and semantics verified against developers.openai.com/codex/hooks:
//   { "description": …, "hooks": { "PreToolUse": [ { "matcher": "^Bash$|^apply_patch$",
//       "hooks": [ { "type": "command", "command": …, "timeout": 30 } ] } ] } }
//
// Two Codex-specific realities the installer respects:
//   • Hooks must be TRUSTED in the CLI (`/hooks`) before they run — init prints
//     that warning; verify() cannot check trust state, only wiring.
//   • SessionEnd hooks get 1s by default (3s max) — our SessionEnd is fast for
//     Codex (no transcript parsing), and the timeout is pinned at 3.

const HOOK_DEFS = [
  { event: 'PreToolUse', matcher: '^(Bash|apply_patch)$', cmd: 'pre-tool', timeout: 30 },
  // PostToolUse without a matcher: audit every tool call (MCP, plan updates),
  // not just shell/patch — the adapter classifies and the pipeline records.
  { event: 'PostToolUse', matcher: null, cmd: 'post-tool', timeout: 10 },
  { event: 'SessionStart', matcher: null, cmd: 'session-start', timeout: 10 },
  { event: 'SessionEnd', matcher: null, cmd: 'session-end', timeout: 3 },
  { event: 'Stop', matcher: null, cmd: 'stop', timeout: 30 },
];

const EVENTS = HOOK_DEFS.map((d) => d.event);

// Our entries are identified by the command text: `hook <name> --agent codex`.
function isAosGroup(group) {
  return (group?.hooks || []).some(
    (h) => typeof h?.command === 'string' && /\baos\b.*\bhook\s+\S+\s+--agent\s+codex/.test(h.command)
  );
}

export const codexInstaller = {
  id: 'codex',
  hookEvents: EVENTS,

  configPath(repoRoot) {
    return path.join(repoRoot, '.codex', 'hooks.json');
  },

  wireHooks(repoRoot) {
    const file = this.configPath(repoRoot);
    const config = readJson(file, null) || {};
    const hooks = config.hooks || {};

    for (const def of HOOK_DEFS) {
      const groups = (hooks[def.event] || []).filter((g) => !isAosGroup(g));
      groups.push({
        matcher: def.matcher || undefined,
        hooks: [
          {
            type: 'command',
            command: launcherCommand(def.cmd, { agent: 'codex' }),
            timeout: def.timeout,
            statusMessage: `AOS ${def.event}`,
          },
        ],
      });
      hooks[def.event] = groups;
    }
    config.description = 'AOS — policy gates, audit, context, approvals';
    config.hooks = hooks;
    ensureDir(path.dirname(file));
    writeJson(file, config);
  },

  installSkills(repoRoot) {
    // Codex scans .agents/skills from cwd up to the repo root (official docs);
    // it is also the emerging cross-agent location, so other tools benefit.
    return installSkillsInto(repoRoot, path.join('.agents', 'skills'));
  },

  verify(repoRoot) {
    const config = readJson(this.configPath(repoRoot), null);
    if (!config?.hooks) return { ok: false, detail: '.codex/hooks.json missing — re-run aos init --agent codex' };
    const missing = EVENTS.filter(
      (ev) => !(config.hooks[ev] || []).some((g) => (g.hooks || []).some((h) => typeof h?.command === 'string' && /\baos\b.*\bhook\s+\S+\s+--agent\s+codex/.test(h.command)))
    );
    if (missing.length) return { ok: false, detail: `missing hook events: ${missing.join(', ')} — re-run aos init --agent codex` };
    // Trust is Codex-side state we cannot read from here; remind rather than fail.
    return { ok: true, detail: `${EVENTS.length} events wired (hooks must also be trusted: run /hooks in Codex once)` };
  },
};
