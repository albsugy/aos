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

AOS is not an orchestration framework and not a platform. It's three thin parts:

1. **The spec** — a file convention under `~/.aos/`: context packs, policies,
   playbooks, run records, and audit logs. Plain files, readable by any agent
   from any provider.
2. **The skills + hooks** — a Claude Code integration: a ticket pipeline that
   runs work through intake → plan → implement → verify → package → learn, with
   hooks that enforce policy and write audit *automatically*, without the agent
   having to remember to.
3. **The console** — a local, read-only dashboard: decision queue, run states,
   verification verdicts, token economics, and a leverage ratio.

**Principles**

- **Files over platforms** — everything is markdown/YAML/JSONL in your home dir.
  `git init ~/.aos` if you want history.
- **Enforced beats remembered** — guardrails and audit live in hooks, not in
  prompts an agent can forget or ignore.
- **Don't self-certify** — verification is deterministic contracts plus an
  adversarial reviewer, not the agent grading its own homework.
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
4. **Verify** — `verification.md`: deterministic contracts + an adversarial review.
5. **Package** — `outcome.md`: summary, changes, risks, how-to-test, PR draft.
6. **Learn** — distil durable notes back into `learnings.md` / `decisions.md` / `playbooks/`.

A run carries a `meta.json` with its state (`in-progress` → `blocked` /
`awaiting-review` → `done` → `shipped`), verification verdict, attempts, token
usage, and whether an adversarial review was recorded.

**Gates.** Policy (`policy.yaml`) sorts actions into tiers. **Forbidden** actions
are denied; **gated** actions require your approval; everything else is
auto-allowed (your normal Claude Code permissions still apply on top). Gates
cover both Bash commands and file writes.

**Verification — don't self-certify.** `aos verify` runs the deterministic
`contracts` from policy (e.g. your test suite) and records pass/fail. Separately,
an **adversarial review** asks a skeptic subagent to *refute* the work. AOS can't
judge whether that review was any good, but it records whether one actually
happened — `aos run finish` reads `verification.md` and marks the run's
adversarial review `present`, `absent`, or `not-required`, and warns you when
it's missing.

