import fs from 'node:fs';
import path from 'node:path';
import { ASSETS } from '../paths.js';
import { installSkillsInto } from './shared.js';

// opencode — plugin at `.opencode/plugins/aos.ts` (project-level, auto-loaded
// at startup), skills in the shared `.agents/skills/` (opencode reads it
// natively, alongside .claude/skills and .opencode/skills).
//
// The plugin script is a template: `__AOS_BIN__` is baked to the resolved
// launcher at install time (a PATH fallback is embedded in the script).

const PLUGIN_NAME = 'opencode-aos.ts';

export const opencodeInstaller = {
  id: 'opencode',
  hookEvents: ['tool.execute.before', 'tool.execute.after'],

  configPath(repoRoot) {
    return path.join(repoRoot, '.opencode', 'plugins', PLUGIN_NAME);
  },

  wireHooks(repoRoot) {
    const body = fs
      .readFileSync(path.join(ASSETS, 'agent-scripts', PLUGIN_NAME), 'utf8')
      .replaceAll('__AOS_BIN__', JSON.stringify(path.resolve(process.argv[1])));
    fs.mkdirSync(path.dirname(this.configPath(repoRoot)), { recursive: true });
    fs.writeFileSync(this.configPath(repoRoot), body);
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
    if (body.includes('__AOS_BIN__')) {
      return { ok: false, detail: 'plugin is an unbaked template — re-run aos init --agent opencode' };
    }
    return { ok: true, detail: 'plugin installed (auto-loads at opencode startup)' };
  },
};
