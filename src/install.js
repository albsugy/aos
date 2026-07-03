import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addProject } from './registry.js';
import { projectDir, ensureDir, readJson, writeJson, slugify } from './paths.js';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

function aosBinPath() {
  // Resolve the real bin location even when invoked through a global symlink,
  // so hooks keep working regardless of PATH in the hook environment.
  try {
    return fs.realpathSync(process.argv[1]);
  } catch {
    return process.argv[1];
  }
}

function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function scaffoldProjectHome(id) {
  const dir = projectDir(id);
  ensureDir(path.join(dir, 'context'));
  ensureDir(path.join(dir, 'runs'));
  ensureDir(path.join(dir, 'playbooks'));
  const copies = [
    ['templates/policy.yaml', 'policy.yaml'],
    ['templates/pack.md', 'context/pack.md'],
    ['templates/decisions.md', 'context/decisions.md'],
    ['templates/learnings.md', 'learnings.md'],
  ];
  for (const [from, to] of copies) {
    const dest = path.join(dir, to);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(ASSETS, from), dest);
  }
  return dir;
}

function installSkills(repoRoot) {
  const skillsSrc = path.join(ASSETS, 'skills');
  const skillsDest = path.join(repoRoot, '.claude', 'skills');
  for (const skill of fs.readdirSync(skillsSrc)) {
    copyDir(path.join(skillsSrc, skill), path.join(skillsDest, skill));
  }
}

const HOOK_DEFS = [
  { event: 'PreToolUse', matcher: 'Bash', cmd: 'hook pre-tool' },
  { event: 'PostToolUse', matcher: null, cmd: 'hook post-tool' },
  { event: 'SessionStart', matcher: null, cmd: 'hook session-start' },
  { event: 'SessionEnd', matcher: null, cmd: 'hook session-end' },
];

function installHooks(repoRoot) {
  const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
  const settings = readJson(settingsPath, {}) || {};
  settings.hooks = settings.hooks || {};
  const bin = aosBinPath();

  for (const def of HOOK_DEFS) {
    const command = `node "${bin}" ${def.cmd}`;
    const entries = settings.hooks[def.event] || [];
    // Idempotent: skip if an aos hook is already registered for this event.
    const already = entries.some((e) =>
      (e.hooks || []).some(
        (h) => typeof h.command === 'string' && h.command.includes('aos') && h.command.endsWith(def.cmd)
      )
    );
    if (already) continue;
    const entry = { hooks: [{ type: 'command', command }] };
    if (def.matcher) entry.matcher = def.matcher;
    entries.push(entry);
    settings.hooks[def.event] = entries;
  }
  writeJson(settingsPath, settings);
}

export function init(repoRoot, { name } = {}) {
  const resolved = path.resolve(repoRoot);
  const id = slugify(name || path.basename(resolved));
  const project = addProject({ id, name: name || path.basename(resolved), repo: resolved });
  const home = scaffoldProjectHome(id);
  installSkills(resolved);
  installHooks(resolved);
  return { project, home };
}
