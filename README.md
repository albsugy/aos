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

**Site:** [albsugy.github.io/aos](https://albsugy.github.io/aos/) · **Manual:** [docs.html](https://albsugy.github.io/aos/docs.html)

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/albsugy/aos/main/install.sh | bash
```

Requires git + Node ≥ 18. Installs to `~/.local/share/aos`, links `~/.local/bin/aos`,
adds it to your PATH. Re-run to update, or `aos update`. Manual install:

```bash
git clone https://github.com/albsugy/aos.git && cd aos
npm install --omit=dev
ln -sf "$PWD/bin/aos.js" ~/.local/bin/aos
```

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
| `PreToolUse` | Gates Bash commands against `policy.yaml`: forbidden → blocked, gated → requires your approval |
| `PostToolUse` | Appends every action to the run's `audit.jsonl` |
| `SessionEnd` | Records token usage per session and per run |

## The Spec

```
~/.aos/
├── registry.yaml                  # project id → repo paths
└── projects/<id>/
    ├── context/pack.md            # the brief every agent loads
    ├── context/decisions.md       # append-only decision log
    ├── policy.yaml                # tiers (forbidden/gated), plan_gate, verification contracts
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

`aos init | status | context | run start/finish/state/list | verify | find | console | projects | doctor | version | update`

## Principles

- **Files over platforms** — everything is markdown/YAML/JSONL in your home dir. `git init ~/.aos` if you want history.
- **Enforced beats remembered** — guardrails and audit live in hooks, not in prompts.
- **Don't self-certify** — verification = deterministic contracts + an adversarial reviewer.
- **Every layer works standalone** — hooks alone are worth installing; the pipeline is optional.
- **Local-only** — the console binds 127.0.0.1; nothing leaves your machine.

## Status & roadmap

v0.2 — production-hardened (26 smoke tests + shellcheck in CI: `npm test`). Next, in pain-order:
mobile approvals (Telegram) · MCP adapter for non-Claude runtimes · playbook extraction
polish · multi-operator sync · client-facing trust console.

MIT © Medhat Albsugy
