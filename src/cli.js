import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';
import { ensureHome, projectDir, aosHome, nowIso } from './paths.js';
import { findProjectByCwd, getProject, loadRegistry, removeProject } from './registry.js';
import { runHook } from './hooks.js';
import { init } from './install.js';
import { enforcementLevel } from './agents.js';
import { startRun, finishRun, setRunState, getActiveRun, listRuns, approvePlan, runMeta, linkRun, CLOSING_STATES } from './run.js';
import { parseTicket } from './vcs.js';
import { reviewState, reviewPath, reviewProblemLines, reviewCounts } from './review.js';
import { verifyContracts, executeReview } from './verify.js';
import { printStatus } from './status.js';
import { printFind, printFindAll } from './search.js';
import { fleetScaffold, fleetLaunch } from './fleet.js';
import { buildContext } from './context.js';
import { syncContextFile, contextStatus, diffContextFile, contextFilesFor } from './context-sync.js';
import { loadPolicy } from './policy.js';
import { serveConsole } from './console/server.js';
import { runDoctor, printCapabilities } from './doctor.js';
import { exportAgentsMd } from './export.js';
import { consumeSignoffTicket } from './signoff.js';
import { approveDecision, listPendingDecisions, getPendingDecision, PENDING_TTL_MS } from './decisions.js';
import { printCost, parseSince } from './cost.js';
import { runPolicyTest } from './policy-test.js';
import { verifyProjectLedgers } from './run.js';
import { appendChainedTo, verifyLedger } from './chain.js';
import { ingestTranscripts, claudeProjectsDir } from './ingest.js';

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
function signoffIdentity(action, { required = true, projectId = null, ticket = null, target = null, mustInclude = null } = {}) {
  const headless = process.env.AOS_ALLOW_HEADLESS_APPROVE === '1';
  // Under dry_run the gate never prompts, so no ticket can ever exist — and
  // requiring one would make closing a run the single thing dry run makes
  // HARDER, with an error message pointing at a prompt that will never appear.
  // Accept it, and record honestly that no human was actually asked.
  const dryRun = projectId ? loadPolicy(projectId).dry_run === true : false;
  let via = null;
  if (process.stdin.isTTY) via = 'tty';
  else {
    // The ticket's own `via` distinguishes a gate prompt from a human-granted
    // external approval; both are human acts, but the record should say which.
    const t = ticket && projectId ? consumeSignoffTicket(projectId, ticket, target, mustInclude) : null;
    if (t) via = t.via || 'gate-prompt';
    else if (dryRun) via = 'dry-run';
    else if (headless) via = 'headless-env';
  }

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
  } else if (['absent', 'invalid', 'open', 'unproven'].includes(meta.adversarial_review)) {
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

function relAge(ts) {
  const s = (Date.now() - Date.parse(ts || '')) / 1000;
  if (!Number.isFinite(s) || s < 0) return '?';
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
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
  aos init [--name <name>] [--hooks-only] [--agent <a>]   Register this repo for coding agents
         --agent claude|codex|cursor|pi|opencode|devin|gemini (comma list), auto (detect installed), or all (default: claude)
         (--hooks-only: context + gates + audit, no pipeline skills)
  aos status                        All projects: runs, states, leverage ratio, tokens
  aos cost [--since 7d] [--by project|run|model|contract] [--all]   Estimated spend at API list prices
  aos context [--project <id>]      Print the project context pack (what agents load)
  aos run start --ticket <id|url> [--title <t>]   Start a run (branch auto-detected; a URL is kept as the ticket link)
  aos run approve                   Approve the active run's plan (human step when plan_gate: ask)
  aos run review [--run <id>] [--execute|--no-execute]  Validate the run's adversarial review; execute reproduce commands when executable_findings is on
  aos run finish [--state <s>]      Finish active run (default: awaiting-review); blocked by an unsatisfied review gate (--force overrides, audited)
  aos run state <state> [--run <id>]  Set run state (in-progress|blocked|awaiting-review|done|shipped); --run targets a finished run (done/shipped are gated — the prompt is your sign-off)
  aos run link [--pr <url>] [--ticket-url <url>] [--branch <n>]  Attach the PR / ticket / branch to a run
  aos run list                      List runs for this project
  aos run session [--run <id>]      Print the agent session id bound to a run (for claude --resume)
  aos verify                        Run verification contracts from policy.yaml
  aos policy test [--file <p.yaml>] [--since 30d]   Policy CI — replay recorded agent traffic against a policy
  aos audit verify [--project <id>] Check every audit ledger's hash chain (tamper evidence)
  aos ingest [--dry-run]            Backfill audit + token history from Claude Code transcripts
  aos find <query> [--all]          Search project memory; --all sweeps every project
  aos fleet [--launch [runtime]]    Scaffold ~/.aos/fleet (primary-agent hub); --launch opens it in claude|codex|opencode|droid
  aos export                        Write the context pack as AGENTS.md (legacy alias of: aos context sync)
  aos context sync|check|diff       Generate/verify per-agent context files (AGENTS.md, GEMINI.md) from the project memory
  aos approve [<id>|--list]         Grant a pending external approval (Codex/Cursor gated ops) — human-only
  aos console [--port <p>]          Serve the local console (default http://127.0.0.1:4560)
  aos projects                      List registered projects and their memory homes
  aos remove <id> [--purge] [--force]   Unregister a project (console stops listing it); --purge deletes its data — sign-off required
  aos doctor [--capabilities]       Diagnose the install, registry, and current repo's wiring
         --capabilities prints the per-agent support matrix (enforcement levels, honestly)
  aos hook <name> [--agent <id>]     (internal) agent hook entry points (claude|codex|cursor|pi|opencode; default claude)
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
      let result;
      try {
        result = init(process.cwd(), { name: strFlag(flags.name), hooksOnly, agent: strFlag(flags.agent) });
      } catch (e) {
        console.error(String(e.message || e));
        process.exitCode = 1;
        break;
      }
      const { project, home, detection, agents: wired, contextReports } = result;
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
      // Per-agent wiring — the honest capability picture, per agent.
      for (const a of wired) {
        const level = enforcementLevel(a.id);
        if (a.hooks) {
          const cfg = a.configPath ? path.relative(process.cwd(), a.configPath) || a.configPath : '';
          console.log(`✔ ${a.label}: hooks wired (${cfg}) — ${level.label}`);
          if (!hooksOnly) console.log(`✔ ${a.label}: skills installed to ${path.relative(process.cwd(), a.skills) || a.skills}`);
        } else {
          console.log(`ℹ ${a.label}: ${level.label}`);
        }
        for (const note of a.notes || []) console.log(`  ⚠ ${a.label}: ${note}`);
      }
      for (const r of contextReports || []) {
        if (r.ok) console.log(`✔ Context synced: ${r.file}${r.changed ? '' : ' (already current)'}`);
        else console.log(`⚠ Context file ${r.file}: ${r.error}`);
      }
      if (hooksOnly) {
        console.log(`\nThat's the whole install: every new session in this repo now loads the context`);
        console.log(`pack, gates risky commands and writes, and records an audit trail — no skill`);
        console.log(`invocation, nothing to remember. Fill in ${path.join(home, 'context', 'pack.md')}.`);
        console.log(`Add the ticket pipeline later with: aos init`);
      } else {
        console.log(`\nNext: start a session here with any wired agent and run the aos-onboard skill —`);
        console.log(`it fills the context pack from the repo, mines git history for decisions, and reviews policy.yaml.`);
        console.log(`Then work tickets with the aos-ticket skill.`);
      }
      break;
    }
    case 'approve': {
      // Grant a pending external approval — the human half of the Codex/Cursor
      // ask flow. The decision id is positional; --list shows what is pending.
      // Sign-off uses the same routes as closing a run; the gate-prompt route
      // is bound to THIS decision id, so a prompt for one approval can never
      // grant another.
      const p = requireProject(flags);
      if (flags.list || !positional[0]) {
        const pending = listPendingDecisions(p.id);
        if (!pending.length) {
          console.log(`No pending approvals for "${p.id}".`);
        } else {
          console.log(`Pending approvals for "${p.id}" — grant with: aos approve <id>`);
          for (const d of pending) {
            const age = relAge(d.created);
            const op = d.command || (d.paths && d.paths.length ? d.paths.join(', ') : '');
            console.log(
              `  ${d.id}  [${d.action}]  ${op ? op + '  ' : ''}${String(d.reason || '').slice(0, 90)}  (${age})`
            );
          }
        }
        break;
      }
      const id = String(positional[0]);
      const pending = getPendingDecision(p.id, id);
      if (!pending) {
        console.error(`No pending decision "${id}" — it may already be approved, consumed, or expired.`);
        process.exitCode = 1;
        break;
      }
      const age = Date.now() - Date.parse(pending.created || '');
      if (!Number.isFinite(age) || age < 0 || age > PENDING_TTL_MS) {
        console.error(`Decision ${id} expired pending approval (created ${pending.created}).`);
        process.exitCode = 1;
        break;
      }
      console.log(`Approving ${id}: [${pending.action}] ${pending.reason}`);
      if (pending.command) console.log(`  command: ${pending.command}`);
      if (pending.paths && pending.paths.length) console.log(`  paths: ${pending.paths.join(', ')}`);
      console.log(`  provider: ${pending.provider || 'unknown'}  session: ${pending.session || '-'}  created: ${pending.created}`);
      const by = signoffIdentity(`aos approve ${id}`, {
        required: true,
        projectId: p.id,
        ticket: 'aos-approve',
        mustInclude: id,
      });
      if (!by) break;
      const result = approveDecision(p.id, id, by);
      if (!result.ok) {
        console.error(`✗ ${result.error}`);
        process.exitCode = 1;
        break;
      }
      console.log(`✔ Approved ${id} — the agent may retry the exact operation now.`);
      console.log(`  Single-use, and it expires if not spent soon. Recorded in the audit trail.`);
      break;
    }
    case 'status':
      printStatus();
      break;
    case 'context': {
      const p = requireProject(flags);
      const sub = positional[0];
      if (sub === 'sync' || sub === 'check' || sub === 'diff') {
        // Portable context: regenerate / verify the per-agent files from the
        // canonical memory. `check` is CI-gateable (exit 1 on drift).
        const files = contextFilesFor(p.agents || []);
        if (!files.length) {
          console.log(
            `No file-reading agents registered for "${p.id}" — its context reaches agents via SessionStart hooks.\n` +
              `Register one with: aos init --agent codex|cursor|gemini`
          );
          break;
        }
        const repoRoot = (p.repos || []).find((r) => fs.existsSync(path.join(r, '.git'))) || (p.repos || [])[0] || process.cwd();
        let bad = 0;
        if (sub === 'sync') {
          for (const file of files) {
            const r = syncContextFile(p.id, p.name, repoRoot, file);
            if (r.ok) console.log(`${r.changed ? '✔' : '•'} ${file} — ${r.changed ? 'written' : 'already current'}`);
            else {
              bad++;
              console.error(`⚠ ${r.error}`);
            }
          }
          if (bad) process.exitCode = 1;
          else console.log(`Source of truth: ${projectDir(p.id)} — edit there, never the generated files.`);
        } else if (sub === 'check') {
          for (const file of files) {
            const st = contextStatus(p.id, p.name, repoRoot, file);
            const icon = { current: '✔', stale: '⚠', missing: '✗', foreign: '✗' }[st.state];
            console.log(`${icon} ${file} — ${st.state}`);
            if (st.state !== 'current') bad++;
          }
          if (bad) {
            console.log(
              `\n${bad} file(s) out of date — run \`aos context sync\` after editing the project memory.`
            );
            process.exitCode = 1;
          } else {
            console.log('\nAll generated context files are current.');
          }
        } else {
          for (const file of files) {
            const d = diffContextFile(p.id, p.name, repoRoot, file);
            console.log(`── ${file} (${d.state})${d.lines.length ? '' : ' — no differences'}`);
            for (const line of d.lines) console.log(line);
          }
        }
        break;
      }
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
        // Reproduce commands run only when executable_findings is on (or
        // `--execute`); `--no-execute` skips. Optional reproduce is docs until
        // the flag is on — running them on an opted-out project was a bypass.
        const target = strFlag(flags.run) || getActiveRun(p.id);
        if (!target) {
          console.error('No active run. Use: aos run review --run <id>');
          process.exitCode = 1;
          break;
        }
        let review = reviewState(p.id, target);
        const hasReproduce = review.findings.some((f) => f.reproduce && (f.status === 'open' || f.status === 'fixed'));
        const wantExecute = (review.executable || flags.execute) && !flags['no-execute'];
        if (hasReproduce && wantExecute) {
          const result = executeReview(p.id, target, {
            cwd: p.repos?.[0] || process.cwd(),
            force: Boolean(flags.execute),
          });
          if (result.skipped) {
            // Policy off and no --execute — should not be reached (wantExecute
            // already gated), but don't treat a skip as a successful run.
          } else if (result.error) {
            console.log(`⚠ ${result.error}`);
          } else {
            for (const e of result.executions) {
              const expect = e.expected === 'open' ? 'fails (bug demonstrated)' : 'passes (fix demonstrated)';
              const verdict = e.pass ? '✔' : '✗';
              const why = e.reason ? ` — ${e.reason}` : '';
              console.log(
                `${verdict} findings[${e.finding}] (${e.expected}): \`${e.command}\` exit ${JSON.stringify(e.exit)} — expected it to ${expect} (${e.ms ?? 0}ms)${why}`
              );
            }
            if (result.total) {
              console.log(
                `  ${result.passed}/${result.total} reproduce command(s) demonstrated their finding — results recorded in executions.json`
              );
            }
            // Re-read: the executions just written may change the verdict.
            review = reviewState(p.id, target);
          }
        }
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
          const execNote = hasReproduce ? ', reproduce commands executed' : '';
          console.log(`✔ Valid — ${c.total} finding(s), all dispositioned${execNote}`);
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
            ['absent', 'invalid', 'open', 'unproven', 'forced'].includes(meta.adversarial_review)
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
    case 'policy': {
      // `aos policy test` — Policy CI: replay recorded agent traffic against
      // a policy (candidate via --file, else the current one) and report what
      // would change. It is a report, not a gate: exit 0 with findings, exit 1
      // only when the replay itself could not run (bad file, no project).
      const sub = positional[0];
      if (sub !== 'test') {
        console.error('Usage: aos policy test [--file <policy.yaml>] [--since 30d] [--project <id>]');
        process.exitCode = 1;
        break;
      }
      const p = requireProject(flags);
      const file = strFlag(flags.file);
      const window = strFlag(flags.since) || '90d';
      const since = parseSince(window);
      if (Number.isNaN(since)) {
        console.error(`Unreadable --since "${window}". Use 7d / 24h / 2w, or a date like 2026-07-01.`);
        process.exitCode = 1;
        break;
      }
      let result;
      try {
        result = runPolicyTest(p.id, { file, sinceMs: since ?? 0 });
      } catch (e) {
        console.error(e.message || e);
        process.exitCode = 1;
        break;
      }
      const origin = file ? path.resolve(file) : `${p.id}'s installed policy.yaml`;
      console.log(
        `Policy replay — ${result.unique.length} unique command(s) from ${result.scanned} recorded call(s), window ${window}`
      );
      console.log(`Candidate: ${origin}`);
      if (result.truncated) {
        console.log(
          `ℹ ${result.truncated} recorded command(s) were truncated at 300 chars — evaluated as recorded; a rule matching only past that point cannot be tested against them`
        );
      }
      const show = (rows, verb) => {
        if (!rows.length) return;
        console.log(`\n${verb} (${rows.length}):`);
        for (const r of rows.slice(0, 15)) {
          const why = r.reason ? ` — ${r.reason}` : r.action ? ` — ${r.action}` : '';
          console.log(`  • [${String(r.count).padStart(3)}×] ${r.command.slice(0, 100)}${why}`);
        }
        if (rows.length > 15) console.log(`  … and ${rows.length - 15} more`);
      };
      show(result.wouldDeny, 'would DENY — ran freely before');
      show(result.wouldAsk, 'would GATE — ran freely before');
      show(result.wouldTighten, 'would now DENY — was gated (approved) before');
      show(result.wouldUnblock, 'would now ALLOW — was denied/gated before');
      console.log(
        `\nUnchanged: ${result.unchanged} · denied: ${result.wouldDeny.length} · gated: ${result.wouldAsk.length} · tightened: ${result.wouldTighten.length} · unblocked: ${result.wouldUnblock.length}${result.errors ? ` · evaluation errors: ${result.errors}` : ''}`
      );
      if (!result.unique.length) {
        console.log('No recorded Bash commands to replay — run some work (or `aos ingest`) first.');
      }
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
      // The removals receipt ledger is global, not per-project: it survives the
      // purges it records, so it gets the same walk.
      const removals = path.join(aosHome(), 'removals.jsonl');
      const removalsReport = verifyLedger([removals.replace(/removals\.jsonl$/, 'removals.1.jsonl'), removals]);
      if (removalsReport.lines > 0) {
        console.log(
          `${removalsReport.ok ? '✔' : '✗'} removals ledger: ${removalsReport.lines} line(s), ${removalsReport.chained} chained, ${removalsReport.legacy} legacy${removalsReport.ok ? '' : ' — TAMPER EVIDENCE'}`
        );
        for (const pr of removalsReport.problems) {
          bad++;
          console.log(`    ${pr.issue}`);
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
    case 'ingest': {
      // Backfill audit + token history from Claude Code transcripts. Read-only
      // probe with --dry-run.
      const only = strFlag(flags.project);
      if (only && !getProject(only)) {
        console.error(`No project "${only}".`);
        process.exitCode = 1;
        break;
      }
      const { files, projects, warnings } = ingestTranscripts({
        dryRun: Boolean(flags['dry-run']),
        onlyProjectId: only || null,
      });
      const dir = claudeProjectsDir();
      console.log(
        `Scanned ${files} session file(s) under ${dir}${Boolean(flags['dry-run']) ? ' (dry run — nothing written)' : ''}`
      );
      if (!projects.length) {
        console.log('No transcripts matched a registered project. Sessions are matched by their recorded cwd.');
      }
      for (const r of projects) {
        const parts = [
          `${r.files} file(s): ${r.sessionsNew} new`,
          r.sessionsDelta ? `${r.sessionsDelta} updated` : null,
          r.sessionsSkipped ? `${r.sessionsSkipped} skipped` : null,
        ].filter(Boolean);
        console.log(`  ${r.project}: ${parts.join(', ')}, ${r.toolCalls} tool call(s)`);
        if (r.tokens && (r.tokens.input || r.tokens.output || r.tokens.cache_read)) {
          console.log(`    tokens: ${r.tokens.input} in, ${r.tokens.output} out, ${r.tokens.cache_read} cache-read`);
        }
      }
      for (const w of warnings) console.log(`⚠ ${w}`);
      if (!Boolean(flags['dry-run']) && projects.some((r) => r.toolCalls > 0)) {
        console.log('\nIngested history is replayable: aos policy test');
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
      // `--agent` selects the adapter that translates this provider's hook
      // payload; default claude keeps every existing install behaving exactly
      // as before the multi-agent refactor.
      await runHook(positional[0], { agent: strFlag(flags.agent) });
      break;
    case 'doctor': {
      if (flags.capabilities) {
        printCapabilities();
        break;
      }
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
    case 'remove': {
      // Unregister a project — and, with --purge, delete its data. Unregistering
      // turns that repo's gates off, which is why the command is gated by
      // default policy (an agent hitting it is asked) and --purge demands a
      // human sign-off (TTY, gate prompt, or the CI env var — same routes as
      // closing a run). Deletion is recorded in ~/.aos/removals.jsonl, which
      // survives the purge: the project's own audit ledger dies with it.
      const id = positional[0];
      if (!id || id.startsWith('--')) {
        console.error('Usage: aos remove <id> [--purge] [--force]');
        process.exitCode = 1;
        break;
      }
      const p = getProject(id);
      if (!p) {
        console.error(`No project "${id}" is registered — aos projects lists them.`);
        process.exitCode = 1;
        break;
      }
      // A run mid-flight belongs to somebody's session; deleting (or even
      // unregistering) under it is the kind of quiet loss the gates exist for.
      const open = listRuns(p.id).filter((r) => r.state === 'in-progress' || r.state === 'blocked');
      if (open.length && !flags.force) {
        console.error(
          `Project "${p.id}" still has ${open.length} open run(s): ${open.map((r) => r.run).join(', ')}.\n` +
            `Finish or park them first (aos run finish / aos run state blocked), or override with --force.`
        );
        process.exitCode = 1;
        break;
      }
      let by = null;
      if (flags.purge) {
        by = signoffIdentity(`aos remove ${p.id} --purge`, {
          required: true,
          projectId: p.id,
          ticket: 'project-remove',
          target: p.id,
        });
        if (!by) break;
      }
      // Facts gathered before any deletion; the receipt itself lives OUTSIDE
      // the project dir, so it is written last, after the outcome is known —
      // a receipt that says purged when rmSync failed would be evidence lying.
      const runs = listRuns(p.id).length;
      const dataDir = projectDir(p.id);
      let user = null;
      try {
        user = os.userInfo().username;
      } catch {
        // identity is best-effort
      }
      removeProject(p.id);
      let purgeError = null;
      if (flags.purge) {
        try {
          fs.rmSync(dataDir, { recursive: true, force: true });
        } catch (e) {
          purgeError = String(e.message || e);
        }
      }
      // Hash-chained like the audit ledgers: this file survives every purge it
      // records, so it carries the same tamper evidence (aos audit verify walks it).
      const removalsPath = path.join(aosHome(), 'removals.jsonl');
      appendChainedTo(
        removalsPath,
        removalsPath.replace(/removals\.jsonl$/, 'removals.1.jsonl'),
        {
          ts: nowIso(),
          id: p.id,
          name: p.name,
          repos: p.repos || [],
          runs,
          purged: Boolean(flags.purge) && !purgeError,
          error: purgeError || undefined,
          forced: Boolean(flags.force) || undefined,
          by: by || undefined,
          user,
        }
      );
      console.log(
        `✔ Unregistered project "${p.id}"${flags.purge && !purgeError ? ' and deleted its data' : ''} — receipt in ${removalsPath}`
      );
      if (flags.purge) {
        if (purgeError) {
          console.error(`⚠ could not delete the data (${purgeError}) — receipt records purged:false`);
          console.error(`  finish it manually: rm -rf ${dataDir}`);
          process.exitCode = 1;
        } else {
          console.log(`  removed ${runs} run(s), the audit ledger, memory, and tokens under ${dataDir}`);
        }
      } else {
        console.log(`  data kept at ${dataDir} (${runs} run(s)) — purge later with: rm -rf ${dataDir}`);
      }
      if (p.repos && p.repos.length) {
        console.log(`  hooks in ${p.repos.length} repo(s) now no-op — strip the AOS entries from their .claude/settings.json when convenient`);
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
