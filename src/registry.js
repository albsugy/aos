import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { registryPath, ensureHome, readIfExists, nowIso } from './paths.js';

// Resolve symlinks so paths compare canonically (macOS /var vs /private/var).
function canonical(p) {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

// strict: throw on a corrupt registry instead of treating it as empty.
// Writers must use strict so a parse failure can never clobber user data.
export function loadRegistry({ strict = false } = {}) {
  const raw = readIfExists(registryPath());
  if (!raw) return { projects: [] };
  let data;
  try {
    data = YAML.parse(raw);
  } catch (e) {
    if (strict) {
      throw new Error(
        `registry.yaml is corrupt (${e.message}). Fix or remove ${registryPath()} — refusing to overwrite it.`
      );
    }
    console.error(`[aos] warning: registry.yaml is corrupt — treating as empty (${registryPath()})`);
    return { projects: [] };
  }
  if (!data || !Array.isArray(data.projects)) return { projects: [] };
  return data;
}

export function saveRegistry(reg) {
  ensureHome();
  fs.writeFileSync(registryPath(), YAML.stringify(reg));
}

export function addProject({ id, name, repo, agents = null }) {
  const reg = loadRegistry({ strict: true });
  let project = reg.projects.find((p) => p.id === id);
  if (!project) {
    project = { id, name: name || id, repos: [], created: nowIso() };
    reg.projects.push(project);
  }
  const resolved = canonical(repo);
  if (!project.repos.includes(resolved)) project.repos.push(resolved);
  // Which coding agents this project is wired for (claude/codex/cursor/…).
  // Merged, never replaced: re-running `aos init --agent codex` ADDS codex
  // rather than silently uninstalling the claude wiring that's already there.
  if (Array.isArray(agents) && agents.length) {
    project.agents = [...new Set([...(project.agents || []), ...agents])];
  }
  saveRegistry(reg);
  return project;
}

// Longest-prefix match so nested repos resolve to the most specific project.
export function findProjectByCwd(cwd) {
  const reg = loadRegistry();
  const resolved = canonical(cwd);
  let best = null;
  let bestLen = -1;
  for (const p of reg.projects) {
    for (const repo of p.repos || []) {
      if (resolved === repo || resolved.startsWith(repo + path.sep)) {
        if (repo.length > bestLen) {
          best = p;
          bestLen = repo.length;
        }
      }
    }
  }
  return best;
}

export function getProject(id) {
  return loadRegistry().projects.find((p) => p.id === id) || null;
}

// Unregister a project. Strict load — a corrupt registry must never be
// "cleaned" by a deletion (same contract as addProject). Returns the removed
// entry so the caller can write a receipt; throws when the id is unknown so
// a typo can never look like success. Data under projects/<id>/ is the
// caller's call — removal and deletion are separate acts on purpose.
export function removeProject(id) {
  const reg = loadRegistry({ strict: true });
  const idx = reg.projects.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`No project "${id}" is registered.`);
  const [removed] = reg.projects.splice(idx, 1);
  saveRegistry(reg);
  return removed;
}
