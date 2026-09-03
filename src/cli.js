import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { ensureHome, projectDir } from './paths.js';
import { findProjectByCwd, getProject, loadRegistry } from './registry.js';
import { runHook } from './hooks.js';
import { init } from './install.js';
import { startRun, finishRun, setRunState, getActiveRun, listRuns, approvePlan, runMeta, linkRun, CLOSING_STATES } from './run.js';
import { parseTicket } from './vcs.js';
import { reviewState, reviewPath, reviewProblemLines, reviewCounts } from './review.js';
import { verifyContracts } from './verify.js';
import { printStatus } from './status.js';
import { printFind, printFindAll } from './search.js';
import { fleetScaffold, fleetLaunch } from './fleet.js';
import { buildContext } from './context.js';
import { loadPolicy } from './policy.js';
import { serveConsole } from './console/server.js';
import { runDoctor } from './doctor.js';
import { exportAgentsMd } from './export.js';
import { consumeSignoffTicket } from './signoff.js';
import { printCost, parseSince } from './cost.js';
import { verifyProjectLedgers } from './run.js';

const [, , cmd, ...rest] = process.argv;

// Sign-off identity — who authorized this, and how. Four forms, strongest
// first:
//
//   tty          an interactive terminal under this OS user ran the command
//   gate-prompt  the PreToolUse gate asked, and the human approved the prompt
//                (single-use ticket — see signoff.js)
//   headless-env AOS_ALLOW_HEADLESS_APPROVE=1, the CI escape hatch
//   prompt       unverified; only accepted where `required: false`
//
// `gate-prompt` exists because requiring a TTY put the sign-off in the one
// place the human never is. They are in the Claude Code session, where the
// gate is already showing them the command; making them open a second terminal
// meant runs stayed at awaiting-review forever. Approving the prompt is the
// same human act — now it counts, and what it was is recorded either way.
function signoffIdentity(action, { required = true, projectId = null, ticket = null, target = null } = {}) {
  const headless = process.env.AOS_ALLOW_HEADLESS_APPROVE === '1';
  // Under dry_run the gate never prompts, so no ticket can ever exist — and
  // requiring one would make closing a run the single thing dry run makes
  // HARDER, with an error message pointing at a prompt that will never appear.
  // Accept it, and record honestly that no human was actually asked.
  const dryRun = projectId ? loadPolicy(projectId).dry_run === true : false;
  let via = null;
  if (process.stdin.isTTY) via = 'tty';
  else if (ticket && projectId && consumeSignoffTicket(projectId, ticket, target)) via = 'gate-prompt';
  else if (dryRun) via = 'dry-run';
  else if (headless) via = 'headless-env';

  if (!via) {
    if (required) {
      console.error(
        `${action} needs a human sign-off, and this invocation has none.\n` +
          `  • In a Claude Code session: the AOS gate prompts you for this command — approve it there.\n` +
          `    (No prompt appeared? The hooks may not be wired: run \`aos doctor\`.)\n` +
          `  • Outside a session: run it yourself in an interactive terminal.\n` +
          `  • In CI: set AOS_ALLOW_HEADLESS_APPROVE=1 — the override is recorded in the audit.`
      );
      process.exitCode = 1;
      return null;
    }
    via = 'prompt';
  }
  let user = null;
  try {
    user = os.userInfo().username;
  } catch {
    // identity is best-effort
  }
  return { user, via };
}

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

// A flag given without a value parses as `true`. Anything that reaches a path
// join or a port number needs the string form or nothing — `aos run session
// --run` used to crash with a Node type error.
function strFlag(value) {
  return typeof value === 'string' && value ? value : undefined;
}