**Memory that compounds.** The context pack, decisions log, and learnings are
injected into every new session automatically (see [Hooks](#hooks)), so session
two already knows what session one learned. Repeated procedures become
`playbooks/`.

**Metrics.** `aos status` and the console show a **leverage ratio** (share of
finished runs that passed verification on the first attempt — runs with no
contracts configured are never counted as passing, since nothing was verified)
and **token economics** (input, output, and cache-read tracked separately, since
cache reads cost a fraction of fresh tokens). Token numbers are best-effort:
they're recorded when a session ends, so sessions that crash aren't counted.

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
└── projects/<id>/
    ├── context/
    │   ├── pack.md                # the brief every agent loads
    │   └── decisions.md           # append-only decision log (recent lines auto-loaded)
    ├── policy.yaml                # tiers (forbidden/gated/protected_paths), plan_gate, contracts
    ├── learnings.md               # compounding gotchas & fixes (recent lines auto-loaded)
    ├── playbooks/                 # extracted repeatable procedures
    ├── sessions.jsonl             # per-session token usage
    ├── state.json                 # which run is active
    ├── audit.jsonl                # project-level audit (actions outside a run)
    └── runs/<date>-<ticket>/
        ├── ticket.md  plan.md  verification.md  outcome.md
        ├── audit.jsonl            # every action, gate decision, and verdict for this run
        └── meta.json              # state, verification, attempts, tokens, adversarial-review status
```

Inside each registered **repo**, `aos init` also writes:

```
.claude/
├── skills/aos-ticket, aos-verify, aos-learn, aos-ask   # the slash-command skills
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
  adversarial_review: true   # /aos-verify must spawn a skeptic subagent (false to opt out)
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
globs → script-content scan → allow.

**Always-on built-ins** (merged in, cannot be silently removed):

- **Structural `rm` check** — catches recursive deletes of `/`, `~`, `$HOME` (and
  `/*` etc.) regardless of flag order, `sudo`, or wrappers — beyond what a plain
  regex catches.
- **Default forbidden** — force-push (plain `--force`, `-f`, and `+refspec`);
  recursive delete of root/home.
- **Default gated** — `git push`, `gh pr merge`, `deploy` (anchored so
  `cat docs/deploy.md` doesn't trip it), and `aos run approve` (plan approval is
  yours to give — the prompt *is* the approval).
- **Self-protection** — writes to `.claude/settings.json` (rewiring hooks),
  anything under `.git/hooks/`, and AOS's own state files (`policy.yaml`,
  `audit.jsonl`, `meta.json`, `state.json`, `sessions.jsonl`, `registry.yaml`)
  require approval, so an agent can't disable its own guardrails.
- **Script-content scan** — a shell script being written is scanned with the same
  policy, so a gated/forbidden command can't be laundered into a file and run
  later.

A broken regex or glob is skipped, never taking the whole gate down.

## Hooks

`aos init` wires four hooks into the repo's `.claude/settings.json`. They run
automatically — no skill invocation needed.

| Hook | Effect |
|---|---|
| `SessionStart` | Injects the project's context pack, recent decisions, learnings, and open runs into every new session. |
| `PreToolUse` | Gates **Bash and file writes** (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`) against `policy.yaml`: forbidden → blocked, gated/protected → requires your approval. Protected paths are enforced on the shell path too (`tee`, `> file`, `sed -i` naming a protected target get the same ask), and evasive git-push forms (`git -C . push`) are caught structurally. Enforces `plan_gate: ask` — including write-intent Bash — until `aos run approve`. |
| `PostToolUse` | Appends every action to the run's `audit.jsonl`, and binds a run to the session that started it (so concurrent sessions don't pollute its trail). |
| `SessionEnd` | Records token usage — fresh input, output, and cache reads separately — per session and per run. |

**Design guarantees.** The hook command calls the stable `aos` launcher with a
`PATH` fallback and a trailing `|| true`, so a missing or broken AOS can **never**
break a Claude Code session. `aos init` is idempotent and migrates stale entries
(e.g. hooks pinned to an old install path). Hooks are Claude Code-specific; the
CLI and console work without them.

## Skills

`aos init` installs four slash-command skills into `.claude/skills/`:

- **`/aos-ticket <ticket>`** — runs the full six-stage pipeline (intake → plan →
  implement → verify → package → learn) and ends `awaiting-review` with a PR
  draft in `outcome.md`.
- **`/aos-verify`** — runs the contracts and spawns a skeptic subagent to refute
  the work; appends findings to `verification.md` under an `## Adversarial review`
  heading (which `aos run finish` looks for). Use standalone anytime.
- **`/aos-learn`** — distils the session into `learnings.md`, `decisions.md`, and
  (for repeated procedures) a new `playbooks/` entry.
- **`/aos-ask <question>`** — answers from run history — past runs, decisions,
  learnings, audit — citing `file:line`.

---

# REFERENCE

## CLI commands

```
aos init [--name <name>]          Register this repo as a project (spec + skills + hooks)
aos status                        All projects: runs, states, leverage ratio, tokens
aos context [--project <id>]      Print the project context that agents load
aos run start --ticket <id> [--title <t>]   Start a run (becomes the active run)
aos run approve                   Approve the active run's plan (when plan_gate: ask)
aos run finish [--state <s>]      Finish the active run (default state: awaiting-review)
aos run state <state>             Set active run state (in-progress|blocked|awaiting-review|done|shipped)
aos run list                      List runs for this project
aos verify                        Run the verification contracts from policy.yaml
aos find <query>                  Search project memory (runs, decisions, learnings, audit)
aos export                        Write the context pack as AGENTS.md (Codex/Cursor/other runtimes)
aos console [--port <p>]          Serve the local console (default http://127.0.0.1:4560)
aos projects                      List registered projects and their memory homes
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
- `aos run finish` warns if no adversarial review was recorded in
  `verification.md` (unless policy set `adversarial_review: false`).
- `aos hook <name>` exists but is internal — the entry point the Claude Code
  hooks call.

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
       .claude/skills/aos-learn .claude/skills/aos-ask
# then delete the aos hook entries from .claude/settings.json
```

Your data in `~/.aos` is yours — it stays untouched. Delete it too if you want a
clean slate: `rm -rf ~/.aos`.
