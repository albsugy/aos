---
name: aos-onboard
description: Extract this repo's real context into AOS project memory — fill the context pack from the code, mine git history for decisions, seed learnings and gotchas, and author verification contracts. Use right after `aos init`, or whenever the context pack is still a template.
argument-hint: [optional focus, e.g. "just the contracts"]
---

# AOS onboard

Replace the scaffolded templates with the repo's actual truth. Focus: $ARGUMENTS
(default: everything). Files live under `~/.aos/projects/<project-id>/` — `aos context`
prints the project id.

## 1. Context pack (`context/pack.md`)

Explore before writing: README/docs, manifests (package.json / pyproject.toml / go.mod /
Cargo.toml / ...), entry points, CI config, top-level layout. Then rewrite `pack.md` keeping
its section headings:

- **What this project is** — purpose, stage, who uses it. One tight paragraph, from evidence.
- **Architecture & stack** — runtime, frameworks, storage, deploy target. Only what you saw.
- **Conventions** — naming/structure/commit style that differs from defaults (read a few
  recent commits and files; don't invent).
- **Boundaries — never do** — from docs, CODEOWNERS, protected dirs, comments like "do not
  edit". If none found, leave the examples and say so.
- **Gotchas** — flaky tests, env quirks, slow builds: check CI config, `.env.example`,
  skipped tests, README warnings.

Remove every remaining `(placeholder)` line — an unfilled line keeps the session-start
template warning firing.

## 2. Decisions (`context/decisions.md`)

Mine git history — it is a decision log nobody formatted yet:

- `git log --oneline --stat` (and `--follow` on interesting files): dependency switches,
  framework migrations, reverts, renames, "back to X" commits.
- For each real decision, append an entry in the decision format
  (`## YYYY-MM-DD — title` / **Decision:** / **Why:**), dated from the commit. 3-8 entries
  is plenty — only choices that still constrain the code today.

## 3. Learnings (`learnings.md`)

Seed from what the repo already knows informally: CI retry hacks, `--runInBand`-style flags,
TODO/HACK/FIXME comments that encode traps, README "note:" warnings. Bullets only for things
that would change how the next agent works.

## 4. Verification contracts (`policy.yaml`)

If `verification.contracts` is empty or thin: find the real test/lint/typecheck commands
(CI config is the ground truth — it's what the repo actually runs), verify each command
exists and runs, then add them (`test` required, others advisory). Writing policy.yaml is
ask-gated — the human approving that prompt is the review.

## 5. Verify

Run `aos context` and read it back: no template placeholders, no warnings, and the pack under
~6k chars so learnings/decisions still fit the session-start budget. Tell the user what you
extracted and what you could not determine from the repo alone.
