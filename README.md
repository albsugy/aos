# AOS — Agent Operations Stack

[![npm](https://img.shields.io/npm/v/@albsugy/aos?color=cb3837&logo=npm)](https://www.npmjs.com/package/@albsugy/aos)
[![CI](https://github.com/albsugy/aos/actions/workflows/ci.yml/badge.svg)](https://github.com/albsugy/aos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](package.json)

**Policy gates, an audit ledger, and project memory for Claude Code** — installed as hooks,
so they work without anybody invoking anything. Everything is markdown, YAML, and JSONL
under your home directory. Open source (MIT), no network calls, no account.

**Spec Kit tells the agent what to build; AOS proves it followed the rules.**

```bash
npm i -g @albsugy/aos && cd your-repo && aos init --hooks-only
```

That's a complete install. From the next session on, in this repo:

- every session **starts with the project's context** — the pack, recent decisions,
  learnings, open runs — injected before you type anything;
- **risky commands and writes are gated** — force-push and `rm -rf /` denied, `git push`,
  `deploy`, and `git reset --hard` asked, `.claude/settings.json` and `.git/hooks/`
  protected so the agent can't disarm its own guardrails;
- **every tool call is audited** to `audit.jsonl`, with token spend tracked per session
  alongside.

No skills, no pipeline, nothing to remember. If you later want the ticket workflow —
plan approval, contract verification, an adversarial review that has to resolve, human
sign-off — run plain `aos init` and read on.

The gates are hooks, so they hold whether or not the agent cooperates. The pipeline that
uses them is markdown, so it holds only as well as the model follows it. This README is
explicit about which is which — see [What's enforced](#whats-enforced-and-whats-convention).

AOS sits next to the spec and task tools, not against them — Spec Kit, Taskmaster, BMAD
and the like produce the plan and the task breakdown; AOS enforces what happens while the
work is done: the commands gated, every action audited, the result verified against real
contracts before a run can close. They decide what the work is; AOS proves it followed
the rules.

**Package:** [npmjs.com/package/@albsugy/aos](https://www.npmjs.com/package/@albsugy/aos)
· **Full manual:** [DOCS.md](DOCS.md)

## What's enforced, and what's convention

Both matter. Only one of them survives an agent that doesn't feel like cooperating.

| Enforced by hooks and the CLI | Convention (markdown the model follows) |
|---|---|
| **Command + file-write gates** — forbidden denied, gated asks. Shell paths (`tee`, `>`, `sed -i`) are parsed, not pattern-matched; evasive forms (`git -C . push`, `rm -Rf /*`, quoted flags, `$(…)` substitution) are caught structurally | The **quality** of a plan, a ticket write-up, or an `outcome.md` |
| **Self-protection** — an agent can't edit `.claude/settings.json`, `.git/hooks/`, or AOS's own policy/audit files without your approval | Whether the intake actually captured the ticket's real acceptance criteria |
| **Plan approval** (`plan_gate: ask`) — implementation writes stay blocked until a human approves, and `aos run approve` is itself gated so the agent can't self-approve | Whether the skeptic subagent hunted hard or glanced |
| **Review gate** — `aos run finish` refuses while the adversarial review is missing, malformed, or has an open finding | Whether a recorded learning is worth reading |
| **Sign-off** — closing a run needs a human's approval at the gate prompt (or a real TTY), recorded with your OS user and which route it came through | Whether a playbook gets proposed |
| **Working-tree guard** — `git reset --hard`, `git clean -f`, `git checkout -- .`, `git restore`, `git rm -r`, `git branch -D` are parsed structurally and gated; `git checkout <branch>`, `-b`, `--staged` restore and `--soft` reset stay silent | |
| **Scope gate** — when `plan.md` declares a `## Files` list, writes outside it ask. Self-activating: no declaration, no gating | Whether the declared file list was honest in the first place |
| **Forbidden holds in every permission mode** — Claude Code honours a hook's `deny` even under `--dangerously-skip-permissions`. The **gated** tier is conditional: modes that auto-approve (`acceptEdits`, `auto`, `bypassPermissions`) or auto-deny (`dontAsk`) mean an `ask` may never reach you, so AOS records the mode on every decision and refuses to accept a sign-off nobody gave | Whether you notice the audit line saying so |
| **Audit** — every tool call, gate decision, and verdict appended to the run's `audit.jsonl`, automatically | |
| **Tamper-evident ledgers** — every audit line is hash-chained; `aos audit verify` detects any line edited or deleted after the fact (exit 1, CI-gateable) | |
| **Executable findings** (opt-in) — high-severity `open`/`fixed` findings must carry a `reproduce` command that `aos run review` actually runs; the gate holds the run at `unproven` until the exit status matches the claim | |
| **State machine** — `in-progress → shipped` (skipping review) is rejected; `--force` is audited | |
| **Token accounting** — per run and per session, cache reads split from fresh input | |

## Install

```bash
curl -fsSL https://cdn.jsdelivr.net/npm/@albsugy/aos/install.sh | bash
```

Or with npm directly:

```bash
npm i -g @albsugy/aos
```

Requires Node ≥ 22 (curl path also needs curl + tar). Both channels deliver the same
artifact from the npm registry: the single-file bundle (`dist/aos.mjs`, dependencies
inlined) plus the skills/templates. The curl installer resolves the version from the
registry, **verifies the registry's sha-512 integrity hash**, unpacks to
`~/.local/share/aos`, and links `~/.local/bin/aos`. Pin with `AOS_VERSION=0.7.2`; update
with `aos update`; diagnose with `aos doctor`.

Prefer to build it yourself? The source is right here:

```bash
git clone https://github.com/albsugy/aos.git && cd aos
npm ci && npm run build
ln -sf "$PWD/dist/aos.mjs" ~/.local/bin/aos
```

(Or `AOS_FROM_SOURCE=1` with the curl installer.) Releases carry npm
[provenance attestations](https://docs.npmjs.com/generating-provenance-statements), so you
can verify the bundle was built from this source by CI.

Uninstall: `rm -rf ~/.local/share/aos ~/.local/bin/aos` — your data in `~/.aos` stays.

## Quickstart

```bash
cd your-repo
aos init                # registers the project, scaffolds ~/.aos/projects/<id>/,
                        # installs skills into .claude/skills/ and hooks into .claude/settings.json

# fill in the two files that matter:
#   ~/.aos/projects/<id>/context/pack.md   — what every agent must know
#   ~/.aos/projects/<id>/policy.yaml       — gates + verification contracts

# then, inside a Claude Code session in that repo:
/aos-ticket LIN-482     # runs the pipeline; ends awaiting your review

aos status              # all projects: runs, states, leverage ratio, tokens, est. cost
aos export              # write the context pack as AGENTS.md for Codex/Cursor/etc.
aos console             # http://127.0.0.1:4560
```

`aos doctor` is worth running after any move or update: hook commands end in `|| true` so
a missing `aos` can never break a session, which also means it would otherwise turn every
gate off silently. Doctor resolves them and says so.

## What the hooks do (no skill invocation needed)

| Hook | Effect |
|---|---|
| `SessionStart` | Injects the project's context pack, recent decisions, learnings, and open runs into every new session |
| `PreToolUse` | Gates Bash commands **and file writes** against `policy.yaml`: forbidden → blocked, gated/protected → requires your approval. Protected by default: `.claude/settings.json`, `.git/hooks/`, and AOS's own policy/audit files (an agent can't rewire its own guardrails) — enforced on the shell path too, so `tee`, `> file`, and `sed -i` can't sidestep the file gates. Shell scripts being written are scanned so a gated command can't be laundered into a file and executed later. When `plan_gate: ask`, implementation writes (file tools *and* write-intent Bash) stay gated until you run `aos run approve`; when a run's `plan.md` declares a `## Files` list, writes outside it ask too. `dry_run: true` records every decision without enforcing any of them |
| `PostToolUse` | Appends every action to the run's `audit.jsonl` — each run is bound to the session that started it, so concurrent sessions don't pollute its trail |
| `SessionEnd` | Records token usage (fresh input, output, and cache reads separately) per session and per run, and flags sessions that did substantive work without writing learnings |
| `Stop` | Collects what the run still owes, while the model that did the work still has it in context: closes out a run sitting at `awaiting-review` (present it, propose `done`/`shipped`, let the gate prompt you to sign off) and extracts learnings when a finished run recorded none. Each ask blocks at most once per session |

**Threat model, honestly:** these gates are accident-protection for well-meaning agents —
the failure mode that actually happens. They cover the tool paths agents really use (Bash,
file writes), but a deliberately adversarial agent needs OS-level isolation (containers,
sandboxes), which no hook layer provides. Pair AOS with sandboxing when you need a hard
boundary. Hooks also fail **open** by design: a broken gate allows rather than blocks, logs
to `~/.aos/hook-errors.log`, and `aos doctor` surfaces it. Availability over integrity is
the explicit trade.

## Verification: contracts + a review that has to resolve

`aos verify` executes the `contracts` from your `policy.yaml` — real commands (your test
suite, lint, typecheck) in a real subprocess. If no contracts are configured, it says so
and refuses to record a pass; nothing is silently green.

The adversarial review is the second half, and it's the one quality claim AOS enforces
rather than reports. A skeptic subagent tries to refute the work and records what it found
as structured claims in the run's `review.json`:

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

`aos run finish` **refuses** while that file is missing, malformed, or holds a finding
still marked `open`. `aos run review` validates it on demand.

**Executable findings** (opt in with `verification.executable_findings: true`) make the
strongest claims machine-checked: a high-severity `open` finding's `reproduce` command
must **fail** (the bug, demonstrated), a `fixed` one's must **pass** (the fix, holding) —
`aos run review` executes them in real subprocesses and the gate holds the run at
`unproven` until they do. "The review says fixed" becomes "a command that failed now
passes."

What this proves: explicit claims were made, each with a disposition you can audit, and no
run reached your review queue with a known-open finding inside it. What it does **not**
prove: that the review was any good. Only another reviewer can judge that, and a model
determined to phone it in still can. Escape hatches are deliberate and loud —
`aos run finish --force` stamps the run `adversarial_review: forced` in meta and audit;
`adversarial_review: warn` in policy downgrades the gate to a warning.

## Policy CI, tamper evidence, and history ingest

Three commands that turn the ledger from a record into evidence:

- **`aos policy test --file candidate.yaml`** — replay the commands that *actually ran*
  against a policy before you install it: what it would newly deny, newly gate, or
  newly allow. Commands are recorded truncated at 300 chars and the report says so
  rather than pretending otherwise.
- **`aos audit verify`** — every audit line is hash-chained; this walks all ledgers and
  flags any line edited or deleted after the fact. Exit 1 on tamper evidence, so CI
  can gate on it.
- **`aos ingest`** — backfill the ledger from Claude Code's own session transcripts
  (`~/.claude/projects/…`), matched to your repos by each session's `cwd`. Tool calls
  become chained audit lines (marked `source: ingested`), token usage lands in the
  session ledger — and the move that makes it sing: install AOS today, ingest a month
  of history, then tune your policy against the real traffic instead of a guess.
  Idempotent, delta-based, `--dry-run` to preview.

## The spec

```
~/.aos/
├── registry.yaml                  # project id → repo paths
├── removals.jsonl                 # receipt for every `aos remove` — survives the purge it records
├── fleet/                         # optional hub for cross-project sessions (see below)
└── projects/<id>/
    ├── context/pack.md            # the brief every agent loads
    ├── context/decisions.md       # append-only decision log
    ├── policy.yaml                # tiers (forbidden/gated/protected_paths), plan_gate, verification
    ├── learnings.md               # compounding gotchas & fixes
    ├── playbooks/                 # extracted repeatable procedures
    ├── ingest.json                # transcript-ingest watermarks (aos ingest)
    └── runs/<date>-<ticket>/
        ├── ticket.md  plan.md  verification.md  review.json  outcome.md
        ├── audit.jsonl            # every action, gate decision, verdict — hash-chained
        │                          # meta also records branch, PR/ticket links, files touched
        └── meta.json              # state, verification, review, attempts, tokens, bound session id
```

**Memory, concretely:** the pack, decisions, and learnings are curated markdown —
human-readable, diffable, auditable; `git init ~/.aos` gives you history. `SessionStart`
injects the pack plus the last ~40 decision lines and ~30 learning lines, inside a hard
character budget that protects the newest entries from a bloated pack. That's a tail, not
retrieval — no embeddings, and no AI-compressed summary paraphrasing what an agent once
knew into something it almost said; what loads is exactly what was written, and
`aos find` is a substring search across the files. It compounds because it's append-only
and always loaded, not because it's clever; when learnings outgrow the window, the session
is told to compact them rather than letting old knowledge quietly stop loading.

## Skills

Six markdown skills installed into `.claude/skills/`. They're instructions to the model —
the hooks are what hold when the model deviates.

- `/aos-onboard` — extract the repo's real context: fill the pack from the code, mine git
  history for decisions, author contracts
- `/aos-ticket <ticket>` — the six-stage pipeline (intake → plan → implement → verify →
  package → learn), ending `awaiting-review` with a PR draft in `outcome.md`. Stages 2, 4
  and 5 hit real gates — plan approval, the review gate, the state machine; the rest is the
  checklist
- `/aos-verify` — contracts + a skeptic subagent, writing `review.json`. Standalone anytime
- `/aos-approve [run]` — agent-assisted review of an `awaiting-review` run; it proposes the
  close and the gate prompts you to sign off, in the session you're already in
- `/aos-learn` — distil the session into project memory
- `/aos-ask <question>` — answer from run history with file:line citations

## CLI

`aos init [--hooks-only] | status | cost | context | run start/approve/review/finish/state/link/list/session | verify | policy test | audit verify | ingest | find [--all] | export | fleet | console | projects | remove | doctor | version | update`

## The fleet hub

`aos fleet` scaffolds `~/.aos/fleet/` — an `AGENTS.md` (with a project table generated
from your registry), a `CLAUDE.md` pointing at it, and a `reports/` directory. Open a
session there with any runtime that reads `AGENTS.md` and it starts with every project
in context: what exists, where it lives, and the CLI verbs to query any of it.

To be precise about what that is: **files and a `cd`**, deliberately. There's no process
supervision, no message passing, no scheduler — `aos fleet --launch` is a convenience that
runs your runtime in that directory. The leverage is inheritance: the moment a session
touches a registered repo, that repo's hooks give it the same gates, context injection,
and audit every session there gets. AOS never executes agents by default; agents execute
AOS.

## Principles

- **Files over platforms** — everything is markdown/YAML/JSONL in your home dir. `git init ~/.aos` if you want history.
- **Enforced beats remembered** — guardrails and audit live in hooks, not in prompts.
- **Don't self-certify** — contracts run real commands; the adversarial review has to
  resolve its own findings before a run can close.
- **Say which is which** — a convention documented as a guarantee is worse than no
  guarantee at all.
- **Every layer works standalone** — hooks alone are worth installing; the pipeline is optional.
- **Local-only** — the console binds 127.0.0.1; the CLI makes zero network calls (the installer owns all outbound access, and a smoke test greps the shipped bundle to keep it true).

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup
(`npm ci && npm test`), the dist-freshness rule, and scope. Security reports: please
follow [SECURITY.md](SECURITY.md) rather than opening a public issue. By participating
you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Status

Published on npm and actively maintained by one person. Node ≥ 22; a smoke suite runs
against both the source and the compiled bundle across macOS/Linux and Node 22/24 in CI,
plus a dist-freshness gate and shellcheck. The end-to-end suite reports 347 checks,
weighted toward the gate's adversarial bypass surface and the evidence layer (policy
replay, tamper detection, ingest idempotency, executable findings) — that's where the
value is, so that's where the tests are. Under it sits a unit layer (`node --test`, no
dependencies): 229 tests, including a 125-case gate corpus and a seeded fuzzer over
wrapper × payload × quoting combinations.

## License

MIT © Medhat Albsugy. Bundled dependency licenses: [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).
