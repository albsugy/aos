---
name: aos-ticket
description: Run a ticket end-to-end through the AOS pipeline — intake, plan, implement, verify, package, learn. Use when starting work on a ticket, issue, or task in an AOS-enabled repo.
argument-hint: <ticket id, URL, or pasted ticket content>
---

# AOS ticket pipeline

Work the ticket in `$ARGUMENTS` through all six AOS stages. Do not skip stages. All run
files live in the run folder printed by `aos run start`.

## 1. Intake

1. Run: `aos run start --ticket "<short id>" --title "<short title>"`. Note the run folder
   and `plan_gate` value it prints.
2. Fill `ticket.md` in the run folder: the original ticket content (fetch it if `$ARGUMENTS`
   is an id/URL), then an explicit **Acceptance criteria** checklist. If the criteria are
   ambiguous, ask the user before writing code.

## 2. Plan

3. Write `plan.md`: approach, files you expect to touch, risks, test strategy. Keep it short.
4. If `plan_gate` is `ask`: present the plan to the user. Approval is enforced by hooks, not
   this prompt — implementation file writes stay gated until the plan is approved. Run
   `aos run approve`; the gate on that command surfaces the approval prompt to the human.

## 3. Implement

5. Create a branch named after the ticket. Implement per the plan. The AOS hooks audit your
   actions and gate risky commands automatically — if a gate asks for approval, that is
   expected behavior, not an error.

## 4. Verify — do not self-certify

6. Run `aos verify`. Fix failures and re-run until required contracts pass.
7. Adversarial review (required unless policy sets `adversarial_review: false`): spawn a
   subagent (Task tool) with this framing: "You are a skeptical reviewer. Try to REFUTE this
   work against the acceptance criteria in <run>/ticket.md. Hunt for: criteria not actually
   met, edge cases, silent failures, tests that don't test the change. Report findings with
   file:line. Finding nothing is an acceptable answer only after a genuine hunt."
   Append its findings and your dispositions to `verification.md` under a heading titled
   exactly `## Adversarial review` — `aos run finish` looks for that heading to record whether
   the review actually happened.
8. Fix anything confirmed. Re-verify. Loop until clean or genuinely blocked
   (if blocked: `aos run state blocked`, tell the user why, and stop).

## 5. Package

9. Write `outcome.md` in the run folder:
   - **Summary** — what changed and why, 3 sentences max
   - **Changes** — files touched, grouped by purpose
   - **Decisions** — anything a reviewer would ask "why?" about
   - **Risks & follow-ups**
   - **How to test** — exact commands/steps
   - **PR draft** — title + body ready to paste
10. Run: `aos run finish` (state becomes `awaiting-review`). Tell the user the run is ready
    for their review, with the run folder path and the PR draft.

## 6. Learn

Do this in the SAME session, before ending it — a session that finishes a run without
writing learnings gets stopped once by the Stop hook and asked to extract them.

11. Append to the project's `learnings.md` (path: `aos context` shows the project; files live
    under `~/.aos/projects/<id>/`): 1-3 bullets of anything that would help the next agent.
    Append significant choices to `context/decisions.md` in the decision format.
12. If this run repeated a pattern you've seen in previous runs (check `playbooks/` and
    recent runs), propose a playbook file in `playbooks/` and mention it to the user.
