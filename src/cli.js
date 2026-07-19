import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { ensureHome, projectDir } from './paths.js';
import { findProjectByCwd, getProject, loadRegistry } from './registry.js';
import { runHook } from './hooks.js';
import { init } from './install.js';
import { startRun, finishRun, setRunState, getActiveRun, listRuns, approvePlan, runMeta } from './run.js';
import { verifyContracts } from './verify.js';
import { printStatus } from './status.js';
import { printFind, printFindAll } from './search.js';
import { fleetScaffold, fleetLaunch } from './fleet.js';
import { buildContext } from './context.js';
import { loadPolicy } from './policy.js';
import { serveConsole } from './console/server.js';
import { runDoctor } from './doctor.js';
import { exportAgentsMd } from './export.js';

const [, , cmd, ...rest] = process.argv;

// Works for both entry points: bin/aos.js (source) and dist/aos.mjs (bundle)
// are each one level below the app root.
const APP_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Replaced with "1" by esbuild in the compiled bundle (see scripts/build.mjs).
const IS_BUNDLED = process.env.AOS_BUNDLED === '1';

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
  aos run approve                   Approve the active run's plan (human step when plan_gate: ask)
  aos run finish [--state <s>]      Finish active run (default state: awaiting-review)
  aos run state <state> [--run <id>]  Set run state (in-progress|blocked|awaiting-review|done|shipped); --run targets a finished run (done/shipped are gated — the prompt is your sign-off)
  aos run list                      List runs for this project
  aos run session [--run <id>]      Print the Claude Code session id bound to a run (for claude --resume)
  aos verify                        Run verification contracts from policy.yaml
  aos find <query> [--all]          Search project memory; --all sweeps every project
  aos fleet [--launch [runtime]]    Scaffold ~/.aos/fleet (primary-agent hub); --launch opens it in claude|codex|opencode|droid
  aos export                        Write the context pack as AGENTS.md (for Codex/Cursor/other runtimes)
  aos console [--port <p>]          Serve the local console (default http://127.0.0.1:4560)
  aos doctor                        Diagnose the install, registry, and current repo's wiring
  aos hook <name>                   (internal) Claude Code hook entry points
  aos version                       Print version
  aos update                        Update in place (release installs: verified reinstall; dev checkouts: git pull)
  aos help                          This help
`;

async function main() {
  ensureHome();
  const { flags, positional } = parseFlags(rest);

  switch (cmd) {
    case 'init': {
      const { project, home, detection } = init(process.cwd(), { name: flags.name });
      console.log(`✔ Registered project "${project.name}" (${project.id})`);
      console.log(`✔ Spec scaffolded at ${home}`);
      if (detection?.pack) {
        console.log(`✔ Context pack drafted from the repo${detection.summary ? ` (${detection.summary})` : ''} — review and refine it`);
      } else {
        console.log(`✔ Context pack scaffolded (blank template — fill it in)`);
      }
      if (detection?.contracts?.length) {
        console.log(`✔ Seeded ${detection.contracts.length} verification contract(s): ${detection.contracts.map((c) => c.name).join(', ')}`);
      }
      console.log(`✔ Skills installed to .claude/skills/ (aos-ticket, aos-verify, aos-approve, aos-learn, aos-ask)`);
      console.log(`✔ Hooks wired in .claude/settings.json (gate, audit, context, tokens)`);
      console.log(`\nNext: review ${path.join(home, 'context', 'pack.md')} and policy.yaml,`);
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
        const policy = loadPolicy(p.id);
        const { runId, dir } = startRun(p.id, {
          ticket: flags.ticket,
          title: flags.title,
          planGate: policy.plan_gate,
        });
        console.log(`✔ Run started: ${runId}`);
        console.log(`  folder: ${dir}`);
        console.log(`  plan_gate: ${policy.plan_gate}`);
        if (policy.plan_gate === 'ask') {
          console.log(`  implementation writes stay gated until the human runs: aos run approve`);
        }
        console.log(`  files to fill: ticket.md → plan.md → (implement) → verification.md → outcome.md`);
      } else if (sub === 'approve') {
        const active = getActiveRun(p.id);
        if (!active) {
          console.error('No active run.');
          process.exitCode = 1;
          break;
        }
        approvePlan(p.id, active);
        console.log(`✔ Plan approved for ${active} — implementation writes are no longer plan-gated`);
      } else if (sub === 'finish') {
        const active = getActiveRun(p.id);
        if (!active) {
          console.error('No active run.');
          process.exitCode = 1;
          break;
        }
        const meta = finishRun(p.id, active, flags.state || 'awaiting-review');
        console.log(`✔ Run ${active} → ${meta.state}`);
        if (meta.adversarial_review === 'absent') {
          console.log(
            '⚠ No adversarial review recorded in verification.md — run /aos-verify before shipping\n' +
              '  (or set verification.adversarial_review: false in policy.yaml if intentional).'
          );
        } else if (meta.adversarial_review === 'present') {
          console.log('✔ Adversarial review recorded in verification.md');
        }
      } else if (sub === 'state') {
        // --run <id> targets any run — the review action (done/shipped) is
        // taken AFTER finish clears the active pointer, so "active only"
        // would make awaiting-review a state with no way out.
        const target = flags.run || getActiveRun(p.id);
        if (!target) {
          console.error('No active run. Target a finished one with: aos run state <state> --run <id>');
          process.exitCode = 1;
          break;
        }
        try {
          const meta = setRunState(p.id, target, positional[1] || 'in-progress');
          console.log(`✔ Run ${target} → ${meta.state}`);
        } catch (e) {
          console.error(String(e.message || e));
          process.exitCode = 1;
        }
      } else if (sub === 'session') {
        // The session bound to a run — recorded by the post-tool hook at
        // `run start`. Lets a fleet/primary agent resume the exact crewmate
        // that worked a run: claude --resume $(aos run session --run <id>)
        const target = flags.run || getActiveRun(p.id);
        if (!target) {
          console.error('No active run. Use: aos run session --run <id>');
          process.exitCode = 1;
          break;
        }
        const meta = runMeta(p.id, target);
        if (!meta) {
          console.error(`Unknown run: ${target}`);
          process.exitCode = 1;
        } else if (!meta.session) {
          console.error(`Run ${target} has no bound session (started outside a Claude Code session).`);
          process.exitCode = 1;
        } else {
          console.log(meta.session);
        }
      } else if (sub === 'list') {
        for (const r of listRuns(p.id)) {
          const adv =
            r.adversarial_review && r.adversarial_review !== 'pending'
              ? `  adv:${r.adversarial_review}`
              : '';
          console.log(
            `${r.run}  [${r.state}]  verify:${r.verification}${adv}${r.ticket ? `  ${r.ticket}` : ''}`
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
      if (verdict === 'none') {
        console.log(
          'No contracts configured in policy.yaml (verification.contracts) — nothing was verified.'
        );
      } else {
        console.log(`\nContract verdict: ${verdict.toUpperCase()}`);
      }
      if (adversarial_review) {
        console.log('Adversarial review required: spawn a skeptic subagent per /aos-verify.');
      }
      process.exit(verdict === 'fail' ? 1 : 0);
      break;
    }
    case 'find': {
      if (!positional.length) {
        console.error('Usage: aos find <query> [--project <id> | --all]');
        process.exitCode = 1;
        break;
      }
      if (flags.all) {
        printFindAll(loadRegistry().projects, positional.join(' '));
        break;
      }
      const p = requireProject(flags);
      printFind(p.id, positional.join(' '));
      break;
    }
    case 'fleet': {
      // Default: scaffold only — AOS never executes agents by default.
      // --launch (bare = auto-pick, or a runtime name) is the explicit opt-in.
      const ok = flags.launch !== undefined
        ? fleetLaunch(typeof flags.launch === 'string' ? flags.launch : undefined)
        : fleetScaffold();
      if (!ok) process.exitCode = 1;
      break;
    }
    case 'export': {
      const p = requireProject(flags);
      try {
        const dest = exportAgentsMd(p.id, p.name, process.cwd());
        console.log(`✔ Exported project context to ${dest}`);
        console.log('  Context only — gates and audit remain Claude Code-side. Re-run after editing the pack.');
      } catch (e) {
        console.error(String(e.message || e));
        process.exitCode = 1;
      }
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
      const ok = runDoctor({ appRoot: APP_ROOT, version: appVersion(), bundled: IS_BUNDLED });
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
        // Release-artifact install: self-update by running the install.sh that
        // shipped inside THIS (integrity-verified) install. The CLI itself makes
        // NO network requests — the installer owns all outbound access. It
        // resolves the latest version from the registry, no-ops if we're already
        // current (via AOS_CURRENT_VERSION below), and otherwise downloads the
        // new tarball and verifies the registry's sha-512 hash before swapping
        // it in. No remote-script execution and no shell interpolation: bash
        // runs a local file, and the version is passed via env.
        const installer = path.join(APP_ROOT, 'install.sh');
        if (!fs.existsSync(installer)) {
          console.error(
            'This install has no bundled installer to self-update from. Re-install with:\n' +
              '  npm i -g @albsugy/aos@latest\n' +
              'or the installer at https://www.npmjs.com/package/@albsugy/aos'
          );
          process.exit(1);
        }
        execFileSync('bash', [installer], {
          stdio: 'inherit',
          env: { ...process.env, AOS_CURRENT_VERSION: appVersion() },
        });
        break;
      }
      // Dev checkout: pull + rebuild deps as needed.
      const head = () => execSync('git rev-parse HEAD', { cwd: APP_ROOT, encoding: 'utf8' }).trim();
      const before = head();
      execSync('git pull --ff-only', { cwd: APP_ROOT, stdio: 'inherit' });
      const changed = head() !== before;
      if (IS_BUNDLED) {
        // The compiled bundle ships in the repo — the pull already delivered it.
        console.log(
          changed ? `✔ aos updated to ${appVersion()}` : `✔ aos ${appVersion()} — already up to date`
        );
        break;
      }
      const depsMissing = !fs.existsSync(path.join(APP_ROOT, 'node_modules', 'yaml'));
      if (!changed && !depsMissing) {
        console.log(`✔ aos ${appVersion()} — already up to date`);
        break;
      }
      const npmCmd = fs.existsSync(path.join(APP_ROOT, 'package-lock.json'))
        ? 'npm ci --no-fund --no-audit --loglevel=error'
        : 'npm install --no-fund --no-audit --loglevel=error';
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

// Run the CLI only when this module is the process entry point (the compiled
// bundle invoked as `aos`). Importing it — package analyzers, or
// `import { main } from '@albsugy/aos'` — must be side-effect-free: no arg
// handling, no ~/.aos creation. Symlinks (the ~/.local/bin/aos launcher and
// npm's bin shim) are resolved via realpath so the check holds however aos was
// launched. In source mode bin/aos.js imports this file and calls main()
// explicitly, so this guard is false there and never double-runs.
function isEntryPoint() {
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export { main };

if (isEntryPoint()) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
