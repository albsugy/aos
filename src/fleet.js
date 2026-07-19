import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { aosHome, ensureDir } from './paths.js';
import { loadRegistry } from './registry.js';

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets');

// Supported runtimes, in auto-pick preference order. Binary names come only
// from this table — never from user input — so detection/launch is
// injection-safe by construction.
const RUNTIMES = [
  { name: 'claude', bin: 'claude', label: 'Claude Code' },
  { name: 'codex', bin: 'codex', label: 'Codex CLI' },
  { name: 'opencode', bin: 'opencode', label: 'opencode' },
  { name: 'droid', bin: 'droid', label: 'Factory Droid' },
];

export function fleetDir() {
  return path.join(aosHome(), 'fleet');
}

function onPath(bin) {
  try {
    return spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

function routingTable() {
  const projects = loadRegistry().projects;
  if (!projects.length) {
    return '(no projects registered yet — run `aos init` inside each repo, then refresh this table from `aos projects`)';
  }
  const rows = projects.map((p) => `| "${p.name}" | \`${p.id}\` | ${(p.repos || [])[0] || ''} |`);
  return ['| Say | Project id | Repo |', '|---|---|---|', ...rows].join('\n');
}

// Scaffold ~/.aos/fleet: the orchestration hub is FILES, not a runtime — an
// AGENTS.md (cross-runtime standard) with the routing table generated from the
// registry, a CLAUDE.md import shim for Claude Code, and a reports/ folder for
// crewmate transcripts. Existing files are never overwritten: the hub is meant
// to be tuned by its operator (and by the hub agent itself).
export function scaffoldFleet() {
  const dir = fleetDir();
  ensureDir(path.join(dir, 'reports'));
  const created = [];
  const agents = path.join(dir, 'AGENTS.md');
  if (!fs.existsSync(agents)) {
    const tpl = fs.readFileSync(path.join(ASSETS, 'templates', 'fleet-agents.md'), 'utf8');
    fs.writeFileSync(agents, tpl.replace('{{ROUTING_TABLE}}', routingTable()));
    created.push('AGENTS.md');
  }
  const shim = path.join(dir, 'CLAUDE.md');
  if (!fs.existsSync(shim)) {
    fs.writeFileSync(shim, '@AGENTS.md\n');
    created.push('CLAUDE.md');
  }
  return { dir, created };
}

// Default mode: scaffold and tell the operator how to start — AOS never
// executes agents by default; agents execute AOS.
export function fleetScaffold() {
  const { dir, created } = scaffoldFleet();
  if (created.length) console.log(`✔ Fleet hub scaffolded at ${dir} (${created.join(', ')})`);
  else console.log(`✔ Fleet hub at ${dir}`);
  console.log('  Start your primary agent there with any runtime:');
  for (const rt of RUNTIMES) {
    console.log(`    cd ${dir} && ${rt.bin.padEnd(9)} # ${rt.label}${onPath(rt.bin) ? ' ✓ installed' : ''}`);
  }
  console.log(`  Or launch directly:  aos fleet --launch [${RUNTIMES.map((r) => r.name).join('|')}]`);
  return true;
}

// Explicit convenience: spawn the chosen (or first installed) runtime in the
// hub, stdio inherited, exit status passed through. No process management
// beyond that — anything more would be session orchestration, which is out of
// AOS's scope by design.
export function fleetLaunch(name) {
  const { dir } = scaffoldFleet();
  const supported = RUNTIMES.map((r) => r.name).join(', ');
  let rt;
  if (typeof name === 'string') {
    rt = RUNTIMES.find((r) => r.name === name);
    if (!rt) {
      console.error(`Unknown runtime "${name}". aos fleet --launch supports: ${supported}`);
      return false;
    }
    if (!onPath(rt.bin)) {
      console.error(`${rt.bin} not found on PATH. Start manually with: cd ${dir} && ${rt.bin}`);
      return false;
    }
  } else {
    rt = RUNTIMES.find((r) => onPath(r.bin));
    if (!rt) {
      console.error(`No supported runtime found on PATH (${supported}). Install one, then: cd ${dir} && <runtime>`);
      return false;
    }
  }
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error(`--launch needs an interactive terminal. Start manually with: cd ${dir} && ${rt.bin}`);
    return false;
  }
  console.log(`✔ Launching ${rt.label} in ${dir}…`);
  const res = spawnSync(rt.bin, [], { cwd: dir, stdio: 'inherit' });
  return res.status === 0;
}
