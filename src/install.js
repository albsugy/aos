import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addProject } from './registry.js';
import { projectDir, ensureDir, readJson, writeJson, slugify } from './paths.js';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

// The command embedded in hooks must survive `aos update`, reinstalls to a new
// directory, and dev-checkout ↔ installed-package switches. So we embed the
// path the user invoked (usually the ~/.local/bin/aos symlink) — the stable
// launcher — NOT its realpath, which pins hooks to one physical install.
// $HOME keeps it user-portable; a PATH fallback and `|| true` make sure a
// missing aos can never break a Claude Code session.
function launcherCommand(cmd) {
  let launcher = path.resolve(process.argv[1]);
  const home = os.homedir();
  if (launcher.startsWith(home + path.sep)) {
    launcher = '$HOME' + launcher.slice(home.length);
  }
  return `"${launcher}" ${cmd} 2>/dev/null || aos ${cmd} 2>/dev/null || true`;
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

function isAosHook(h) {
  return (
    typeof h.command === 'string' &&
    h.command.includes('aos') &&
    HOOK_DEFS.some((d) => h.command.includes(d.cmd))
  );
}

function installHooks(repoRoot) {
  const settingsPath = path.join(repoRoot, '.claude', 'settings.json');
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
