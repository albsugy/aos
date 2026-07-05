---
name: aos-verify
description: Verify the current work against AOS policy contracts plus an adversarial review. Use standalone anytime, or as stage 4 of /aos-ticket.
argument-hint: [what to verify — defaults to current uncommitted/branch work]
---

# AOS verification

Verify $ARGUMENTS (default: the current branch's work) without self-certifying.

1. Run `aos verify` — this executes the deterministic contracts from `policy.yaml` and
   records results (into the active run's `verification.md` when a run is active).
2. Fix any required-contract failures and re-run until they pass.
3. Unless policy sets `adversarial_review: false`, spawn a skeptic subagent (Task tool):
   "Try to REFUTE this work. Assume it is subtly wrong. Check: does it actually do what was
   asked, edge cases, error paths, tests that assert nothing, unintended side effects in
   touched files. Report file:line findings." 
4. Triage its findings honestly — fix confirmed issues, note rejected ones with reasons.
   If a run is active, append findings + dispositions to its `verification.md` under a heading
   titled exactly `## Adversarial review` — `aos run finish` looks for that heading to record
   whether the review actually happened.
5. Report to the user: contract verdict, adversarial findings summary, and your confidence.
