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

export function loadRegistry() {
  const raw = readIfExists(registryPath());
  if (!raw) return { projects: [] };
  const data = YAML.parse(raw);
  if (!data || !Array.isArray(data.projects)) return { projects: [] };
  return data;
}

export function saveRegistry(reg) {
  ensureHome();
  fs.writeFileSync(registryPath(), YAML.stringify(reg));
}

export function addProject({ id, name, repo }) {
  const reg = loadRegistry();
  let project = reg.projects.find((p) => p.id === id);
  if (!project) {
    project = { id, name: name || id, repos: [], created: nowIso() };
    reg.projects.push(project);
  }
  const resolved = canonical(repo);
  if (!project.repos.includes(resolved)) project.repos.push(resolved);
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