// What the review gate concluded, after the fact. `forced` is called out
// loudly: a run that shipped past its own gate should read that way forever.
function printReviewOutcome(meta) {
  const counts = meta.review || {};
  const detail = counts.total
    ? `${counts.total} finding(s): ` +
      ['fixed', 'dismissed', 'deferred', 'open']
        .filter((s) => counts[s])
        .map((s) => `${counts[s]} ${s}`)
        .join(', ')
    : 'no findings';
  if (meta.adversarial_review === 'forced') {
    console.log(`⚠ Adversarial review gate FORCED (review state: ${counts.state || 'unknown'}) — recorded in the audit`);
  } else if (meta.adversarial_review === 'clean') {
    console.log('✔ Adversarial review: hunted, nothing found');
  } else if (meta.adversarial_review === 'resolved') {
    console.log(`✔ Adversarial review: ${detail}`);
  } else if (meta.adversarial_review === 'not-required') {
    console.log('ℹ Adversarial review not required by policy');
  } else if (['absent', 'invalid', 'open'].includes(meta.adversarial_review)) {
    // Reachable in warn mode, or in gate mode when --force jumped past the
    // gated edge (finish --state done). Either way the warning must happen —
    // warn's whole promise is that it does; don't name the mode, we can't
    // tell which path it was from here.
    console.log(
      `⚠ Adversarial review ${meta.adversarial_review} — recorded, not blocking this finish.\n` +
        '  Run /aos-verify and record review.json before shipping.'
    );
  }
}

