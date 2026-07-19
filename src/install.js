import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { addProject } from './registry.js';
import { projectDir, ensureDir, readJson, writeJson, slugify } from './paths.js';
import { detectRepo } from './detect.js';

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

// Inject detected contracts into the freshly-scaffolded policy without losing
// the template's comments. Parsing as a Document keeps everything outside the
// `contracts:` value, but replacing the `[]` node drops the comment block
// attached to it — so carry that comment over to the new seq explicitly.
function injectContracts(policyText, contracts) {
  const doc = YAML.parseDocument(policyText);
  // setIn() with a plain JS value stores it raw (no node until stringify), so
  // build the node first to have something to attach the comment to.
  const prev = doc.getIn(['verification', 'contracts'], true);
  const node = doc.createNode(contracts);
  if (prev?.commentBefore) node.commentBefore = prev.commentBefore;
  doc.setIn(['verification', 'contracts'], node);
  return String(doc);
}

function scaffoldProjectHome(id, repoRoot) {
  const dir = projectDir(id);
  ensureDir(path.join(dir, 'context'));
  ensureDir(path.join(dir, 'runs'));
  ensureDir(path.join(dir, 'playbooks'));

  // Best-effort: a repo we can't read just yields the blank templates.
  let detection = { pack: null, contracts: [], summary: null };
  try {
    detection = detectRepo(repoRoot);
  } catch {
    detection = { pack: null, contracts: [], summary: null };
  }

  // Files that only get a static template.
  for (const [from, to] of [
    ['templates/decisions.md', 'context/decisions.md'],
    ['templates/learnings.md', 'learnings.md'],
  ]) {
    const dest = path.join(dir, to);
    if (!fs.existsSync(dest)) fs.copyFileSync(path.join(ASSETS, from), dest);
  }

  // pack.md: a repo-specific draft when we have signal, else the blank template.
  const packDest = path.join(dir, 'context', 'pack.md');
  if (!fs.existsSync(packDest)) {
    if (detection.pack) fs.writeFileSync(packDest, detection.pack);
    else fs.copyFileSync(path.join(ASSETS, 'templates/pack.md'), packDest);
  }

  // policy.yaml: template + any detected verification contracts.
  const policyDest = path.join(dir, 'policy.yaml');
  if (!fs.existsSync(policyDest)) {
    let policyText = fs.readFileSync(path.join(ASSETS, 'templates/policy.yaml'), 'utf8');
    if (detection.contracts.length) {
      try {
        policyText = injectContracts(policyText, detection.contracts);
      } catch {
        // fall back to the untouched template — contracts stay empty
      }
    }
    fs.writeFileSync(policyDest, policyText);
  }

  return { dir, detection };
}

function installSkills(repoRoot) {
  const skillsSrc = path.join(ASSETS, 'skills');
  const skillsDest = path.join(repoRoot, '.claude', 'skills');
  for (const skill of fs.readdirSync(skillsSrc)) {
    copyDir(path.join(skillsSrc, skill), path.join(skillsDest, skill));
  }
}

const HOOK_DEFS = [
  // File tools are gated too: protected paths, script-content scanning, and
  // plan-gate enforcement all hang off pre-tool.
  { event: 'PreToolUse', matcher: 'Bash|Write|Edit|MultiEdit|NotebookEdit', cmd: 'hook pre-tool' },
  { event: 'PostToolUse', matcher: null, cmd: 'hook post-tool' },
  { event: 'SessionStart', matcher: null, cmd: 'hook session-start' },
  { event: 'SessionEnd', matcher: null, cmd: 'hook session-end' },
  // Learnings extraction happens in-session: Stop blocks once when a finished
  // run recorded no learnings, so the model that did the work writes them
  // while it still has the context.
  { event: 'Stop', matcher: null, cmd: 'hook stop' },
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
  const { dir, detection } = scaffoldProjectHome(id, resolved);
  installSkills(resolved);
  installHooks(resolved);
  return { project, home: dir, detection };
}
