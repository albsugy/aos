import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureDir, ASSETS } from '../paths.js';

// Shared installer plumbing. Installers own each agent's config FILE; the
// adapters own its wire protocol. Nothing here knows policy.

// The command embedded in hooks must survive `aos update`, reinstalls to a new
// directory, and dev-checkout ↔ installed-package switches. So we embed the
// path the user invoked (usually the ~/.local/bin/aos symlink) — the stable
// launcher — NOT its realpath, which pins hooks to one physical install.
// $HOME keeps it user-portable; a PATH fallback and `|| true` make sure a
// missing aos can never break an agent session.
export function launcherCommand(cmd, { agent = null } = {}) {
  let launcher = path.resolve(process.argv[1]);
  const home = os.homedir();
  if (launcher.startsWith(home + path.sep)) {
    launcher = '$HOME' + launcher.slice(home.length);
  }
  // The path is embedded in a shell command inside agent configs; a quote or
  // dollar in the install path must not become injection. Such paths are exotic
  // (and were already broken for hooks before), but degrade safely: the PATH
  // fallback in the same command line still resolves aos.
  const safe = !/["`$\\\n]/.test(launcher);
  const quoted = `"${launcher.replace(/"/g, '')}"`;
  const flag = agent ? ` --agent ${agent}` : '';
  const invoke = safe ? quoted : 'aos';
  return `${invoke} hook ${cmd}${flag} 2>/dev/null || aos hook ${cmd}${flag} 2>/dev/null || true`;
}

export function copyDir(src, dest) {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

// Copy the AOS skills into an agent's skills directory. Replace, don't skip:
// re-running init must upgrade stale skill bodies.
export function installSkillsInto(repoRoot, skillsDir) {
  const skillsSrc = path.join(ASSETS, 'skills');
  const skillsDest = path.join(repoRoot, skillsDir);
  for (const skill of fs.readdirSync(skillsSrc)) {
    copyDir(path.join(skillsSrc, skill), path.join(skillsDest, skill));
  }
  return skillsDest;
}

// Bake an agent script template (`.pi/extensions`, `.opencode/plugins`):
// replaces `__AOS_CMD__` with a JSON argv array for invoking this install.
// [launcher] when the launcher is directly executable (shebang + exec bit —
// the normal release and dev-checkout case), [node, launcher] otherwise —
// so spaces or quotes in the install path need no shell quoting, and a
// script-only checkout still runs. The scripts embed a PATH fallback.
export function bakeAgentScript(scriptName, dest) {
  const launcher = path.resolve(process.argv[1]);
  let cmd;
  try {
    fs.accessSync(launcher, fs.constants.X_OK);
    cmd = [launcher];
  } catch {
    cmd = [process.execPath, launcher];
  }
  const body = fs
    .readFileSync(path.join(ASSETS, 'agent-scripts', scriptName), 'utf8')
    .replaceAll('__AOS_CMD__', JSON.stringify(cmd));
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, body);
  return dest;
}

// Which of the agent's expected hook events are wired in a parsed
// `{hooks: {Event: [...]}}` config? Works for both group-shaped entries
// (Claude/Codex: {matcher?, hooks: [{command}]}) and flat entries
// (Cursor: {command}).
export function missingHookEvents(config, events, isOurs) {
  const missing = [];
  for (const event of events) {
    const entries = config?.hooks?.[event] || [];
    const wired = entries.some((e) =>
      (e.hooks || (e.command ? [e] : [])).some((h) => typeof h?.command === 'string' && isOurs(h.command))
    );
    if (!wired) missing.push(event);
  }
  return missing;
}
