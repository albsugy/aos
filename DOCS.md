# AOS — Documentation

The operator's manual for the Agent Operations Stack: what it is, how to install
it, and how every part works. Everything here runs on your machine from plain
files you own.

- **START** — [Overview](#overview) · [Installation](#installation) · [Quickstart](#quickstart)
- **CORE** — [Concepts](#concepts) · [Directory layout](#directory-layout) · [policy.yaml reference](#policyyaml-reference) · [Hooks](#hooks) · [Skills](#skills)
- **REFERENCE** — [CLI commands](#cli-commands) · [The console](#the-console) · [Data & privacy](#data--privacy)
- **OPERATIONS** — [Troubleshooting](#troubleshooting) · [Update & uninstall](#update--uninstall)

---

# START

## Overview

AI agents write most of the code now — and wake up every session with amnesia,
ship plausible-but-wrong work, and touch production with nothing enforcing the
rules. AOS is the operator's layer around that: **portable memory, enforced
guardrails, automatic audit, real verification, and a local console**, all stored
as markdown/YAML/JSONL under your home directory.

Spec Kit tells the agent what to build; AOS proves it followed the rules. AOS
complements the spec and task tools — they produce the plan and the task
breakdown; AOS enforces the gates, writes the audit, and verifies the result
while the work happens.

AOS is not an orchestration framework and not a platform. It's three thin parts:

1. **The spec** — a file convention under `~/.aos/`: context packs, policies,
   playbooks, run records, and audit logs. Plain files, readable by any agent
   from any provider.
2. **The skills + hooks** — a Claude Code integration: a ticket pipeline that
   runs work through intake → plan → implement → verify → package → learn, with
   hooks that enforce policy and write audit *automatically*, without the agent
   having to remember to.
3. **The console** — a local, read-only window onto the ledger and the runs:
   the decision queue, run states, verification verdicts, token economics, and
   a leverage ratio.

**Principles**

- **Files over platforms** — everything is markdown/YAML/JSONL in your home dir.
  `git init ~/.aos` if you want history.
- **Enforced beats remembered** — guardrails and audit live in hooks, not in
  prompts an agent can forget or ignore.
- **Don't self-certify** — verification is deterministic contracts plus an
  adversarial reviewer, not the agent grading its own homework. The review's
  findings are structured and the run can't close with one left open.
- **Every layer works standalone** — the hooks alone are worth installing; the
  pipeline is optional; the console is read-only.
- **Local-only** — the console binds `127.0.0.1`, and the CLI makes no network
  requests. Nothing leaves your machine.

## Installation

**Requirements**

- macOS or Linux
- Node.js **≥ 22** (`node -v`)
- `curl` and `tar` (present on any stock system) — for the curl installer
- Claude Code — only for the skills/hooks integration. The CLI and console work
  without it.
- `git` — only if you build from source.

**Install**

```bash
# with npm:
npm i -g @albsugy/aos

# or without an npm client:
curl -fsSL https://cdn.jsdelivr.net/npm/@albsugy/aos/install.sh | bash
```

Both channels deliver the same artifact from the npm registry: the runtime
(`dist/aos.mjs` with dependencies inlined, plus the skills/templates in
`assets/`). The curl installer resolves the version, **verifies the registry's
sha-512 integrity hash**, unpacks to `~/.local/share/aos`, links
`~/.local/bin/aos`, and adds that directory to your `PATH` (zsh, bash, or fish)
if needed.

**Build from source**

```bash
git clone https://github.com/albsugy/aos.git && cd aos
npm ci && npm run build
ln -sf "$PWD/dist/aos.mjs" ~/.local/bin/aos
```

`AOS_FROM_SOURCE=1` with the curl installer does the same. Releases published to
npm carry [provenance attestations](https://docs.npmjs.com/generating-provenance-statements),
so you can verify a bundle was built from this repo by CI.

**Install-time environment overrides**

| Variable | Default | Purpose |
|---|---|---|
| `AOS_VERSION` | `latest` | Version to install, e.g. `AOS_VERSION=0.7.0` to pin |
| `AOS_INSTALL_DIR` | `~/.local/share/aos` | Where the app lives |
| `AOS_BIN_DIR` | `~/.local/bin` | Where the `aos` symlink goes |
| `AOS_NPM_REGISTRY` | `registry.npmjs.org` | Alternate registry (mirrors, proxies) |
| `AOS_TARBALL_URL` | — | Direct tarball URL (testing); sha-256 read from `<url>.sha256` |
| `AOS_FROM_SOURCE` | `0` | `=1` clones and builds from source (needs git + npm) |
| `AOS_REPO_URL` | `https://github.com/albsugy/aos.git` | Source-mode repo |
| `AOS_REF` | `main` | Source-mode branch/tag |
| `AOS_HOME` | `~/.aos` | Where your **data** lives (runtime, not install-time) |

Diagnose any install with `aos doctor`.

## Quickstart

```bash
cd your-repo
aos init                # register the project + scaffold ~/.aos/projects/<id>/,
                        # install skills into .claude/skills/ and hooks into .claude/settings.json
```

`aos init` inspects the repo and **drafts a context pack** from what it finds
(README summary, `package.json`, frameworks, top-level dirs, other ecosystems)
and **seeds verification contracts** from your scripts (`test` as required;
`lint`/`typecheck` as advisory). It's a starting point — review it:

```
~/.aos/projects/<id>/context/pack.md   # what every agent must know
~/.aos/projects/<id>/policy.yaml       # gates + verification contracts
```

Then, inside a Claude Code session in that repo:

```
/aos-ticket LIN-482     # runs the full pipeline; ends awaiting your review
```

And from a terminal at any time:

```bash
aos status              # all projects: runs, states, leverage ratio, tokens
aos console             # http://127.0.0.1:4560
```

---

# CORE

## Concepts

**The spec.** Everything AOS knows lives as files under `~/.aos/`. A `registry.yaml`
maps a project id to its repo path(s); each project gets a home under
`projects/<id>/`. Because it's all plain files, any tool — or any agent from any
provider — can read it, and you can version it with `git init ~/.aos`.

**Runs and the pipeline.** A *run* is one unit of work (a ticket, bug, chore).
The `/aos-ticket` skill moves it through six stages, each leaving a file behind:

1. **Intake** — `ticket.md`: the source ticket + an explicit acceptance-criteria checklist.
2. **Plan** — `plan.md`: approach, files to touch, risks, test strategy.
3. **Implement** — code, on a branch; the hooks audit and gate as it goes.
4. **Verify** — deterministic contracts (`verification.md`) + an adversarial
   review recorded as structured findings (`review.json`), which the finish gates on.
5. **Package** — `outcome.md`: summary, changes, risks, how-to-test, PR draft.
6. **Learn** — distil durable notes back into `learnings.md` / `decisions.md` / `playbooks/`.

A run carries a `meta.json` with its state, verification verdict, attempts, token
usage, the adversarial review's state and finding counts, and its **provenance**:
the `branch` (read straight off `.git/HEAD` at start and re-read at finish, since
work often begins on main and moves to a feature branch), `ticket_url` when
`--ticket` was given a tracker URL, `pr_url` once linked, and `files` —
the paths the run actually touched, reconstructed from its own audit trail
rather than from what the run claimed. Shell writes are counted (`bash_writes`)
but never parsed into filenames: guessing would produce a list that looks
authoritative and is wrong.

Nothing can auto-detect a PR without a network call the CLI refuses to make, so
the pipeline records it:

```bash
aos run link --pr https://github.com/acme/app/pull/91
aos run link --run 2026-07-26-lin-482 --ticket-url https://linear.app/... --branch feat/limits
```

Only `http(s)` URLs are stored — a `javascript:` URL in `meta.json` would become
a click target in the console, so it is refused at capture and again at render. States form a **real state
machine**, not free text: `in-progress ↔ blocked`, `in-progress → awaiting-review`
(via `aos run finish`), `awaiting-review → done | shipped | in-progress` (reopen),
`done → shipped` (and reopen paths back); `shipped` is terminal. Illegal jumps —
like `in-progress → shipped`, which would skip review entirely — are rejected;
`--force` overrides and is recorded in the audit.

**Sign-off identity.** Closing a run — `aos run state done|shipped` or
`aos run finish --state done|shipped`, which reach the same terminal state and
are gated identically — and approving
a plan (`aos run approve`) both record who signed off and how — `closed_by` /
`approved_by`, carrying the OS user, the route, and a timestamp — in the run's
meta and audit. Five routes, strongest first:

| `via` | What it means |
|---|---|
| `tty` | An interactive terminal under this OS user ran the command |
| `gate-prompt` | The PreToolUse gate asked, and the human approved the prompt |
| `dry-run` | The project is in `dry_run`, so the gate never prompted anyone |
| `headless-env` | `AOS_ALLOW_HEADLESS_APPROVE=1` — the CI escape hatch |
| `prompt` | Unverified; only accepted where no sign-off is required |

`gate-prompt` is how the close normally happens. AOS used to require a TTY for
it, which was right about *who* may close a run and wrong about *where*: the
human is in the Claude Code session, not in a second terminal, and runs that
needed a context switch to close never closed. So the gate — which already stops
the command and shows the human its exact text — mints a single-use, 5-minute
ticket when it asks, and the CLI consumes it as sign-off.

What that proves is narrow and worth stating: the command was gated, and then it
ran, which cannot happen without someone approving the prompt. It is not proof
against an agent that invokes `aos hook pre-tool` itself to mint a ticket — the
same deliberately-adversarial model the rest of the hook layer does not cover,
and an agent willing to forge sign-off would just pass `--force`. With no route
at all, the close refuses and names all three ways to authorize it.

**Permission modes — what survives `--dangerously-skip-permissions`.** Claude
Code fires `PreToolUse` in *every* permission mode, and honours a hook's `deny`
**even in `bypassPermissions`**. So AOS's forbidden tier — force-push, recursive
deletes of root/home — holds no matter how the session was started. That is the
strongest claim in this document and it is not conditional.

The `ask` tier is conditional, and the docs say so plainly. An `ask` only
reaches a human in a mode that actually prompts (`default`, `plan`). In
`acceptEdits` and `auto`, whole categories of tool call are auto-approved
before anyone sees them; `dontAsk` auto-denies; `bypassPermissions` skips the
checks. AOS cannot make a prompt appear where the runtime has decided not to
show one, so in those modes treat the gated tier as **advisory** — the decision
is still recorded, but nobody was asked.

Two consequences AOS handles for you:

- Every gate line in `audit.jsonl` records the `mode` it was decided under. An
  `ask` logged in `bypassPermissions` did not necessarily reach anybody, and an
  auditor reading the trail later has no other way to tell.
- **No sign-off ticket is minted outside a prompting mode.** The ticket's whole
  claim is "the gate asked, then the command ran, so somebody approved" — which
  is false when the mode auto-approves. `aos run state done` therefore refuses
  in those modes and points at the terminal, rather than accepting a sign-off
  nobody gave.

If you run agents in `bypassPermissions`, pair AOS with OS-level isolation. The
deny tier is a backstop, not a sandbox.

**Gates.** Policy (`policy.yaml`) sorts actions into tiers. **Forbidden** actions
are denied; **gated** actions require your approval; everything else is
auto-allowed (your normal Claude Code permissions still apply on top). Gates
cover both Bash commands and file writes.

**Verification — don't self-certify.** `aos verify` runs the deterministic
`contracts` from policy (e.g. your test suite) and records pass/fail. Separately,
an **adversarial review** asks a skeptic subagent to *refute* the work, and
records what it found as structured claims in the run's `review.json`:

```json
{
  "reviewer": "skeptic subagent",
  "scope": ["src/gate.js", "acceptance criterion 2", "npm test"],
  "findings": [
    {
      "severity": "high",
      "summary": "the gate never fires on the shell path",
      "location": "src/gate.js:12",
      "status": "fixed",
      "resolution": "extended the check to Bash redirects and tee"
    }
  ]
}
```

This one is **enforced, not reported**: `aos run finish` refuses to move the run
to `awaiting-review` while `review.json` is missing, malformed, or holds a
finding still marked `open`. `status` is `fixed` | `dismissed` | `deferred` |
`open`; everything but `open` needs a written `resolution`. `findings: []` is a
legitimate outcome of a genuine hunt — but `scope` must still say what was hunted
through. Validate the file any time with `aos run review`; the run's meta records
the resulting state (`clean`, `resolved`, `open`, `invalid`, `absent`,
`not-required`, `forced`) plus the counts.

Be clear about what this does and does not prove. It does **not** prove the
review was any good — only another reviewer can judge that, and a determined
model can still write a shallow review that validates. What it does prove is that
explicit claims were made, each with a disposition a human can audit, and that no
run reached review with a known-open finding inside it. Escape hatches exist and
are loud: `aos run finish --force` finishes anyway and stamps the run
`adversarial_review: forced` in both meta and audit; `adversarial_review: warn`
in policy downgrades the gate to a warning; `false` turns it off entirely.

**Memory that compounds.** The context pack, decisions log, and learnings are
injected into every new session automatically (see [Hooks](#hooks)), so session
two already knows what session one learned. Repeated procedures become
`playbooks/`. The injected context is budgeted: the pack plus the last ~40
decision and ~30 learning lines, with the memory sections guaranteed their share
(a bloated pack gets truncated before it can crowd out learnings). When
`learnings.md` outgrows its window, the session is told to compact it
(`/aos-learn` step 6) instead of letting old knowledge silently stop loading;
`aos find` always searches everything on disk. Learnings are also **captured, not
just hoped for**: a session that does substantive work without writing memory is
flagged at SessionEnd, surfaced to the next session, and — when its run finished
without learnings — stopped once at session end so the model that did the work
extracts them while it still has the context (`learnings_capture: false` in
policy.yaml opts out).

**Metrics.** `aos status` and the console show a **leverage ratio** (share of
finished runs that passed verification on the first attempt — runs with no
contracts configured are never counted as passing, since nothing was verified)
and **token economics** (input, output, and cache-read tracked separately, since
cache reads cost a fraction of fresh tokens).

The leverage ratio only appears once **10 runs** have finished; below that the
raw fraction is shown instead (`clean-first-pass: 1/3 runs (too few to rate)`),
because a percentage over three runs is noise dressed as a metric.

Token numbers are best-effort: they're recorded when a session ends, so sessions
that crash aren't counted. A session that ends more than once — resume, `/clear`
and logout each fire SessionEnd against the same, still-growing transcript —
appends its cumulative total each time, so readers deduplicate by session id and
keep the largest total. Runs bound to a session were always settled exactly
once; runs started outside one now keep a per-session high-water mark instead of
re-adding the cumulative total, and a `run finish` the review gate refuses does
not settle at all.

**Cost estimates.** Usage is recorded per model, and the console and
`aos status` derive an **estimated dollar cost at Anthropic API list prices**
(cache reads at 0.1× input, cache writes at 1.25×/2×). Two honesty caveats:
subscription (Max/Pro) usage isn't billed per token, so read the number as
API-equivalent value; and models without a pricing rule are shown as tokens,
never guessed. Override or extend the rates in `~/.aos/pricing.yaml`
(`- match: "claude-opus-*"` globs with `input`/`output` in $ per MTok) — prices
are applied at display time, so a table update corrects history retroactively.

## Directory layout

```
~/.aos/
├── registry.yaml                  # project id → repo paths
├── removals.jsonl                 # receipt for every aos remove (survives --purge)
└── projects/<id>/
    ├── context/
    │   ├── pack.md                # the brief every agent loads
    │   └── decisions.md           # append-only decision log (recent lines auto-loaded)
    ├── policy.yaml                # tiers (forbidden/gated/protected_paths), plan_gate, contracts
    ├── learnings.md               # compounding gotchas & fixes (recent lines auto-loaded)
    ├── playbooks/                 # extracted repeatable procedures
    ├── sessions.jsonl             # per-session token usage
    ├── ingest.json                # transcript-ingest watermarks (aos ingest)
    ├── state.json                 # which run is active
    ├── audit.jsonl                # project-level audit (actions outside a run) — hash-chained
    └── runs/<date>-<ticket>/
        ├── ticket.md  plan.md  verification.md  review.json  outcome.md
        ├── audit.jsonl            # every action, gate decision, and verdict for this run — hash-chained
        └── meta.json              # state, verification, attempts, tokens, adversarial-review status
```

Inside each registered **repo**, `aos init` also writes:

```
.claude/
├── skills/aos-ticket, aos-verify, aos-approve, aos-learn, aos-ask, aos-onboard   # the slash-command skills
└── settings.json                                       # the four AOS hook entries
```

`~/.aos` is yours — back it up, or `git init ~/.aos` for full history.

## policy.yaml reference

Policy is per-project (`~/.aos/projects/<id>/policy.yaml`). Missing or malformed
policy falls back to the built-in defaults. Your rules are **merged on top of**
the defaults, so the built-in protections below are always active even if your
file only sets a few things.

```yaml
version: 1

# auto: the agent proceeds after writing plan.md
# ask:  implementation file writes stay gated until you run `aos run approve`
plan_gate: auto

tiers:
  # Bash patterns are JavaScript regexes, matched case-insensitively against the command.
  forbidden:            # → denied
    - pattern: 'push\s+[^|;&]*(--force(?!-with-lease)\b|(?<=\s)-f\b)'
      reason: Force-push is forbidden by policy
  gated:                # → require your approval (Claude Code shows a prompt)
    - pattern: '\bgit\s+push\b'
      action: git-push
  # protected_paths are globs, matched against absolute AND repo-relative file paths.
  protected_paths:
    - pattern: '.env*'
      decision: ask     # or: deny
      reason: Environment files hold secrets

verification:
  # true: ENFORCED — `aos run finish` refuses while review.json is missing,
  # malformed, or has an open finding. `warn`: record only. false: not required.
  adversarial_review: true
  # executable findings (opt-in): high-severity open/fixed findings must carry
  # a `reproduce` command; `aos run review` runs it, and the gate refuses
  # ("unproven") until the exit status matches the claim. See below.
  executable_findings: false
  contracts:
    - name: tests
      command: npm test
      required: true         # a failed required contract blocks awaiting-review
    - name: lint
      command: npm run lint
      required: false
    # - timeout_ms: 600000   # optional per-contract timeout (default 10 min)
```

**How a command is evaluated** (first match wins): a structural catastrophic-`rm`
check → your + built-in `forbidden` → your + built-in `gated` → allow.

**How a file write is evaluated**: built-in self-protection → your `protected_paths`
globs → script-content scan → plan gate → scope gate → allow.

**Scope gate.** When a run's `plan.md` has a `## Files` (or `## Scope`) section,
writes to files outside that list ask for approval. This is the one gate that
knows what the work is *supposed* to be: everything else asks "is this command
dangerous", this asks "is this the change you described" — the drift that plan
approval alone cannot catch, where an agent gets sign-off for a two-file fix and
then refactors nine other modules.

It is **self-activating**: a plan with no Files section declares no scope and
gates nothing, so no existing project changes behavior and there is no flag to
remember. Entries may be exact paths (`src/gate.js`), directories (`docs/`), or
globs (`test/**/*.sh`); trailing commentary and backticks are stripped, and
prose lines that aren't paths are ignored. Parsing is deliberately narrow in one
direction: a line phrased as an exclusion ("Do not touch config/production.yaml")
is never read as a declaration, because a scope gate that grants what the plan
forbids is worse than no scope gate. If a `## Files` section is written in a
shape the parser doesn't recognize, it declares nothing and the gate stays
off — check with `aos context` or by writing an out-of-scope file and seeing
whether it asks. The run's own folder and project
memory stay writable. Always `ask`, never deny — being outside the plan is not
proof of a mistake, and the honest response is to show you the drift. Set
`scope_gate: false` to switch it off.

**Dry run.** `dry_run: true` records what every gate *would* decide to the audit
and lets the tool through anyway — for tuning a policy against your real
workflow before it starts blocking things. `aos status` prints the suppressed
decisions with a breakdown by action, and **`aos doctor` fails while it is on**:
a forgotten `dry_run` looks exactly like a healthy install from inside a session,
because nothing ever prompts. No sign-off tickets are minted in dry run either —
there is no prompt to approve.

**Always-on built-ins** (merged in, cannot be silently removed):

- **Structural `rm` check** — catches recursive deletes of `/`, `~`, `$HOME` (and
  `/*` etc.) regardless of flag order, `sudo`, or wrappers — beyond what a plain
  regex catches.
- **Working-tree guard** — `git reset --hard`, `git clean -f`, `git checkout -- .`,
  `git restore`, `git switch --force`, `git branch -D`, and `git stash drop|clear`
  destroy work that exists in no commit. None of them names the file it
  overwrites, so nothing else in the gate saw them. Parsed structurally (flag
  clusters, `git -C .`, `env`/`sudo` and `VAR=x` prefixes) and always **ask**,
  never deny — every one is a command a human legitimately means. Non-destructive
  neighbours stay silent: `git checkout <branch>`, `git checkout -b`,
  `git restore --staged`, `git reset --soft`, plain `git stash`. Set
  `tiers.protect_worktree: false` to disable. This is the accident that actually
  happens; `rm -rf /` is the one that gets written about.

  `git checkout X` is a branch switch or a destructive path restore depending on
  what `X` *is*, and the name cannot settle it — a branch may be called
  `fix/typo.md` and a directory may be called `src`. So the guard asks the
  working tree, the same question git asks: an operand that exists is a path and
  gets the prompt, one that does not is a ref and does not. Two operands
  (`git checkout <ref> <path>`) and an explicit `--` are git's own grammar for a
  path restore and always ask. Where there is no working directory to consult —
  the script-content scan, which reads a file that will run somewhere else — it
  falls back to the name's shape and errs toward asking.
- **Default forbidden** — force-push (plain `--force`, `-f`, and `+refspec`);
  recursive delete of root/home.
- **Default gated** — `git push`, `gh pr merge`, `deploy` (anchored so
  `cat docs/deploy.md` doesn't trip it), and the two sign-off commands
  `aos run approve` and either spelling of a close (`run state done|shipped`,
  `run finish --state done|shipped`) — all yours to give (
  the prompt *is* the approval, and approving it mints the sign-off ticket the
  CLI records).
- **Command aliasing** — the program a token invokes is resolved before any check:
  path stripped, GNU `g`-prefixes folded (`gsed`, `gawk`, `gcp`), `busybox`/
  `toybox` applets unwrapped, and `sudo`/`env`/`VAR=x` prefixes skipped. `git`,
  `grep` and `gh` are deliberately not folded.
- **Self-protection** — writes to `.claude/settings.json` (rewiring hooks),
  anything under `.git/hooks/`, and AOS's own state files (`policy.yaml`,
  `audit.jsonl`, `meta.json`, `state.json`, `sessions.jsonl`, `registry.yaml`,
  `signoff.json`) require approval, so an agent can't disable its own guardrails
  or forge a sign-off. Enforced on the shell path too.
- **Script-content scan** — a shell script being written is scanned with the same
  policy, so a gated/forbidden command can't be laundered into a file and run
  later.

A broken regex or glob is skipped, never taking the whole gate down.

## Hooks

`aos init` wires five hooks into the repo's `.claude/settings.json`. They run
automatically — no skill invocation needed.

| Hook | Effect |
|---|---|
| `SessionStart` | Injects the project's context pack, recent decisions, learnings, and open runs into every new session. |
| `PreToolUse` | Gates **Bash and file writes** (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`) against `policy.yaml`: forbidden → blocked, gated/protected → requires your approval. Protected paths are enforced on the shell path too (`tee`, `> file`, `sed -i` naming a protected target get the same ask), and evasive git-push forms (`git -C . push`) are caught structurally. Enforces `plan_gate: ask` — including write-intent Bash — until `aos run approve`. |
| `PostToolUse` | Appends every action to the run's `audit.jsonl`, and binds a run to the session that started it (so concurrent sessions don't pollute its trail). |
| `SessionEnd` | Records token usage — fresh input, output, and cache reads separately — per session and per run. Flags sessions that did substantive work without writing learnings (`learnings_owed`), so the next session sees the debt. |
| `Stop` | Collects what the run still owes, while the model that did the work still has it in context. Two independent asks, each blocking the stop at most once: **close the review** when the session's run is sitting at `awaiting-review` (present the change, propose `done`/`shipped`, let the gate prompt the human for sign-off) and **extract learnings** when a finished run recorded none. Guarded: once per session per ask, never mid-run; `review_capture: false` / `learnings_capture: false` opt out. |

**Design guarantees.** The hook command calls the stable `aos` launcher with a
`PATH` fallback and a trailing `|| true`, so a missing or broken AOS can **never**
break a Claude Code session. `aos init` is idempotent and migrates stale entries
(e.g. hooks pinned to an old install path). Hooks are Claude Code-specific; the
CLI and console work without them.

## Skills

`aos init` installs the slash-command skills into `.claude/skills/`:

- **`/aos-onboard`** — replaces the scaffolded templates with the repo's actual
  truth: fills the context pack from the code, mines git history for
  `decisions.md`, seeds learnings from CI configs/TODOs, and authors
  verification contracts (writing policy.yaml is ask-gated, so you review
  them). The session-start context nags until the pack stops being a template.
- **`/aos-ticket <ticket>`** — runs the full six-stage pipeline (intake → plan →
  implement → verify → package → learn) and ends `awaiting-review` with a PR
  draft in `outcome.md`.
- **`/aos-verify`** — runs the contracts and spawns a skeptic subagent to refute
  the work, then records its findings and their dispositions in the run's
  `review.json` — the file `aos run finish` gates on. Use standalone anytime.
- **`/aos-learn`** — distils the session into `learnings.md`, `decisions.md`, and
  (for repeated procedures) a new `playbooks/` entry.
- **`/aos-ask <question>`** — answers from run history — past runs, decisions,
  learnings, audit — citing `file:line`.

---

# REFERENCE

## CLI commands

```
aos init [--name <name>] [--hooks-only]   Register this repo as a project (spec + hooks; skills unless --hooks-only)
aos status                        All projects: runs, states, leverage ratio, tokens, dry-run warnings
aos cost [--since 7d] [--by project|run|model|contract] [--all]   Estimated spend at API list prices
aos context [--project <id>]      Print the project context that agents load
aos run start --ticket <id|url> [--title <t>]   Start a run (branch auto-detected; a URL is kept as the ticket link)
aos run approve                   Approve the active run's plan (when plan_gate: ask)
aos run review [--run <id>]       Validate the run's adversarial review (what the finish gate checks)
aos run finish [--state <s>]      Finish the active run (default: awaiting-review); blocked by an unsatisfied review gate
aos run state <state> [--run <id>] [--force]  Set run state (validated state machine; --force overrides, audited). done/shipped are gated: approving the prompt IS the sign-off (see /aos-approve)
aos run link [--pr <url>] [--ticket-url <url>] [--branch <name>]  Attach the PR / ticket / branch to a run
aos run list                      List runs for this project
aos run session [--run <id>]      Print the session id bound to a run — resume its crewmate with: claude --resume $(aos run session --run <id>)
aos verify                        Run the verification contracts from policy.yaml
aos policy test [--file <p.yaml>] [--since 30d]   Policy CI — replay recorded agent traffic against a policy
aos audit verify [--project <id>] Check every audit ledger's hash chain (tamper evidence)
aos ingest [--dry-run]            Backfill audit + token history from Claude Code transcripts
aos find <query> [--all]          Search project memory; --all sweeps every registered project
aos export                        Write the context pack as AGENTS.md (Codex/Cursor/other runtimes)
aos fleet [--launch [runtime]]    Scaffold the primary-agent hub at ~/.aos/fleet; --launch opens it (claude|codex|opencode|droid; bare = first installed)
aos console [--port <p>]          Serve the local console (default http://127.0.0.1:4560)
aos projects                      List registered projects and their memory homes
aos remove <id> [--purge] [--force]  Unregister a project; --purge deletes its data (sign-off required)
aos doctor                        Diagnose the install, registry, and this repo's wiring
aos version                       Print the installed version
aos update                        Update in place
aos help                          Show help
```

Notes:

- Most commands resolve the project from your working directory; pass
  `--project <id>` to target another. `aos init --name <name>` overrides the id.
- `aos verify` exits `0` when all **required** contracts pass, `1` otherwise — so
  it's scriptable. When a run is active it writes `verification.md` and updates
  the run's verdict.
- `aos run finish` **refuses** while the adversarial review is missing,
  malformed, or has an open finding — `aos run review` shows the same verdict on
  demand, and `--force` finishes anyway (recorded as `forced` in meta + audit).
  `adversarial_review: warn` in policy downgrades the gate to a warning.
- `aos run review` also **executes** any `reproduce` commands recorded in
  review.json (`--no-execute` skips) and writes the results back as an
  `executions` array — with `executable_findings: true` in policy, the finish
  gate refuses ("unproven") until every demonstrable high-severity finding's
  command has actually run with the exit status its status claims.
- `aos hook <name>` exists but is internal — the entry point the Claude Code
  hooks call.

### Removing a project

`aos remove <id>` unregisters the project — the console, `aos status`, and
`run` commands stop seeing it, and the hooks in its repos become silent
no-ops (they stay harmless in `.claude/settings.json` until you strip them).
The data under `~/.aos/projects/<id>/` is **kept** and the removal is
recorded in `~/.aos/removals.jsonl`.

- **Open runs block it**: removal refuses while a run is `in-progress` or
  `blocked` — finish or park it first, or override with `--force`.
- **`--purge` deletes the data** (runs, the chained audit ledger, memory,
  tokens) and requires a human sign-off: an interactive terminal, the gate
  prompt (the command is gated by default policy — unregistering turns a
  repo's gates off, so an agent running it is asked, and approving the
  prompt is the sign-off), or `AOS_ALLOW_HEADLESS_APPROVE=1` in CI. The
  receipt written to `removals.jsonl` survives the purge and names the
  route that authorized it.
- Removal without `--purge` is reversible: re-run `aos init` in the repo to
  re-register — the existing data is picked back up.

### `aos cost`

What the agent actually cost, estimated at published API list prices from the
per-model token buckets AOS records. Two numbers, always reported separately,
because collapsing them would overstate how much of your work the pipeline
covers:

- **Session spend** — every token the agent burned in the repo, tracked or not.
- **In runs** — the part that happened inside a run. The `Tracked` column is the
  share, and it is usually the more interesting number.

```bash
aos cost                       # this repo, all time
aos cost --all --since 7d      # every project, last week
aos cost --by run              # per run, with verification attempts
aos cost --by model            # per model, cache reads and writes split out
aos cost --by contract         # which contracts fail, and what those runs cost
```

`--since` takes `7d` / `24h` / `2w` or any parseable date; an unreadable value is
an error rather than a silently unfiltered report. Models with no pricing rule
are never guessed at — their tokens are counted as `unpriced` and called out.

**Estimates, not invoices.** Subscription (Max/Pro) usage is not billed per token
at all, and Bedrock/Vertex rates differ. `--since` filters on when a session
*ended*, and a session that was resumed reports its whole cumulative spend at
its last ending — so a long-running session opened before the window can land
entirely inside it. Override or extend the table at
`~/.aos/pricing.yaml`. `--by contract` reports "cost of runs where this contract
failed", *not* "cost this contract's failures caused" — retry tokens are not
separable from the rest of a run, and the header says so rather than implying a
precision that isn't there.

**On the run itself.** When a run's tokens settle, its price tag is stamped into
`outcome.md` under a `## Cost` heading, so a PR drafted from that file carries
its own cost. The stamp is marked and idempotent — re-stamping replaces it and
never touches the prose above it, and a run with no `outcome.md` is left alone.

### `aos policy test` — policy CI

A policy change is a claim about your traffic. This command replays the
commands that **actually ran** — every Bash call in the audit ledger, plus
everything `aos ingest` backfilled — against a policy that hasn't been switched
on yet, and reports what would change:

```bash
aos policy test                                # the installed policy, vs its own history
aos policy test --file candidate.yaml          # a candidate, before you install it
aos policy test --file candidate.yaml --since 30d
```

- **would DENY / would GATE** — commands that ran freely that the candidate
  would stop or prompt for, each with its run count and the rule's reason.
- **would now ALLOW** — commands the current policy stopped that the candidate
  would let through (the loosening you should double-check).

Honest limits, stated in the output too: commands are recorded truncated at
300 characters, and truncated rows are counted rather than silently treated as
clean; the stateful gates (plan, scope) are deliberately not replayed — only
the command tiers and shell-path write protection are. Exit 0 always; exit 1
only means the replay couldn't run (unreadable file, no project).

### `aos audit verify` — tamper evidence

Every audit line is hash-chained: each entry's hash covers its own content and
the previous line's hash, so editing or deleting any line after the fact
breaks the chain at that point. `aos audit verify` walks every ledger (project
+ every run) and reports the first lines that no longer add up; exit 1 when any
tamper evidence is found, so CI or a cron can gate on it.

What it proves: the ledger is byte-for-byte as written. What it does not prove:
who wrote a line — anyone with write access can still append (an append-only
log must forgive appends). Lines from before the chain existed are counted as
`legacy`, not failures; a foreign unchained line **after** the chain started is
reported, because that is either tampering or a downgraded AOS, and both are
worth seeing.

### `aos ingest` — history backfill

The audit ledger only knows what happened since AOS was installed.
`aos ingest` backfills it from what Claude Code already wrote on disk
(`~/.claude/projects/<slug>/<session>.jsonl`), matched to your registered
repos by each session's recorded `cwd`:

- tool calls become audit lines in the project ledger — chained, marked
  `source: "ingested"`, original timestamps preserved — so **`aos policy test`
  can replay a month of real traffic against a candidate policy**;
- each session's cumulative token usage lands in `sessions.jsonl` in the same
  shape the SessionEnd hook writes (readers dedup, so re-ingesting a grown
  file replaces rather than adds).

Idempotent: per-session line watermarks in `ingest.json` mean re-runs ingest
only what a resumed session appended; a file that shrank is skipped with a
warning rather than double-counted. `--dry-run` reports without writing.
Gate decisions are not in transcripts, so ingested lines carry no verdict —
they are activity history, not gate history. `CLAUDE_CONFIG_DIR` is honoured
for non-default Claude Code installs.

### Executable findings — `reproduce` on high-severity findings

With `verification.executable_findings: true`, the review gate stops trusting
prose for the findings that matter most: a **high-severity `open` or `fixed`
finding must carry a `reproduce` command**, `aos run review` executes it in a
real subprocess, and the gate holds the run at `unproven` until the exit
status matches the claim:

- `open` → the command must **fail** (the bug, demonstrated);
- `fixed` → the command must **pass** (the fix, holding).

Results are written back into `review.json` as `executions` (with expected
status, exit, duration), the execution is audited, and a finding whose status
changed since its execution reads as unproven again. `dismissed`/`deferred`
findings and lower severities are exempt — those are judgements, not
executable claims. What this proves: the claim was checked against the
machine. What it does not: that the command is a *fair* test — a skeptic can
still point `reproduce` at something trivial; the human reading the run
still matters. Off by default; `--force` still overrides, loudly.

## The fleet — a primary agent over all projects

**What it is.** `aos fleet` scaffolds `~/.aos/fleet/` — an `AGENTS.md` (with a
`CLAUDE.md` import shim) that turns a plain agent session opened there into a
**primary agent aware of every project you've registered**: it routes requests
by project name, dispatches crewmate sessions to do the actual work, and
reports back outcomes plus the decisions that need you. The hub is files, not
a service — AOS remains the memory/governance layer; the runtime does the
orchestrating.

**The invariant:** AOS never executes agents by default — agents execute AOS.
`aos fleet` only writes files and prints how to start. `--launch` is the
explicit convenience that spawns a runtime in the hub (stdio passed through,
nothing managed):

| Runtime | Start manually | Reads the hub via |
|---|---|---|
| Claude Code | `cd ~/.aos/fleet && claude` | `CLAUDE.md` shim (`@AGENTS.md`) |
| Codex CLI | `cd ~/.aos/fleet && codex` | `AGENTS.md` natively |
| opencode | `cd ~/.aos/fleet && opencode` | `AGENTS.md` natively |
| Factory Droid | `cd ~/.aos/fleet && droid` | `AGENTS.md` natively |

`aos fleet --launch` (bare) picks the first of those found on PATH;
`aos fleet --launch codex` picks one explicitly.

**Why.** One agent you brain-dump to beats juggling a session per repo — but
only if that agent has durable, current knowledge of everything. That is
exactly what `~/.aos` already is. The fleet hub is the thin instruction layer
that hands the whole spec to a single session:

- `aos projects` / `aos status` — what exists, what's running, what needs you
- `aos context --project <id>` — any project's pack, decisions, learnings
- `aos find "<query>" --all` — cross-project recall ("have we solved this
  anywhere before?")
- `aos run session --run <id>` — the Claude Code session bound to a run
  (recorded automatically by the hooks), so the hub can resume the exact
  crewmate that did the work: `claude --resume $(aos run session --run <id>)`

**How to use it.**

```bash
aos fleet                    # scaffold (first time) + print how to start
aos fleet --launch           # optional: open the hub in the first installed runtime
cd ~/.aos/fleet && claude    # or start it yourself with any supported runtime
```

Then just talk to it: "what's waiting on me?", "fix the flaky test in
<project>", "have we ever dealt with rate limiting anywhere?". The shipped
AGENTS.md encodes the discipline that makes this work: the hub **delegates,
never implements** (a busy orchestrator is an unavailable one); every real task
is dispatched as an AOS run so it lands in your decision queue; crewmate
transcripts go to `~/.aos/fleet/reports/`; and gated actions (pushes, merges,
closing reviews) always stop at your approval prompt — the hub cannot sign off
on its own work, or anyone else's.

The scaffold never overwrites your `AGENTS.md`: tune it freely (the file even
tells the hub agent it may improve its own routing, logging changes to
`fleet/log.md`). Re-running `aos fleet` only fills in missing files. The
routing table is generated from your registry at scaffold time; refresh it from
`aos projects` output when you add projects.

## The console

```bash
aos console                 # http://127.0.0.1:4560
aos console --port 4599     # pick another port
```

A **read-only** dashboard with three screens:

- **Overview** — fleet KPIs (projects, runs needing you with the oldest wait,
  runs in progress, tokens, estimated cost), the decision queue (everything
  blocked or awaiting review, stale items flagged), and a card per project
  with its leverage ratio and run-state counts.
- **Project** — leverage/runs/tokens KPIs (median cycle time, estimated cost)
  and a tokens-per-session sparkline, a filterable + searchable runs table
  with per-run cost, the project's memory (context pack, decisions,
  learnings — rendered), and a policy digest with adversarial-review coverage
  and per-contract failure counts.
- **Run** — a pipeline stage strip, plan-approval status, and tabs for Outcome /
  Verification / Audit / Ticket / Plan, with the audit timeline filterable by
  event type.

It polls the local API every 5 seconds (and pauses while the tab is hidden).

**Security.** The server binds to `127.0.0.1` only, and additionally **refuses
requests whose `Host` header isn't localhost** (blocking DNS-rebinding from a
malicious website). Project/run ids from the URL are validated against path
traversal before they ever touch the filesystem.

## Data & privacy

- **Everything is local.** All state lives under `~/.aos` (override with
  `AOS_HOME`). It's plain files you own — read, edit, back up, or `git init` it.
- **The console never leaves your machine** — `127.0.0.1` bind plus the
  Host-header check above.
- **The CLI makes no network requests.** Only the *installer* reaches out, and
  only to the npm registry, verifying the sha-512 integrity hash before
  installing. `aos update` on a release install re-runs that local installer;
  the running CLI itself calls no remote host.
- **Token accounting** reads the local Claude Code session transcript to sum
  usage. Nothing is uploaded; there is no telemetry.
- **Uninstalling leaves your data** — see below.

---

# OPERATIONS

## Troubleshooting

Start with `aos doctor` — it checks the Node version, the app install and layout,
dependencies, whether `AOS_HOME` is writable, that the registry parses and its
repo paths exist, and whether this repo's hooks are wired in the current format.
Exit `0` means all clear.

| Symptom | Fix |
|---|---|
| `aos: command not found` | The installer adds `~/.local/bin` to your `PATH`. Restart your shell, or `export PATH="$HOME/.local/bin:$PATH"`. |
| Doctor says **node version < 22** | Install Node ≥ 22 (https://nodejs.org) and re-run. |
| Hooks don't fire, or doctor flags **old-format / Bash-only** hooks | Re-run `aos init` in the repo — it migrates stale entries and widens gating to file writes. |
| A gate blocks something you expected to allow | That's policy working. Approve the prompt (the prompt *is* the approval), or adjust the pattern in `policy.yaml`. |
| Writes are blocked with a **plan-gate** message | The run's plan isn't approved yet. Review `plan.md`, then run `aos run approve`. |
| `Port 4560 is already in use` | `aos console --port <n>`. |
| `No AOS project matches this directory` | Run `aos init` here, or pass `--project <id>`. |
| Corrupt `registry.yaml` | Reads degrade with a warning and writes refuse to clobber it — fix or remove the file, then re-run. |

## Update & uninstall

**Update**

```bash
aos update
```

- **Release installs** (curl/npm): re-runs the installer that shipped inside the
  current install — it resolves the latest version from the registry, verifies
  its sha-512, and swaps in place, or no-ops if you're already current.
- **npm global installs**: `npm update -g @albsugy/aos` also works.
- **Dev checkouts** (a git clone): `git pull` + rebuild deps as needed.

**Uninstall**

```bash
# remove the app + launcher
rm -rf ~/.local/share/aos ~/.local/bin/aos
```

Per repo, remove the AOS skills and the four hook entries:

```bash
rm -rf .claude/skills/aos-ticket .claude/skills/aos-verify \
       .claude/skills/aos-learn .claude/skills/aos-ask .claude/skills/aos-onboard
# then delete the aos hook entries from .claude/settings.json
```

Your data in `~/.aos` is yours — it stays untouched. Delete it too if you want a
clean slate: `rm -rf ~/.aos`.
