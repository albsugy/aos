import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeInstaller } from './installers/claude.js';
import { codexInstaller } from './installers/codex.js';
import { cursorInstaller } from './installers/cursor.js';
import { piInstaller } from './installers/pi.js';
import { opencodeInstaller } from './installers/opencode.js';
import { devinInstaller } from './installers/devin.js';

// ── The agent catalog ────────────────────────────────────────────────────
//
// One entry per supported coding agent, describing only FACTS about its hook
// surface (verified against each vendor's docs — see the adapters). The
// capability matrix is honest on purpose: an agent that cannot intercept tool
// calls is workflow-compatible, not enforced, and `aos doctor --capabilities`
// says exactly that.

export const AGENT_CATALOG = {
  claude: {
    id: 'claude',
    label: 'Claude Code',
    installer: claudeInstaller,
    // Native SessionStart context injection → no generated context file needed.
    contextFile: null,
    homeMarkers: ['.claude', '.claude.json'],
    notes: [],
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    installer: codexInstaller,
    // No context-injection hook output contract beyond SessionStart
    // additionalContext — which we DO use. AGENTS.md is the durable file.
    contextFile: 'AGENTS.md',
    homeMarkers: ['.codex'],
    notes: [
      'Codex requires hooks to be reviewed and trusted before they run: open codex and run /hooks, then trust the AOS entries.',
      'Codex cannot surface a native ask prompt; gated operations are denied pending a human `aos approve`.',
    ],
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor',
    installer: cursorInstaller,
    contextFile: 'AGENTS.md', // Cursor reads AGENTS.md natively
    homeMarkers: ['.cursor'],
    repoMarkers: ['.cursor'],
    notes: [
      'Cursor preToolUse cannot enforce "ask"; gated operations are denied pending a human `aos approve`.',
    ],
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    installer: null, // no hook surface — context-file workflow compatibility only
    contextFile: 'GEMINI.md',
    homeMarkers: ['.gemini'],
    notes: [
      'Workflow compatibility only: context via GEMINI.md. Tool-call enforcement is not possible through Gemini CLI today — Git/CI gates remain the boundary.',
    ],
  },
  pi: {
    id: 'pi',
    label: 'pi',
    installer: piInstaller,
    // Context is injected natively via the extension (before_agent_start).
    contextFile: null,
    homeMarkers: ['.pi'],
    notes: [
      'The gate extension loads once pi trusts the project (project-local .pi/extensions/).',
      'pi cannot ask from a tool hook — gated operations are denied pending a human `aos approve`.',
    ],
  },
  opencode: {
    id: 'opencode',
    label: 'opencode',
    installer: opencodeInstaller,
    contextFile: 'AGENTS.md', // opencode reads AGENTS.md natively
    homeMarkers: ['.config/opencode', '.opencode'],
    notes: [
      'The gate plugin auto-loads at opencode startup from .opencode/plugins/.',
      'opencode plugins block by throwing — gated operations are denied pending a human `aos approve`.',
    ],
  },
  devin: {
    id: 'devin',
    label: 'Devin CLI',
    installer: devinInstaller, // skills only — no hook surface
    contextFile: 'AGENTS.md', // Devin reads AGENTS.md natively
    homeMarkers: ['.devin'],
    notes: [
      'Workflow compatibility only: context via AGENTS.md and skills via .agents/skills. Tool-call enforcement is not possible through the Devin CLI today — Git/CI gates remain the boundary.',
    ],
  },
};

export const INSTALLABLE_AGENTS = ['claude', 'codex', 'cursor', 'pi', 'opencode', 'devin', 'gemini'];

export function isInstallableAgent(id) {
  return INSTALLABLE_AGENTS.includes(id);
}

// `--agent` accepts: one id, a comma list, `all`, or `auto` (detect).
export function parseAgentFlag(value) {
  if (!value) return null;
  const v = String(value).toLowerCase().trim();
  if (v === 'auto') return { mode: 'auto' };
  if (v === 'all') return { mode: 'set', agents: [...INSTALLABLE_AGENTS] };
  const ids = v.split(',').map((s) => s.trim()).filter(Boolean);
  const bad = ids.filter((id) => !isInstallableAgent(id));
  if (bad.length) {
    throw new Error(`Unknown agent(s): ${bad.join(', ')}. One of: ${INSTALLABLE_AGENTS.join(', ')} (or auto / all).`);
  }
  return { mode: 'set', agents: [...new Set(ids)] };
}

// Detection for `--agent auto`: which agents look installed on this machine?
// Home markers are the honest signal (~/.claude, ~/.codex, ~/.cursor); a repo
// marker (.cursor/ directory) catches agent configs checked into the project.
export function detectAgents(repoRoot, { home = os.homedir() } = {}) {
  const found = [];
  for (const agent of Object.values(AGENT_CATALOG)) {
    const homeHit = (agent.homeMarkers || []).some((m) => fs.existsSync(path.join(home, m)));
    const repoHit = (agent.repoMarkers || []).some((m) => fs.existsSync(path.join(repoRoot, m)));
    if (homeHit || repoHit) found.push(agent.id);
  }
  return found;
}

// The enforcement level the matrix reports — never oversold.
export function enforcementLevel(id) {
  switch (id) {
    case 'claude':
      return { level: 'full', label: 'full enforcement (native hooks + ask)' };
    case 'codex':
    case 'cursor':
      return { level: 'full', label: 'full enforcement (hooks; approvals via aos approve)' };
    case 'pi':
      return { level: 'full', label: 'full enforcement (extension; approvals via aos approve)' };
    case 'opencode':
      return { level: 'full', label: 'full enforcement (plugin; approvals via aos approve)' };
    default:
      return { level: 'workflow', label: 'workflow compatibility (context + skills; no tool-call enforcement)' };
  }
}
