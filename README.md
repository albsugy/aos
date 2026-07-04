# AOS — Agent Operations Stack

Operate AI coding agents like a professional: **portable memory, enforced guardrails,
automatic audit, real verification, and a local console** — all stored as plain files you own.

AOS is not an orchestration framework and not a platform. It's three thin parts:

1. **The Spec** — a file convention under `~/.aos/` (context packs, policies, playbooks,
   run records, audit logs). Readable by any agent from any provider, forever.
2. **The Skills + Hooks** — Claude Code integration: a ticket pipeline that runs work
   through intake → plan → implement → verify → package → learn, with hooks that enforce
   policy and write audit *automatically*.
3. **The Console** — a local, read-only dashboard: decision queue, run states,
   verification verdicts, token economics, leverage ratio.

The design bet: frontier labs keep making agent *execution* better and cheaper; AOS owns
what they never will — **your** context, **your** policies, **your** audit trail, portable
across runtimes.

**Package:** [npmjs.com/package/@albsugy/aos](https://www.npmjs.com/package/@albsugy/aos)

## Install

```bash
curl -fsSL https://cdn.jsdelivr.net/npm/@albsugy/aos/install.sh | bash
```

Or with npm directly:

```bash
npm i -g @albsugy/aos
```

Requires Node ≥ 22 (curl path also needs curl + tar). Both channels deliver the same
artifact: the **compiled package published on the npm registry** — the single-file
bundle (`dist/aos.mjs`, dependencies inlined) plus the skills/templates. The curl
installer resolves the version from the registry, **verifies the registry's sha-512
integrity hash**, unpacks to `~/.local/share/aos`, and links `~/.local/bin/aos`.
No source code and no git history land on your machine (the source repository is
private; the published package is the compiled bundle). Pin with `AOS_VERSION=0.5.0`;
update later with `aos update`; diagnose with `aos doctor`.

Uninstall: `rm -rf ~/.local/share/aos ~/.local/bin/aos` — your data in `~/.aos` is yours to keep.

## Quickstart

```bash
cd your-repo
aos init                # registers the project, scaffolds ~/.aos/projects/<id>/,
                        # installs skills into .claude/skills/ and hooks into .claude/settings.json

# fill in the two files that matter:
#   ~/.aos/projects/<id>/context/pack.md   — what every agent must know
#   ~/.aos/projects/<id>/policy.yaml       — gates + verification contracts

# then, inside a Claude Code session in that repo:
/aos-ticket LIN-482     # runs the full pipeline; ends awaiting your review

aos status              # all projects: runs, states, leverage ratio, tokens
aos console             # http://127.0.0.1:4560
```

## What the hooks do (no skill invocation needed)

| Hook | Effect |
|---|---|
| `SessionStart` | Injects the project's context pack, recent decisions, learnings, and open runs into every new session |
| `PreToolUse` | Gates Bash commands **and file writes** against `policy.yaml`: forbidden → blocked, gated/protected → requires your approval. Protected by default: `.claude/settings.json`, `.git/hooks/`, and AOS's own policy/audit files (an agent can't rewire its own guardrails). Shell scripts being written are scanned so a gated command can't be laundered into a file and executed later. When `plan_gate: ask`, implementation writes stay gated until you run `aos run approve` |
| `PostToolUse` | Appends every action to the run's `audit.jsonl` — each run is bound to the session that started it, so concurrent sessions don't pollute its trail |
| `SessionEnd` | Records token usage (fresh input, output, and cache reads separately) per session and per run |

**Threat model, honestly:** these gates are accident-protection for well-meaning agents —
the failure mode that actually happens. They cover the tool paths agents really use (Bash,
file writes), but a deliberately adversarial agent needs OS-level isolation (containers,
sandboxes), which no hook layer provides. Pair AOS with sandboxing when you need a hard boundary.

## The Spec

```
~/.aos/
├── registry.yaml                  # project id → repo paths
└── projects/<id>/
    ├── context/pack.md            # the brief every agent loads
    ├── context/decisions.md       # append-only decision log
    ├── policy.yaml                # tiers (forbidden/gated/protected_paths), plan_gate, verification contracts
    ├── learnings.md               # compounding gotchas & fixes
    ├── playbooks/                 # extracted repeatable procedures
    └── runs/<date>-<ticket>/
        ├── ticket.md  plan.md  verification.md  outcome.md
        ├── audit.jsonl            # every action, gate decision, verdict
        └── meta.json              # state, verification, attempts, tokens
```

## Skills

- `/aos-ticket <ticket>` — full pipeline, ends `awaiting-review` with a PR draft in `outcome.md`
- `/aos-verify` — contracts + adversarial skeptic subagent, anytime
- `/aos-learn` — distill the session into project memory
- `/aos-ask <question>` — answer from run history with file:line citations

## CLI

`aos init | status | context | run start/approve/finish/state/list | verify | find | console | projects | doctor | version | update`

## Principles

- **Files over platforms** — everything is markdown/YAML/JSONL in your home dir. `git init ~/.aos` if you want history.
- **Enforced beats remembered** — guardrails and audit live in hooks, not in prompts.
- **Don't self-certify** — verification = deterministic contracts + an adversarial reviewer.
- **Every layer works standalone** — hooks alone are worth installing; the pipeline is optional.
- **Local-only** — the console binds 127.0.0.1; nothing leaves your machine.

## Status & roadmap

v0.5 — npm-registry distribution (compiled bundle only, private source), Node ≥ 22,
production-hardened (45 smoke tests run against both source and bundle in CI, plus
dist-freshness gate and shellcheck). Next, in pain-order:
mobile approvals (Telegram) · MCP adapter for non-Claude runtimes · playbook extraction
polish · multi-operator sync · client-facing trust console.

MIT © Medhat Albsugy
