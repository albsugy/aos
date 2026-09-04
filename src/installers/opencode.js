import path from 'node:path';
import fs from 'node:fs';
import { installSkillsInto, bakeAgentScript } from './shared.js';

// opencode — plugin at `.opencode/plugins/opencode-aos.ts` (project-level, auto-loaded
// at startup), skills in the shared `.agents/skills/` (opencode reads it
// natively, alongside .claude/skills and .opencode/skills).
//
// The plugin script is a template: `__AOS_CMD__` is baked to a JSON argv array
// at install time (a PATH fallback is embedded in the script).

const PLUGIN_NAME = 'opencode-aos.ts';

export const opencodeInstaller = {
  id: 'opencode',
  hookEvents: ['tool.execute.before', 'tool.execute.after'],

  configPath(repoRoot) {
    return path.join(repoRoot, '.opencode', 'plugins', PLUGIN_NAME);
  },

  wireHooks(repoRoot) {
    bakeAgentScript(PLUGIN_NAME, this.configPath(repoRoot));
  },

  installSkills(repoRoot) {
    return installSkillsInto(repoRoot, path.join('.agents', 'skills'));
  },

  verify(repoRoot) {
    const file = this.configPath(repoRoot);
    let body;
    try {
      body = fs.readFileSync(file, 'utf8');
    } catch {
      return { ok: false, detail: `.opencode/plugins/${PLUGIN_NAME} missing — re-run aos init --agent opencode` };
    }
    if (body.includes('__AOS_CMD__')) {
      return { ok: false, detail: 'plugin is an unbaked template — re-run aos init --agent opencode' };
    }
    return { ok: true, detail: 'plugin installed (auto-loads at opencode startup)' };
  },
};
