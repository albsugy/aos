---
name: aos-approve
description: Review a run that is awaiting-review and close it (done/shipped) through the human sign-off gate. Use when the user asks to review, approve, or close a finished run — or to clear the decision queue.
argument-hint: [run id — defaults to the awaiting-review run(s)]
---

# AOS approve — agent-assisted review of an awaiting-review run

Do the review legwork the human would otherwise do by hand, then close the run
with them — in this session. You recommend; the human approves.

**How the sign-off works:** you run the close command, and the AOS gate turns it
into a permission prompt showing the human exactly what they are approving.
Approving that prompt IS the sign-off, and it is recorded (`via: gate-prompt`).
Never work around the prompt, never pass `--force`, and never ask the human to
open a second terminal to do it — that is the friction that left runs sitting in
the queue for weeks.

## 1. Pick the run

`aos run list` → runs in `awaiting-review`. Use the run id in the arguments if
given; if several are waiting and no argument, review each in turn (oldest
first). The run folder is `~/.aos/projects/<id>/runs/<run>/`.

## 2. Review — evidence, not summaries

Read, in order: `ticket.md` (the acceptance criteria are the contract),
`outcome.md`, `review.json` (the adversarial review's structured findings and
their dispositions), `verification.md` (contract verdicts + narrative), and
`review.md` + `reviews/*.md` if a reviewer fleet ran. Then verify the claims
against reality — do not take outcome.md's word for it:

1. **Diff**: read the actual diff — `meta.json` records the `branch` and, when
   the pipeline linked one, `pr_url`. Does it match outcome.md's Changes
   section? Cross-check against `files` in meta.json, which is reconstructed
   from the audit trail rather than from what the run claimed. Anything touched
   that outcome.md omits is the interesting part.
2. **Acceptance criteria**: spot-check each criterion against the code/diff,
   not against the outcome summary. Cite file:line for what you checked.
3. **Contracts**: `aos verify` was recorded — if the working tree has moved
   since the run finished, re-run it.
4. **Follow-ups**: confirm anything the run deferred is recorded (learnings,
   review.md follow-ups, or tracker tickets) — not silently dropped.
5. **Dispositions**: a `dismissed` finding is a claim, not a fact — spot-check
   the high-severity ones against the code. `"adversarial_review": "forced"` in
   `meta.json` means the run finished past its own review gate: find out why
   before you sign anything off.

## 3. Recommend and close

Present a short verdict to the user: **approve as done / approve as shipped /
send back**, with the two or three observations that drove it (cite files).
Then act:

- **Approve** → ask for the disposition, then run `aos run state done --run <run>`
  (or `shipped` if the work is merged AND released). The gate will prompt the
  human; their approval is the sign-off and is recorded with their OS user. If
  they decline the prompt, treat it as "send back" and ask what they want
  changed — do not retry the command.
- **Send back** → append your findings to the run's `verification.md` under
  `## Review findings (<date>)`, then `aos run state in-progress --run <run>`
  (not gated — reopening needs no sign-off) and tell the user what needs
  fixing.

## 4. Record

If the review surfaced anything the next agent should know, append 1-2 bullets
to the project's `learnings.md`. Done — the run leaves the decision queue and
the console's "Need you" count drops.
