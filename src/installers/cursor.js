import path from 'node:path';
import { readJson, writeJson } from '../paths.js';
import { launcherCommand, installSkillsInto } from './shared.js';

// Cursor — hooks in .cursor/hooks.json (project level), skills in .cursor/skills.
//
// Config shape verified against cursor.com/docs → Hooks:
//   { "version": 1, "hooks": { "preToolUse": [ { "command": …, "timeout": 30 } ] } }
// Commands run from the PROJECT ROOT, so the launcher path must be absolute
// (it is — launcherCommand embeds the resolved install path).
//
// preToolUse fires for every tool and can deny; "ask" is accepted by the
// schema but NOT enforced for preToolUse — hence approvals via `aos approve`.

const HOOK_DEFS = [
  { event: 'preToolUse', cmd: 'pre-tool', timeout: 30 },
  { event: 'postToolUse', cmd: 'post-tool', timeout: 10 },
  { event: 'sessionStart', cmd: 'session-start', timeout: 10 },
  { event: 'sessionEnd', cmd: 'session-end', timeout: 5 },
  { event: 'stop', cmd: 'stop', timeout: 30 },
];

const EVENTS = HOOK_DEFS.map((d) => d.event);

function isAosEntry(entry) {
  return (
    typeof entry?.command === 'string' &&
    entry.command.includes('aos') &&
    /hook\s+\S+\s+--agent\s+cursor/.test(entry.command)
  );
}

export const cursorInstaller = {
  id: 'cursor',
  hookEvents: EVENTS,

  configPath(repoRoot) {
    return path.join(repoRoot, '.cursor', 'hooks.json');
  },

  wireHooks(repoRoot) {
    const file = this.configPath(repoRoot);
    const config = readJson(file, null) || {};
    config.version = config.version || 1;
    config.hooks = config.hooks || {};

    for (const def of HOOK_DEFS) {
      const entries = (config.hooks[def.event] || []).filter((e) => !isAosEntry(e));
      entries.push({ command: launcherCommand(def.cmd, { agent: 'cursor' }), timeout: def.timeout });
      config.hooks[def.event] = entries;
    }
    writeJson(file, config);
  },

  installSkills(repoRoot) {
    return installSkillsInto(repoRoot, path.join('.cursor', 'skills'));
  },

  verify(repoRoot) {
    const config = readJson(this.configPath(repoRoot), null);
    if (!config?.hooks) return { ok: false, detail: '.cursor/hooks.json missing — re-run aos init --agent cursor' };
    const missing = EVENTS.filter((ev) => !(config.hooks[ev] || []).some(isAosEntry));
    if (missing.length) return { ok: false, detail: `missing hook events: ${missing.join(', ')} — re-run aos init --agent cursor` };
    return { ok: true, detail: `${EVENTS.length} events wired` };
  },
};
