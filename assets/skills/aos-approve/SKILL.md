---
name: aos-approve
description: Review a run that is awaiting-review and close it (done/shipped) through the human sign-off gate. Use when the user asks to review, approve, or close a finished run — or to clear the decision queue.
argument-hint: [run id — defaults to the awaiting-review run(s)]
---

# AOS approve — agent-assisted review of an awaiting-review run

Do the review legwork the human would otherwise do by hand, then hand the close
command to the human. **Closing a run requires the human's own interactive
terminal — the TTY sign-off is the gate; never work around it.** You recommend;
the human approves.

## 1. Pick the run

`aos run list` → runs in `awaiting-review`. Use the run id in the arguments if
given; if several are waiting and no argument, review each in turn (oldest
first). The run folder is `~/.aos/projects/<id>/runs/<run>/`.

## 2. Review — evidence, not summaries

Read, in order: `ticket.md` (the acceptance criteria are the contract),
`outcome.md`, `verification.md` (contract verdicts + the adversarial review),
and `review.md` + `reviews/*.md` if a reviewer fleet ran. Then verify the
claims against reality — do not take outcome.md's word for it:

1. **Diff**: if the run names a branch/PR, read the actual diff. Does it match
   outcome.md's Changes section? Anything touched that outcome.md omits?
2. **Acceptance criteria**: spot-check each criterion against the code/diff,
   not against the outcome summary. Cite file:line for what you checked.
3. **Contracts**: `aos verify` was recorded — if the working tree has moved
   since the run finished, re-run it.
4. **Follow-ups**: confirm anything the run deferred is recorded (learnings,
   review.md follow-ups, or tracker tickets) — not silently dropped.

## 3. Recommend and close

Present a short verdict to the user: **approve as done / approve as shipped /
send back**, with the two or three observations that drove it (cite files).
Then act:

- **Approve** → tell the human to run `aos run state done --run <run>` (or
  `shipped` if the work is merged AND released) **in their own terminal**. The
  command requires an interactive TTY precisely so the sign-off carries the
  human's identity — run from your shell tool it will refuse; that refusal is
  the gate working, not an error to engineer around. If the human declines,
  treat it as "send back" and ask what they want changed.
- **Send back** → append your findings to the run's `verification.md` under
  `## Review findings (<date>)`, then `aos run state in-progress --run <run>`
  (not gated — reopening needs no sign-off) and tell the user what needs
  fixing.

## 4. Record

If the review surfaced anything the next agent should know, append 1-2 bullets
to the project's `learnings.md`. Done — the run leaves the decision queue and
the console's "Need you" count drops.
