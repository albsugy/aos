---
name: aos-learn
description: Extract learnings, decisions, and playbook candidates from the current session into AOS project memory. Use at the end of significant work, or when the user says "remember this".
argument-hint: [optional focus, e.g. "the deploy fix"]
---

# AOS learn

Distill this session into durable project memory. Focus: $ARGUMENTS (default: whole session).

1. Find the project home: `aos context` prints the project; files live under
   `~/.aos/projects/<project-id>/`.
2. Append to `learnings.md`: bullets only for things that would change how the next agent
   works — gotchas hit, commands that worked, constraints discovered. No narration.
3. For significant choices made this session, append to `context/decisions.md`:
   `## YYYY-MM-DD — title` / **Decision:** / **Why:** / **Run:** (if applicable).
4. If `context/pack.md` is now wrong or missing something important (new convention, new
   boundary), update it in place.
5. If a procedure occurred that has now happened 2+ times across runs (check recent
   `runs/*/outcome.md`), write it as a playbook in `playbooks/<slug>.md`: trigger,
   steps, verification. Tell the user what you extracted.
