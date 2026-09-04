import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { addProject, findProjectByCwd } from './registry.js';
import { projectDir, ensureDir, readJson, writeJson, slugify, ASSETS } from './paths.js';
import { detectRepo } from './detect.js';
import { AGENT_CATALOG, detectAgents, parseAgentFlag } from './agents.js';
import { syncContextFiles } from './context-sync.js';

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
    else fs.copyFileSync(path.join(ASSETS, 'templates', 'pack.md'), packDest);
  }

  // policy.yaml: template + any detected verification contracts.
  const policyDest = path.join(dir, 'policy.yaml');
  if (!fs.existsSync(policyDest)) {
    let policyText = fs.readFileSync(path.join(ASSETS, 'templates', 'policy.yaml'), 'utf8');
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

// Which agents an init wires. Precedence: the explicit flag (auto detects), an
// existing registration (re-init keeps the project's agents unless told
// otherwise), then the Claude default that preserves the historical behavior.
export function resolveAgents(repoRoot, agentFlagValue) {
  const parsed = parseAgentFlag(agentFlagValue);
  if (parsed?.mode === 'auto') {
    const detected = detectAgents(repoRoot);
    return detected.length ? detected : ['claude'];
  }
  if (parsed?.mode === 'set') return parsed.agents;
  // No flag: keep whatever this repo's project already uses. Resolved by cwd,
  // not by a guessed id — a project registered with --name must not fork into
  // a basename-id duplicate on re-init.
  const existing = findProjectByCwd(repoRoot);
  if (existing?.agents?.length) return existing.agents;
  return ['claude'];
}

// `hooksOnly` installs the layer that works without anyone invoking anything:
// context injection, gates, audit, token accounting. The project home is still
// scaffolded — policy.yaml IS the gate and pack.md IS the context, so there is
// no hooks-only install without them. Only the pipeline skills are skipped.
export function init(repoRoot, { name, hooksOnly = false, agent = null } = {}) {
  const resolved = path.resolve(repoRoot);
  // Re-init targets the project already registered for this repo (by cwd);
  // only a genuinely new registration derives the id from the directory name.
  const registered = findProjectByCwd(resolved);
  const id = slugify(name || registered?.name || path.basename(resolved));
  const agents = resolveAgents(resolved, agent);
  const project = addProject({ id, name: name || path.basename(resolved), repo: resolved, agents });
  const { dir, detection } = scaffoldProjectHome(id, resolved);

  const wired = [];
  for (const agentId of agents) {
    const entry = AGENT_CATALOG[agentId];
    if (!entry) continue;
    if (!entry.installer) {
      wired.push({ id: agentId, label: entry.label, hooks: false, configPath: null, skills: null, notes: entry.notes });
      continue;
    }
    entry.installer.wireHooks(resolved);
    const skillsDir = hooksOnly ? null : entry.installer.installSkills(resolved);
    const configPath = entry.installer.configPath(resolved);
    wired.push({
      id: agentId,
      label: entry.label,
      // hooks:false for installers that only deliver skills/context (Devin)
      hooks: Boolean(configPath),
      configPath,
      skills: skillsDir,
      notes: entry.notes,
    });
  }

  // Derived context files for file-reading agents (Claude gets native
  // SessionStart injection; AGENTS.md/GEMINI.md carry the same memory to the
  // rest). Foreign files are reported, never clobbered.
  const contextReports = syncContextFiles(id, project.name, resolved, agents);

  return { project, home: dir, detection, hooksOnly, agents: wired, contextReports };
}
