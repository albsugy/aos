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
  const home = os.homedir();
  const absolute = path.resolve(process.argv[1]);
  // Injection safety applies to the PHYSICAL install path — the $HOME/ prefix
  // substituted below is our own literal, not user input, so its '$' is not a
  // metacharacter risk. (Testing the substituted string instead degraded every
  // under-$HOME install — the common case — to a bare `aos` with no absolute
  // launcher, silently off wherever aos is not on PATH.)
  const unsafe = /["`$\\\n]/.test(absolute);
  let launcher;
  if (unsafe) {
    // Exotic path with real metacharacters: don't embed it. The PATH fallback
    // in the same command line carries the hook.
    launcher = 'aos';
  } else if (absolute.startsWith(home + path.sep)) {
    launcher = '$HOME' + absolute.slice(home.length);
  } else {
    launcher = absolute;
  }
  const flag = agent ? ` --agent ${agent}` : '';
  return `"${launcher}" hook ${cmd}${flag} 2>/dev/null || aos hook ${cmd}${flag} 2>/dev/null || true`;
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

// Pull the baked argv out of a pi/opencode script. JSON.parse, never eval —
// a tampered script must not execute as part of doctor.
export function extractBakedArgv(body) {
  const m = /const AOS_CMD = (\[[\s\S]*?\]);/.exec(String(body || ''));
  if (!m) return null;
  try {
    const argv = JSON.parse(m[1]);
    if (!Array.isArray(argv) || !argv.length || argv.some((x) => typeof x !== 'string')) return null;
    return argv;
  } catch {
    return null;
  }
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
