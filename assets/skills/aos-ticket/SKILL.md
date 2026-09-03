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
   - The run recorded the branch it started on. If you branched after starting, that is
     fine — `aos run finish` re-reads it. If you push the branch and open a PR at any
     point, record it: `aos run link --pr <url>`. Nothing can auto-detect that (the CLI
     makes no network calls), and without it a reviewer has a summary but no diff.

## 4. Verify — do not self-certify

6. Run `aos verify`. Fix failures and re-run until required contracts pass.
7. Adversarial review (required unless policy sets `adversarial_review: false`): spawn a
   subagent with this framing (use your runtime's subagent mechanism; if it has none, do a
   separate adversarial pass yourself): "You are a skeptical reviewer. Try to REFUTE this
   work against the acceptance criteria in <run>/ticket.md. Hunt for: criteria not actually
   met, edge cases, silent failures, tests that don't test the change. Report findings with
   file:line. Finding nothing is an acceptable answer only after a genuine hunt."
8. Fix anything confirmed. Re-verify. Loop until clean or genuinely blocked
   (if blocked: `aos run state blocked`, tell the user why, and stop).
9. Record the review as `review.json` in the run folder — schema and rules in `/aos-verify`
   (severity, summary, location, status, resolution; `scope` says what was hunted through).
   **This is enforced**: `aos run finish` refuses while it is missing, malformed, or has an
   `open` finding. Validate with `aos run review` before moving on. Narrative detail goes in
   `verification.md`; `review.json` is the machine-checked claim.

## 5. Package

10. Write `outcome.md` in the run folder:
    - **Summary** — what changed and why, 3 sentences max
    - **Changes** — files touched, grouped by purpose
    - **Decisions** — anything a reviewer would ask "why?" about
    - **Risks & follow-ups**
    - **How to test** — exact commands/steps
    - **PR draft** — title + body ready to paste
11. If a PR exists and you have not linked it yet, do it now: `aos run link --pr <url>`.
    Then run `aos run finish` (state becomes `awaiting-review`). If the review gate refuses,
    it prints exactly what is missing — fix that, don't reach for `--force`.

## 6. Close it out — here, not in a dashboard

`awaiting-review` is a queue with one reader, and that reader is the person in this
session. Do not end the session by telling them "it's in the queue"; walk them through
the decision now, while you still have the whole run in context.

12. Present, in a few lines: what changed, what `aos verify` reported, and what the
    adversarial review found (cite `review.json` — findings and their dispositions).
    Name anything you deferred or dismissed, and say why.
13. Recommend a disposition and ask for it plainly: `done` (complete/merged), `shipped`
    (released), or back to `in-progress` if the review changed your mind.
14. Run `aos run state done --run <run>` (or `shipped`). **You will hit a permission
    prompt — that prompt is the human's sign-off.** Do not route around it, do not pass
    `--force`, and do not ask them to open a second terminal. If they decline or don't
    answer, leave the run at `awaiting-review` and say so.

## 7. Learn

Do this in the SAME session, before ending it — a session that finishes a run without
writing learnings gets stopped once by the Stop hook and asked to extract them.

15. Append to the project's `learnings.md` (path: `aos context` shows the project; files live
    under `~/.aos/projects/<id>/`): 1-3 bullets of anything that would help the next agent.
    Append significant choices to `context/decisions.md` in the decision format.
16. If this run repeated a pattern you've seen in previous runs (check `playbooks/` and
    recent runs), propose a playbook file in `playbooks/` and mention it to the user.
