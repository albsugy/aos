import path from 'node:path';
import { installSkillsInto } from './shared.js';

// Devin CLI — workflow compatibility only, honestly. Devin has no local hook
// surface (its docs' extensibility is AGENTS.md + skills), so there is
// nothing to enforce through: AOS gives it the generated context file and the
// skills (`.agents/skills/<name>/SKILL.md` is Devin's documented location),
// and Git/CI gates remain the boundary. Never described as enforced.

export const devinInstaller = {
  id: 'devin',
  hookEvents: [],

  configPath() {
    return null; // no hook wiring exists for Devin
  },

  wireHooks() {
    // no-op: recorded by the catalog as hooks:false
  },

  installSkills(repoRoot) {
    return installSkillsInto(repoRoot, path.join('.agents', 'skills'));
  },

  verify() {
    return {
      ok: true,
      detail: 'workflow compatibility: context + skills only, no tool-call enforcement (Devin CLI has no hook surface)',
    };
  },
};
