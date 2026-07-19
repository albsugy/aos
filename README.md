# AOS — Agent Operations Stack

[![npm](https://img.shields.io/npm/v/@albsugy/aos?color=cb3837&logo=npm)](https://www.npmjs.com/package/@albsugy/aos)
[![CI](https://github.com/albsugy/aos/actions/workflows/ci.yml/badge.svg)](https://github.com/albsugy/aos/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](package.json)

Operate AI coding agents like a professional: **portable memory, enforced guardrails,
automatic audit, real verification, and a local console** — all stored as plain files you own.

Open source (MIT), local-first, and runs entirely on your machine.

AOS is not an orchestration framework and not a platform. It's three thin parts:

1. **The Spec** — a file convention under `~/.aos/` (context packs, policies, playbooks,
   run records, audit logs). Readable by any agent from any provider, forever.
2. **The Skills + Hooks** — Claude Code integration: a ticket pipeline that runs work
   through intake → plan → implement → verify → package → learn, with hooks that enforce
   policy and write audit *automatically*.
3. **The Console** — a local, read-only dashboard: decision queue (with queue
   latency), run states, verification verdicts, token economics with estimated
   cost at API rates, cycle times, leverage ratio.

The design bet: frontier labs keep making agent *execution* better and cheaper; AOS owns
what they never will — **your** context, **your** policies, **your** audit trail, portable
across runtimes.

**Package:** [npmjs.com/package/@albsugy/aos](https://www.npmjs.com/package/@albsugy/aos)
· **Full manual:** [DOCS.md](DOCS.md)

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
inlined) plus the skills/templates — a small, fast install. The curl installer resolves
the version from the registry, **verifies the registry's sha-512 integrity hash**,
unpacks to `~/.local/share/aos`, and links `~/.local/bin/aos`. Pin with
`AOS_VERSION=0.7.2`; update later with `aos update`; diagnose with `aos doctor`.

Prefer to build it yourself? The source is right here — clone and run:

```bash
git clone https://github.com/albsugy/aos.git && cd aos
npm ci && npm run build
ln -sf "$PWD/dist/aos.mjs" ~/.local/bin/aos
```

(Or `AOS_FROM_SOURCE=1` with the curl installer does the same.) Releases published
from this public repo onward carry npm
[provenance attestations](https://docs.npmjs.com/generating-provenance-statements),
so you can verify the bundle was built from this source by CI.

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

aos status              # all projects: runs, states, leverage ratio, tokens, est. cost
aos export              # write the context pack as AGENTS.md for Codex/Cursor/etc.
aos console             # http://127.0.0.1:4560
```

## What the hooks do (no skill invocation needed)

| Hook | Effect |
|---|---|
| `SessionStart` | Injects the project's context pack, recent decisions, learnings, and open runs into every new session |
| `PreToolUse` | Gates Bash commands **and file writes** against `policy.yaml`: forbidden → blocked, gated/protected → requires your approval. Protected by default: `.claude/settings.json`, `.git/hooks/`, and AOS's own policy/audit files (an agent can't rewire its own guardrails) — enforced on the shell path too, so `tee`, `> file`, and `sed -i` can't sidestep the file gates. Shell scripts being written are scanned so a gated command can't be laundered into a file and executed later. When `plan_gate: ask`, implementation writes (file tools *and* write-intent Bash) stay gated until you run `aos run approve` |
| `PostToolUse` | Appends every action to the run's `audit.jsonl` — each run is bound to the session that started it, so concurrent sessions don't pollute its trail |
| `SessionEnd` | Records token usage (fresh input, output, and cache reads separately) per session and per run, and flags sessions that did substantive work without writing learnings |
| `Stop` | Blocks the stop once when the session's finished run recorded no learnings, so the model that did the work extracts them while it still has the context |

**Threat model, honestly:** these gates are accident-protection for well-meaning agents —
the failure mode that actually happens. They cover the tool paths agents really use (Bash,
file writes), but a deliberately adversarial agent needs OS-level isolation (containers,
sandboxes), which no hook layer provides. Pair AOS with sandboxing when you need a hard boundary.

## The Spec

```
~/.aos/
├── registry.yaml                  # project id → repo paths
├── fleet/                         # primary-agent hub (see The Fleet below)
│   ├── AGENTS.md  CLAUDE.md       # the orchestrator's brain — instructions + routing
│   └── reports/                   # crewmate session transcripts
└── projects/<id>/
    ├── context/pack.md            # the brief every agent loads
    ├── context/decisions.md       # append-only decision log
    ├── policy.yaml                # tiers (forbidden/gated/protected_paths), plan_gate, verification contracts
    ├── learnings.md               # compounding gotchas & fixes
    ├── playbooks/                 # extracted repeatable procedures
    └── runs/<date>-<ticket>/
        ├── ticket.md  plan.md  verification.md  outcome.md
        ├── audit.jsonl            # every action, gate decision, verdict
        └── meta.json              # state, verification, attempts, tokens, bound session id
```

## The Fleet — one agent aware of every project

`aos fleet` scaffolds `~/.aos/fleet/` — files that turn a session opened there
into a **primary agent** whose memory is your entire AOS spec. It routes
brain-dumps to the right project (routing table generated from your registry),
dispatches crewmate sessions to do the actual work (every task tracked as an
AOS run), and reports back only outcomes and the items that need your decision.
Start it with any runtime that reads AGENTS.md — Claude Code, Codex CLI,
opencode, Factory Droid — via `cd ~/.aos/fleet && <runtime>`, or the explicit
convenience `aos fleet --launch [claude|codex|opencode|droid]`. By design,
**AOS never executes agents by default; agents execute AOS.**

Why it works: the hub is **just files** — an `AGENTS.md` any runtime can read,
backed by CLI queries any agent can run. Cross-project recall is
`aos find "<query>" --all`; resuming the exact session that worked a run is
`claude --resume $(aos run session --run <id>)` (AOS records the run↔session
binding automatically). Crewmates inherit context injection, gates, and audit
the moment they touch a registered repo — orchestration stays in the agent
layer, governance stays in AOS, and closing any run still ends with you — a
command that only runs from your own interactive terminal.

## Skills

- `/aos-onboard` — extract the repo's real context: fill the pack from the code, mine git history for decisions, author contracts
- `/aos-ticket <ticket>` — full pipeline, ends `awaiting-review` with a PR draft in `outcome.md`
- `/aos-verify` — contracts + adversarial skeptic subagent, anytime
- `/aos-approve [run]` — agent-assisted review of an `awaiting-review` run; closing it requires your own terminal (TTY sign-off, recorded with your OS user)
- `/aos-learn` — distill the session into project memory
- `/aos-ask <question>` — answer from run history with file:line citations

## CLI

`aos init | status | context | run start/approve/finish/state/list/session | verify | find [--all] | export | fleet | console | projects | doctor | version | update`

## Principles

- **Files over platforms** — everything is markdown/YAML/JSONL in your home dir. `git init ~/.aos` if you want history.
- **Enforced beats remembered** — guardrails and audit live in hooks, not in prompts.
- **Don't self-certify** — verification = deterministic contracts + an adversarial reviewer.
- **Every layer works standalone** — hooks alone are worth installing; the pipeline is optional.
- **Local-only** — the console binds 127.0.0.1; nothing leaves your machine.

## Contributing

Issues and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup
(`npm ci && npm test`), the dist-freshness rule, and scope. Security reports: please
follow [SECURITY.md](SECURITY.md) rather than opening a public issue. By participating
you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

## Status

Published on npm and production-hardened: Node ≥ 22, a smoke suite run against both
the source and the compiled bundle across macOS/Linux and Node 22/24 in CI, plus a
dist-freshness gate and shellcheck. It runs entirely on your machine and works standalone.

## License

MIT © Medhat Albsugy. Bundled dependency licenses: [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).