function requireProject(flags = {}) {
  const id = strFlag(flags.project);
  const p = id ? getProject(id) : findProjectByCwd(process.cwd());
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
  aos init [--name <name>] [--hooks-only]   Register this repo (--hooks-only: context + gates + audit, no pipeline skills)
  aos status                        All projects: runs, states, leverage ratio, tokens
  aos cost [--since 7d] [--by project|run|model|contract] [--all]   Estimated spend at API list prices
  aos context [--project <id>]      Print the project context pack (what agents load)
  aos run start --ticket <id|url> [--title <t>]   Start a run (branch auto-detected; a URL is kept as the ticket link)
  aos run approve                   Approve the active run's plan (human step when plan_gate: ask)
  aos run review [--run <id>]       Validate the run's adversarial review (review.json) — what the finish gate checks
  aos run finish [--state <s>]      Finish active run (default: awaiting-review); blocked by an unsatisfied review gate (--force overrides, audited)
  aos run state <state> [--run <id>]  Set run state (in-progress|blocked|awaiting-review|done|shipped); --run targets a finished run (done/shipped are gated — the prompt is your sign-off)
  aos run link [--pr <url>] [--ticket-url <url>] [--branch <n>]  Attach the PR / ticket / branch to a run
  aos run list                      List runs for this project
  aos run session [--run <id>]      Print the Claude Code session id bound to a run (for claude --resume)
  aos verify                        Run verification contracts from policy.yaml
  aos audit verify [--project <id>] Check every audit ledger's hash chain (tamper evidence)
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
      const hooksOnly = Boolean(flags['hooks-only']);
      const { project, home, detection } = init(process.cwd(), { name: strFlag(flags.name), hooksOnly });
      console.log(`✔ Registered project "${project.name}" (${project.id})`);
      console.log(`✔ Spec scaffolded at ${home}`);
      if (detection?.pack) {
        console.log(`✔ Context pack drafted from the repo${detection.summary ? ` (${detection.summary})` : ''} — review and refine it`);
      } else {
        console.log(`✔ Context pack scaffolded (blank template — fill it in)`);
      }
      if (detection?.contracts?.length) {
        console.log(`✔ Seeded ${detection.contracts.length} verification contract(s): ${detection.contracts.map((c) => c.name).join(', ')}`);
      } else {
        console.log(
          `⚠ Verification is EMPTY — no test command detected, so \`aos verify\` checks NOTHING.\n` +
            `  Add contracts to policy.yaml (or run /aos-onboard and let the agent author them).`
        );
      }
      if (hooksOnly) {
        console.log(`✔ Skills skipped (--hooks-only) — nothing added to .claude/skills/`);
      } else {
        console.log(`✔ Skills installed to .claude/skills/ (aos-ticket, aos-verify, aos-approve, aos-learn, aos-ask, aos-onboard)`);
      }
      console.log(`✔ Hooks wired in .claude/settings.json (gate, audit, context, tokens, learnings)`);
      if (hooksOnly) {
        console.log(`\nThat's the whole install: every new session in this repo now loads the context`);
        console.log(`pack, gates risky commands and writes, and records an audit trail — no skill`);
        console.log(`invocation, nothing to remember. Fill in ${path.join(home, 'context', 'pack.md')}.`);
        console.log(`Add the ticket pipeline later with: aos init`);
      } else {
        console.log(`\nNext: start a Claude Code session here and run /aos-onboard — it fills the`);
        console.log(`context pack from the repo, mines git history for decisions, and reviews policy.yaml.`);
        console.log(`Then work tickets with /aos-ticket <ticket>.`);
      }
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
        // `--ticket` takes an id or a tracker URL; a URL keeps the link and
        // still yields a readable run id.
        const t = parseTicket(strFlag(flags.ticket));
        const { runId, dir, meta: started } = startRun(p.id, {
          ticket: t.id,
          title: strFlag(flags.title),
          planGate: policy.plan_gate,
          repoRoot: process.cwd(),
          ticketUrl: t.url || strFlag(flags['ticket-url']) || null,
        });
        console.log(`✔ Run started: ${runId}`);
        console.log(`  folder: ${dir}`);
        if (started.branch) console.log(`  branch: ${started.branch}`);
        if (started.ticket_url) console.log(`  ticket: ${started.ticket_url}`);
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
        approvePlan(
          p.id,
          active,
          signoffIdentity('aos run approve', { required: false, projectId: p.id, ticket: 'plan-approve' })
        );
        console.log(`✔ Plan approved for ${active} — implementation writes are no longer plan-gated`);
      } else if (sub === 'finish') {
        const active = getActiveRun(p.id);
        if (!active) {
          console.error('No active run.');
          process.exitCode = 1;
          break;
        }
        const finishState = strFlag(flags.state) || 'awaiting-review';
        // `--state done|shipped` ends the run, so it needs the same human
        // sign-off `aos run state` demands. Gating only one of the two commands
        // that reach a closing state left the other closing runs with no
        // recorded approver at all.
        let finisher = null;
        if (CLOSING_STATES.has(finishState)) {
          finisher = signoffIdentity(`aos run finish --state ${finishState}`, {
            projectId: p.id,
            ticket: 'review-close',
            target: active,
          });
          if (!finisher) break;
        }
        let meta;
        try {
          meta = finishRun(p.id, active, finishState, {
            force: Boolean(flags.force),
            repoRoot: process.cwd(),
            by: finisher,
          });
        } catch (e) {
          // The review gate's message is already formatted for the human (and
          // for the agent that has to fix the file) — print it, add nothing.
          console.error(e.name === 'ReviewGateError' ? e.message : String(e.message || e));
          process.exitCode = 1;
          break;
        }
        console.log(`✔ Run ${active} → ${meta.state}`);
        printReviewOutcome(meta);
        // awaiting-review is a queue of one with no reader unless somebody
        // drains it now. Point at the in-session close rather than leaving the
        // run for a dashboard visit that does not happen.
        if (meta.state === 'awaiting-review') {
          console.log(
            `\nNext, in this session: summarize the change and the review findings for the human,\n` +
              `then close it with \`aos run state done --run ${active}\` (or shipped).\n` +
              `The gate turns that into a permission prompt — approving it is the human sign-off.`
          );
        }
        // FYI, not a gate: the standard pipeline writes learnings AFTER
        // finish (learn stage), and the Stop hook backstops the session end.
        if (meta.learnings_recorded === 'absent') {
          console.log(
            'ℹ No learnings recorded for this run yet — append 1-3 bullets to learnings.md ' +
              'before the session ends (the Stop hook will remind you).'
          );
        }
      } else if (sub === 'review') {
        // The gate's own verdict, on demand: lets the agent fix review.json
        // against the real validator instead of discovering it at finish.
        const target = strFlag(flags.run) || getActiveRun(p.id);
        if (!target) {
          console.error('No active run. Use: aos run review --run <id>');
          process.exitCode = 1;
          break;
        }
        const review = reviewState(p.id, target);
        const file = reviewPath(p.id, target);
        const problems = reviewProblemLines(review, file);
        console.log(`Run ${target} — adversarial review: ${review.state} (policy: ${review.mode})`);
        if (problems.length) {
          console.log('');
          console.log(problems.join('\n'));
          // Non-blocking states (warn/off) still report, but must not fail CI.
          if (review.mode === 'gate') process.exitCode = 1;
        } else if (review.state === 'clean') {
          console.log(`✔ Valid — a hunt with no findings (scope recorded in ${file})`);
        } else if (review.state === 'resolved') {
          const c = reviewCounts(review.findings);
          console.log(`✔ Valid — ${c.total} finding(s), all dispositioned`);
        }
      } else if (sub === 'state') {
        // --run <id> targets any run — the review action (done/shipped) is
        // taken AFTER finish clears the active pointer, so "active only"
        // would make awaiting-review a state with no way out.
        const target = strFlag(flags.run) || getActiveRun(p.id);
        if (!target) {
          console.error('No active run. Target a finished one with: aos run state <state> --run <id>');
          process.exitCode = 1;
          break;
        }
        const nextState = positional[1] || 'in-progress';
        let signer = null;
        if (nextState === 'done' || nextState === 'shipped') {
          signer = signoffIdentity(`aos run state ${nextState}`, {
            projectId: p.id,
            ticket: 'review-close',
            target,
          });
          if (!signer) break;
        }
        try {
          const meta = setRunState(p.id, target, nextState, {
            force: Boolean(flags.force),
            by: signer,
          });
          console.log(`✔ Run ${target} → ${meta.state}${flags.force ? ' (forced)' : ''}`);
          // The close is human-signed, so the human should see what they
          // signed: a run closed while its review never cleared says so here.
          if (
            ['done', 'shipped'].includes(meta.state) &&
            ['absent', 'invalid', 'open', 'forced'].includes(meta.adversarial_review)
          ) {
            console.log(
              `⚠ Closed with adversarial review: ${meta.adversarial_review} — recorded in meta and audit.`
            );
          }
        } catch (e) {
          console.error(String(e.message || e));
          process.exitCode = 1;
        }
      } else if (sub === 'link') {
        // The PR url is the one thing a run cannot discover for itself — the
        // CLI makes no network calls — so the pipeline records it after
        // opening the PR, and the console becomes a review starting point.
        const target = strFlag(flags.run) || getActiveRun(p.id);
        if (!target) {
          console.error('No active run. Use: aos run link --run <id> --pr <url>');
          process.exitCode = 1;
          break;
        }
        if (!strFlag(flags.pr) && !strFlag(flags['ticket-url']) && !strFlag(flags.branch)) {
          console.error('Nothing to link. Pass --pr <url>, --ticket-url <url>, and/or --branch <name>.');
          process.exitCode = 1;
          break;
        }
        try {
          const meta = linkRun(p.id, target, {
            pr: strFlag(flags.pr),
            ticket: strFlag(flags['ticket-url']),
            branch: strFlag(flags.branch),
          });
          console.log(`✔ Linked ${target}`);
          if (meta.branch) console.log(`  branch: ${meta.branch}`);
          if (meta.pr_url) console.log(`  pr:     ${meta.pr_url}`);
          if (meta.ticket_url) console.log(`  ticket: ${meta.ticket_url}`);
        } catch (e) {
          console.error(String(e.message || e));
          process.exitCode = 1;
        }
      } else if (sub === 'session') {
        // The session bound to a run — recorded by the post-tool hook at
        // `run start`. Lets a fleet/primary agent resume the exact crewmate
        // that worked a run: claude --resume $(aos run session --run <id>)
        const target = strFlag(flags.run) || getActiveRun(p.id);
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
      const { verdict, results, review_mode } = verifyContracts(p.id, process.cwd());
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
      if (review_mode !== 'off') {
        const active = getActiveRun(p.id);
        const where = active ? reviewPath(p.id, active) : "the run's review.json";
        // The tail of the message must match the mode — "will not close" is a
        // lie under warn, and a false threat teaches agents to ignore real ones.
        console.log(
          review_mode === 'gate'
            ? `Adversarial review required: spawn a skeptic subagent per /aos-verify, then record its\nfindings in ${where} — \`aos run finish\` will not close the run without it.`
            : `Adversarial review expected (warn mode): spawn a skeptic subagent per /aos-verify and\nrecord its findings in ${where} — finish will warn, not block.`
        );
      }
      process.exit(verdict === 'fail' ? 1 : 0);
      break;
    }
    case 'audit': {
      // `aos audit verify` — walk every audit ledger (project + each run) and
      // check the hash chain. Exit 1 on any tamper evidence so CI can gate on it.
      const sub = positional[0];
      if (sub !== 'verify') {
        console.error('Usage: aos audit verify [--project <id>]');
        process.exitCode = 1;
        break;
      }
      const wanted = strFlag(flags.project);
      if (wanted && !getProject(wanted)) {
        console.error(`No project "${wanted}".`);
        process.exitCode = 1;
        break;
      }
      const ids = wanted ? [wanted] : loadRegistry().projects.map((x) => x.id);
      if (!ids.length) {
        console.error('No projects registered.');
        process.exitCode = 1;
        break;
      }
      let bad = 0;
      for (const id of ids) {
        for (const { label, report } of verifyProjectLedgers(id)) {
          if (report.lines === 0) continue;
          console.log(
            `${report.ok ? '✔' : '✗'} ${id} — ${label}: ${report.lines} line(s), ${report.chained} chained, ${report.legacy} legacy${report.ok ? '' : ' — TAMPER EVIDENCE'}`
          );
          for (const pr of report.problems) {
            bad++;
            console.log(`    ${pr.issue}`);
          }
        }
      }
      if (bad) {
        console.log(
          `\n${bad} ledger problem(s) — entries were modified after being written, or written outside the chain.`
        );
        process.exitCode = 1;
      } else {
        console.log('\nAll ledgers verify — no post-hoc edits detected.');
      }
      break;
    }
    case 'cost': {
      const since = parseSince(flags.since);
      if (Number.isNaN(since)) {
        console.error(`Unreadable --since "${flags.since}". Use 7d / 24h / 2w, or a date like 2026-07-01.`);
        process.exitCode = 1;
        break;
      }
      const by = String(strFlag(flags.by) || 'project').toLowerCase();
      const GROUPINGS = ['project', 'run', 'model', 'contract'];
      if (!GROUPINGS.includes(by)) {
        console.error(`Unknown --by "${by}". One of: ${GROUPINGS.join(', ')}.`);
        process.exitCode = 1;
        break;
      }
      const projects = flags.all
        ? loadRegistry().projects
        : [strFlag(flags.project) ? getProject(strFlag(flags.project)) : findProjectByCwd(process.cwd())].filter(Boolean);
      if (!projects.length) {
        console.error(
          'No AOS project matches this directory. Run `aos init` here, pass --project <id>, or use --all.'
        );
        process.exitCode = 1;
        break;
      }
      printCost({ projects, since, by, sinceLabel: since === null ? null : flags.since });
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
      const port = Number(strFlag(flags.port) || 4560);
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
