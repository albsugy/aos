---
name: aos-verify
description: Verify the current work against AOS policy contracts plus an adversarial review. Use standalone anytime, or as stage 4 of the aos-ticket skill.
argument-hint: [what to verify — defaults to current uncommitted/branch work]
---

# AOS verification

Verify $ARGUMENTS (default: the current branch's work) without self-certifying.

1. Run `aos verify` — this executes the deterministic contracts from `policy.yaml` and
   records results (into the active run's `verification.md` when a run is active).
2. Fix any required-contract failures and re-run until they pass.
3. Unless policy sets `adversarial_review: false`, hunt adversarially: spawn a skeptic subagent
   if your runtime has one (Claude Code: the Task tool; others: any subagent mechanism), otherwise
   do a separate pass where your only job is to refute the work. Framing:
   "Try to REFUTE this work. Assume it is subtly wrong. Check: does it actually do what was
   asked, edge cases, error paths, tests that assert nothing, unintended side effects in
   touched files. Report file:line findings." 
4. Triage its findings honestly — fix confirmed issues, note rejected ones with reasons.
5. If a run is active, record the review as **`review.json` in the run folder**. This is a
   gate, not a note: `aos run finish` refuses to close the run while it is missing, malformed,
   or has any finding still `open`.

   ```json
   {
     "reviewer": "skeptic subagent",
     "scope": ["src/foo.js", "acceptance criterion 2", "npm test"],
     "findings": [
       {
         "severity": "high",
         "summary": "one sentence stating the defect",
         "location": "src/foo.js:42",
         "status": "fixed",
         "resolution": "what you did, or why it does not apply"
       }
     ]
   }
   ```

   `severity`: high|medium|low. `status`: `fixed` (you changed the code), `dismissed` (not a
   real defect — say why), `deferred` (real, not now — say where it is tracked), `open` (still
   unresolved; this blocks the finish). `resolution` is required for everything but `open`.
   Findings `[]` is a legitimate result of a genuine hunt — but `scope` must still say what you
   hunted through. Do not invent findings to fill it, and do not mark something `dismissed`
   you have not actually checked.
6. Run `aos run review` to validate the file against the same checks the gate uses, and fix
   what it reports. Narrative detail still belongs in `verification.md`; `review.json` is the
   machine-checked claim.
7. Report to the user: contract verdict, adversarial findings summary, and your confidence.
