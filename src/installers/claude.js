import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from '../paths.js';
import { launcherCommand, installSkillsInto, missingHookEvents } from './shared.js';

// Claude Code — hooks in .claude/settings.json, skills in .claude/skills.
// Behavior preserved exactly from the pre-refactor installer (same events,
// same matcher, same replace-don't-skip migration semantics).

const HOOK_DEFS = [
  // File tools are gated too: protected paths, script-content scanning, and
  // plan-gate enforcement all hang off pre-tool.
  { event: 'PreToolUse', matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', cmd: 'pre-tool' },
  { event: 'PostToolUse', matcher: null, cmd: 'post-tool' },
  { event: 'SessionStart', matcher: null, cmd: 'session-start' },
  { event: 'SessionEnd', matcher: null, cmd: 'session-end' },
  // Learnings extraction happens in-session: Stop blocks once when a finished
  // run recorded no learnings, so the model that did the work writes them
  // while it still has the context.
  { event: 'Stop', matcher: null, cmd: 'stop' },
];

const EVENTS = HOOK_DEFS.map((d) => d.event);

function isAosHook(h) {
  return (
    typeof h.command === 'string' &&
    h.command.includes('aos') &&
    HOOK_DEFS.some((d) => h.command.includes(`hook ${d.cmd}`))
  );
}

export const claudeInstaller = {
  id: 'claude',
  hookEvents: EVENTS,

  configPath(repoRoot) {
    return path.join(repoRoot, '.claude', 'settings.json');
  },

  wireHooks(repoRoot) {
    const settingsPath = this.configPath(repoRoot);
    const settings = readJson(settingsPath, {}) || {};
    settings.hooks = settings.hooks || {};

    for (const def of HOOK_DEFS) {
      // Replace, don't skip: re-running init migrates stale/old-format entries
      // (e.g. hooks pinned to a previous install path) to the current launcher.
      const entries = (settings.hooks[def.event] || []).filter(
        (e) => !(e.hooks || []).some(isAosHook)
      );
      const entry = { hooks: [{ type: 'command', command: launcherCommand(def.cmd) }] };
      if (def.matcher) entry.matcher = def.matcher;
      entries.push(entry);
      settings.hooks[def.event] = entries;
    }
    writeJson(settingsPath, settings);
  },

  installSkills(repoRoot) {
    return installSkillsInto(repoRoot, path.join('.claude', 'skills'));
  },

  verify(repoRoot) {
    const settings = readJson(this.configPath(repoRoot), null);
    if (!settings?.hooks) return { ok: false, detail: '.claude/settings.json has no hooks — re-run aos init' };
    const isOurs = (cmd) => cmd.includes('aos') && HOOK_DEFS.some((d) => cmd.includes(`hook ${d.cmd}`)) && !cmd.includes('--agent');
    const missing = missingHookEvents(settings, EVENTS, isOurs);
    if (missing.length) return { ok: false, detail: `missing hook events: ${missing.join(', ')} — re-run aos init` };
    return { ok: true, detail: `${EVENTS.length} events wired` };
  },
};
