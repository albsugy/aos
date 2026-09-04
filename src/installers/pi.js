import path from 'node:path';
import fs from 'node:fs';
import { installSkillsInto, bakeAgentScript } from './shared.js';

// pi — extension at `.pi/extensions/pi-aos.ts` (project-local, loads after the
// project is trusted in pi; deliberately not global so the gate is per-repo
// by construction), skills in the shared `.agents/skills/` (pi reads the
// Agent Skills standard locations natively).
//
// The extension script is a template: `__AOS_CMD__` is baked to a JSON argv array
// at install time (a PATH fallback is embedded in the script).

const EXTENSION_NAME = 'pi-aos.ts';

export const piInstaller = {
  id: 'pi',
  hookEvents: ['tool_call', 'before_agent_start', 'session_shutdown'],

  configPath(repoRoot) {
    return path.join(repoRoot, '.pi', 'extensions', EXTENSION_NAME);
  },

  wireHooks(repoRoot) {
    bakeAgentScript(EXTENSION_NAME, this.configPath(repoRoot));
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
      return { ok: false, detail: `.pi/extensions/${EXTENSION_NAME} missing — re-run aos init --agent pi` };
    }
    if (body.includes('__AOS_CMD__')) {
      return { ok: false, detail: 'extension is an unbaked template — re-run aos init --agent pi' };
    }
    return { ok: true, detail: 'extension installed (loads once pi trusts the project)' };
  },
};
