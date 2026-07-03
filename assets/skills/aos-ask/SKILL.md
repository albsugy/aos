---
name: aos-ask
description: Answer questions from AOS project history — past runs, decisions, learnings, audit. Use for "why did we...", "when did we...", "what happened with..." questions.
argument-hint: <question about past work>
---

# AOS ask

Answer from project memory, citing files: $ARGUMENTS

1. Run `aos find "<key terms>"` (try 2-3 different terms) to locate relevant entries across
   runs, decisions, learnings, and audit logs.
2. Read the matching files under `~/.aos/projects/<id>/` — especially `runs/*/outcome.md`
   (decisions + rationale per run) and `context/decisions.md`.
3. Answer concisely and cite sources as `<file>:<line>` so the user can verify. If history
   doesn't contain the answer, say so plainly — do not reconstruct from guesswork.
