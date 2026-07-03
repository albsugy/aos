#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { ensureHome, projectDir } from '../src/paths.js';
import { findProjectByCwd, getProject, loadRegistry } from '../src/registry.js';
import { runHook } from '../src/hooks.js';
import { init } from '../src/install.js';
import { startRun, finishRun, setRunState, getActiveRun, listRuns } from '../src/run.js';
import { verifyContracts } from '../src/verify.js';
import { printStatus } from '../src/status.js';
import { printFind } from '../src/search.js';
import { buildContext } from '../src/context.js';
import { loadPolicy } from '../src/policy.js';
import { serveConsole } from '../src/console/server.js';
import { runDoctor } from '../src/doctor.js';

const [, , cmd, ...rest] = process.argv;

const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function appVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

function requireProject(flags = {}) {
  const p = flags.project ? getProject(flags.project) : findProjectByCwd(process.cwd());
  if (!p) {
    console.error(
      'No AOS project matches this directory. Run `aos init` here first, or pass --project <id>.'
    );
    process.exit(1);
  }
  return p;
}

const HELP = `aos — Agent Operations Stack

Usage:
  aos init [--name <name>]          Register this repo as an AOS project (skills + hooks + spec)
  aos status                        All projects: runs, states, leverage ratio, tokens
  aos context [--project <id>]      Print the project context pack (what agents load)
  aos run start --ticket <id> [--title <t>]   Start a run (becomes the active run)
  aos run finish [--state <s>]      Finish active run (default state: awaiting-review)
  aos run state <state>             Set active run state (in-progress|blocked|awaiting-review|done|shipped)
  aos run list                      List runs for this project
  aos verify                        Run verification contracts from policy.yaml
  aos find <query>                  Search project memory (runs, decisions, learnings)
  aos console [--port <p>]          Serve the local console (default http://127.0.0.1:4560)
  aos doctor                        Diagnose the install, registry, and current repo's wiring
  aos hook <name>                   (internal) Claude Code hook entry points
  aos version                       Print version
  aos update                        Update aos in place (git pull + install deps)
  aos help                          This help
`;

async function main() {
  ensureHome();
  const { flags, positional } = parseFlags(rest);

  switch (cmd) {
    case 'init': {
      const { project, home } = init(process.cwd(), { name: flags.name });
      console.log(`✔ Registered project "${project.name}" (${project.id})`);
      console.log(`✔ Spec scaffolded at ${home}`);
      console.log(`✔ Skills installed to .claude/skills/ (aos-ticket, aos-verify, aos-learn, aos-ask)`);
      console.log(`✔ Hooks wired in .claude/settings.json (gate, audit, context, tokens)`);
      console.log(`\nNext: edit ${path.join(home, 'context', 'pack.md')} and policy.yaml,`);
      console.log(`then start a Claude Code session here and run /aos-ticket <ticket>.`);
      break;
    }
    case 'status':
      printStatus();
      break;
    case 'context': {
      const p = requireProject(flags);
      console.log(buildContext(p.id, p.name));
      break;
    }
    case 'run': {
      const sub = positional[0];
      const p = requireProject(flags);
      if (sub === 'start') {
        const { runId, dir } = startRun(p.id, { ticket: flags.ticket, title: flags.title });
        const policy = loadPolicy(p.id);
        console.log(`✔ Run started: ${runId}`);
        console.log(`  folder: ${dir}`);
        console.log(`  plan_gate: ${policy.plan_gate}`);
        console.log(`  files to fill: ticket.md → plan.md → (implement) → verification.md → outcome.md`);
      } else if (sub === 'finish') {
        const active = getActiveRun(p.id);
        if (!active) return console.error('No active run.');
        const meta = finishRun(p.id, active, flags.state || 'awaiting-review');
        console.log(`✔ Run ${active} → ${meta.state}`);
      } else if (sub === 'state') {
        const active = getActiveRun(p.id);
        if (!active) return console.error('No active run.');
        const meta = setRunState(p.id, active, positional[1] || 'in-progress');
        console.log(`✔ Run ${active} → ${meta.state}`);
      } else if (sub === 'list') {
        for (const r of listRuns(p.id)) {
          console.log(
            `${r.run}  [${r.state}]  verify:${r.verification}${r.ticket ? `  ${r.ticket}` : ''}`
          );
        }
      } else {
        console.log(HELP);
      }
      break;
    }
    case 'verify': {
      const p = requireProject(flags);
      const { verdict, results, adversarial_review } = verifyContracts(p.id, process.cwd());
      for (const r of results) {
        console.log(`${r.pass ? '✅' : '❌'} ${r.name}${r.required ? ' (required)' : ''} — ${r.ms}ms`);
        if (!r.pass) console.log(r.output.split('\n').slice(-15).join('\n'));
      }
      if (!results.length) console.log('No contracts configured in policy.yaml (verification.contracts).');
      console.log(`\nContract verdict: ${verdict.toUpperCase()}`);
      if (adversarial_review) {
        console.log('Adversarial review required: spawn a skeptic subagent per /aos-verify.');
      }
      process.exit(verdict === 'pass' ? 0 : 1);
      break;
    }
    case 'find': {
      const p = requireProject(flags);
      if (!positional.length) return console.error('Usage: aos find <query>');
      printFind(p.id, positional.join(' '));
      break;
    }
    case 'console': {
      const port = Number(flags.port || 4560);
      serveConsole(port);
      break;
    }
    case 'hook':
      await runHook(positional[0]);
      break;
    case 'doctor': {
      const ok = runDoctor({ appRoot: APP_ROOT, version: appVersion() });
      process.exit(ok ? 0 : 1);
      break;
    }
    case 'version':
    case '--version':
    case '-v':
      console.log(`aos ${appVersion()}`);
      break;
    case 'update': {
      if (!fs.existsSync(path.join(APP_ROOT, '.git'))) {
        console.error('This aos install is not a git checkout — reinstall with the install script.');
        process.exit(1);
      }
      const head = () => execSync('git rev-parse HEAD', { cwd: APP_ROOT, encoding: 'utf8' }).trim();
      const before = head();
      execSync('git pull --ff-only', { cwd: APP_ROOT, stdio: 'inherit' });
      const changed = head() !== before;
      const depsMissing = !fs.existsSync(path.join(APP_ROOT, 'node_modules', 'yaml'));
      if (!changed && !depsMissing) {
        console.log(`✔ aos ${appVersion()} — already up to date`);
        break;
      }
      const npmCmd = fs.existsSync(path.join(APP_ROOT, 'package-lock.json'))
        ? 'npm ci --omit=dev --no-fund --no-audit --loglevel=error'
        : 'npm install --omit=dev --no-fund --no-audit --loglevel=error';
      execSync(npmCmd, { cwd: APP_ROOT, stdio: 'inherit' });
      console.log(
        changed ? `✔ aos updated to ${appVersion()}` : `✔ dependencies restored (aos ${appVersion()})`
      );
      break;
    }
    case 'projects': {
      for (const p of loadRegistry().projects) {
        console.log(`${p.id}  ${p.repos.join(', ')}  → ${projectDir(p.id)}`);
      }
      break;
    }
    default:
      console.log(HELP);
  }
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
