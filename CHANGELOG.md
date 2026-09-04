# Changelog

## 0.14.0 — 2026-09-04

> Ships everything since 0.11.1 (the 0.12/0.13 lines below were never
> published): the removals and ledger hardening of 0.12, the multi-agent
> core with Claude Code + Codex + Cursor + external approvals of 0.13, and
> pi + opencode + Devin support.

### Fixed

- **Hook launchers degraded to a bare `aos` for every install under `$HOME`**
  (the common case). The injection guard in `launcherCommand` tested the
  substituted `$HOME/…` launcher for `$` — treating our own prefix as a
  metacharacter — so agent hook configs lost their absolute launcher and
  silently depended on `aos` being on PATH; wherever it wasn't (CI, minimal
  environments), gates and audit were off with no visible failure. The guard
  now tests the physical install path; `aos doctor` resolves every wired
  agent's launcher and says so, and `aos init` re-run repairs existing
  configs in place.
- Test-suite portability: GNU grep does not treat `\`` as a literal backtick
  in BRE (BSD grep does); the bundle staleness gate now tolerates
  fresh-checkout mtime noise (2s) while still catching real staleness; the
  multi-agent smoke section carries the repo's shellcheck disables.

### Added — pi, opencode, and Devin CLI support (0.14 line)

Three more agents, verified against each one's real extensibility surface
(pi's extension API, opencode's plugin API, Devin's docs):

- **pi — full enforcement.** AOS ships a project extension
  (`.pi/extensions/pi-aos.ts`, launcher path baked at install) that forwards
  pi's `tool_call` events to the AOS core and returns `{block, reason}` on a
  deny — a real block. Context is injected natively once per session via
  `before_agent_start`; every tool call is audited via `tool_execution_end`.
  Skills install to the cross-agent `.agents/skills/` pi already reads. No
  ask concept at pi's interception point → external approvals.
- **opencode — full enforcement.** A project plugin
  (`.opencode/plugins/opencode-aos.ts`) hooks `tool.execute.before` and blocks by
  throwing (opencode's documented mechanism, the reason fed to the agent);
  `tool.execute.after` audits. `write`, `edit`, and `apply_patch` (GPT-5-series
  file edits) are all gated. Context via the generated `AGENTS.md`; skills
  via `.agents/skills/`. No ask → external approvals.
- **Devin CLI — workflow compatibility, honestly.** Devin has no local hook
  surface; it gets the generated `AGENTS.md` and skills in `.agents/skills/`
  (its documented location) and is never described as enforced.
- `aos init --agent pi|opencode|devin` (also in comma lists, `auto` detection,
  and `all`); `aos doctor --capabilities` prints the seven-agent matrix.
- Self-protection extended: `.pi/extensions/` and `.opencode/plugins/` join
  the protected paths — an agent rewriting its own gate script is gated like
  every other disarm attempt (file writes and shell writes). Directory removal
  of `.pi` / `.opencode` themselves is gated too (`rm -rf .pi` is not a bypass).
- Adapters for pi and opencode keep the same contract as the rest: thin
  translators over the normalized event protocol; the same policy fixtures
  evaluate identically through all five enforcement adapters (unit-tested).

### Fixed

- `aos doctor` no longer requires Claude JSON hooks on a pi- or opencode-only
  install. Baked `AOS_CMD` argv arrays are resolved the same way shell hooks are.
  Devin is labeled `workflow`, never `hooks wired`.
- opencode's plugin now intercepts `apply_patch` (the file-edit tool GPT-5-series
  models get instead of `write`/`edit`), so protected-path and content-scan
  gates apply there too.

### Added — multi-agent support (0.13 line)

One policy, one project memory, one evidence trail — enforced through each coding
agent's real hook surface, honestly labeled per agent:

- **Provider-neutral core.** Hook payloads are translated by adapters
  (`src/adapters/{claude,codex,cursor}.js`, shapes verified against each vendor's
  official hook docs) into one normalized event protocol (`src/core/events.js`); the
  gates, plan/scope enforcement, audit, and sign-off machinery now live in
  `src/core/pipeline.js` and contain no provider tool names. Claude behavior is
  unchanged (the whole pre-existing suite passes untouched). Audit entries gain
  `provider` and `tool_kind`; Codex `apply_patch` calls are parsed into per-path
  writes so the same file gates apply.
- **`aos init --agent claude|codex|cursor|gemini|auto|all`** (comma lists work).
  Writes each agent's hook config (`.claude/settings.json`, `.codex/hooks.json`,
  `.cursor/hooks.json`), installs the (now agent-neutral) skills into each agent's
  skills directory (`.claude/skills`, `.agents/skills`, `.cursor/skills`), and records
  the agents on the registry — re-init merges rather than replacing. Gemini is
  context-file-only workflow compatibility and is never described as enforced.
  Codex hooks must be trusted once in the CLI (`/hooks`); init says so.
- **External approvals for agents that can deny but cannot ask** (Codex and Cursor
  both parse `ask` without enforcing it): a gated operation is denied carrying an
  exact `aos approve <id>` command; a human grants it outside the agent; the same
  operation is allowed through exactly once (single-use, expiring, bound to an
  operation fingerprint — command text for shell, target paths for writes).
  Agents cannot approve their own unlocks: the approve command is human-only by
  policy, and through deny-capable agents it is refused outright. Where a sign-off
  command (run state done, run approve, remove) is unlocked this way, the run's
  record says `via: external-approval`.
- **`aos approve <id> / --list`** — grant pending approvals; sign-off gated like
  closing a run (TTY, gate prompt bound to the decision id, or the CI env var).
- **`aos doctor --capabilities`** — the per-agent support matrix (context / audit /
  deny / ask / writes / enforcement level), verified against the docs, plus this
  repo's per-agent wiring. Workflow-only agents are reported as exactly that.
- **`aos context sync|check|diff`** — regenerate / verify per-agent context files
  (`AGENTS.md` for Codex+Cursor, `GEMINI.md` for Gemini CLI) from the one canonical
  memory; markers on generated files, hand-written files never touched, legacy
  `aos export` markers upgrade in place, `check` exits 1 on drift (CI-gateable).
  `aos export` is now a thin alias.
- **Console** — per-project Agents card (enforced / context only / not wired),
  a Pending approvals section with copyable grant commands, provider chips in the
  audit timeline, and the external-approval sign-off route in the record view.
- **Self-protection extended**: `.codex/hooks.json` and `.cursor/hooks.json` join
  `.claude/settings.json` as protected paths (file writes and shell writes), and
  the decisions directory (pending/granted approvals) is write-protected like
  `signoff.json` — forging an approval would unlock gated operations.

### Fixed

- `aos approve` now binds a gate-prompt ticket to the decision id (`mustInclude`);
  unknown/expired ids are refused before a ticket is spent. Pending records store
  the command and paths a human is unlocking, and `--list` / the console show them.
- Cursor `Delete` (and a Write with no path) now reach the file gate instead of
  skipping it; a file event with no resolvable path is denied.
- `aos doctor` resolves hook commands for every wired agent, not only Claude.
  An unknown `--agent` on a hook fails closed (deny) instead of falling back to
  Claude's native-ask shape, which Codex/Cursor treat as fail-open.
- Pending/approved decision prune drops oldest by timestamp, and `aos approve --list`
  hides expired entries.

- `aos init` without `--name` on an already-registered repo now targets the
  registered project instead of forking a basename-id duplicate.

### Added

- **`aos remove <id> [--purge] [--force]`** — unregister a project. Registry-only
  removal keeps the data (reversible via `aos init`); `--purge` deletes it and
  requires a human sign-off (TTY, gate prompt, or `AOS_ALLOW_HEADLESS_APPROVE`),
  with the receipt written to `~/.aos/removals.jsonl` — a ledger that survives the
  purge it records, since the project's own audit ledger dies with its directory.
  Removal refuses while a run is in progress (`--force` overrides, recorded).
  Unregistering a project turns that repo's gates off, so the removal command is
  itself gated by default policy (`action: project-remove`) and an approved gate
  prompt doubles as the purge sign-off. New installs get the rule from the
  template; existing policy.yaml files that pin a `gated:` list need the rule
  added by hand to keep the gate on. `removals.jsonl` and `ingest.json` join the
  write-protected AOS state files, and the removals ledger is hash-chained and
  walked by `aos audit verify` — the receipt that survives a purge carries the
  same tamper evidence as the ledger it receipts.
- **Policy CI — `aos policy test [--file <policy.yaml>] [--since 30d]`.** Replays the
  commands that actually ran (audit ledger + ingested history) against a policy before
  you install it, reporting what it would newly deny, newly gate, or newly allow, with
  per-command run counts and rule reasons. Recorded commands are truncated at 300
  chars; the report counts and discloses them rather than treating them as clean. The
  stateful plan/scope gates are deliberately not replayed — command tiers and
  shell-path write protection only, and the docs say so.
- **Tamper-evident audit ledgers — `aos audit verify`.** Every audit line now carries
  `chain: {seq, hash}` (sha-256 over its own payload linked to the previous line),
  maintained by every append site, surviving rotation and the
  rename-without-append crash window. `aos audit verify` walks every project and run
  ledger and exits 1 on any line edited, deleted, reordered, or written outside the
  chain after it started — CI-gateable. Pre-chain lines count as `legacy`, not
  failures; a foreign unchained line after the chain started is reported, because
  that is either tampering or a downgraded AOS. The chain forgives appends (an
  append-only log must); it catches post-hoc edits — which is the audit trail's
  actual failure mode.
- **History ingest — `aos ingest [--dry-run]`.** Backfills the audit ledger and token
  totals from Claude Code's own session transcripts (`~/.claude/projects/<slug>/*.jsonl`,
  `CLAUDE_CONFIG_DIR` honoured), matched to registered repos by each session's recorded
  `cwd`. Tool calls become chained audit lines marked `source: ingested` with original
  timestamps; per-session cumulative usage lands in `sessions.jsonl` in the SessionEnd
  shape (readers dedup, so re-ingesting a grown file replaces rather than adds).
  Delta-based and idempotent via per-session line watermarks in `ingest.json`; a file
  that shrank is skipped with a warning. Combined with policy test: install AOS today,
  ingest a month of real traffic, tune the policy against evidence.
- **Executable findings (opt-in) — `verification.executable_findings: true`.** A
  high-severity `open`/`fixed` finding in review.json must now carry a `reproduce`
  command; `aos run review` executes every reproduce in a real subprocess (`--no-execute`
  to skip) and writes results to `executions.json`. The review gate gains an
  `unproven` state: it blocks the finish while a required execution is missing, not
  passing, or recorded under a status the finding no longer has. Semantics: `open` →
  the command must fail (bug demonstrated); `fixed` → it must pass (fix holding).
  Off by default — it raises the bar on review.json beyond what existing projects
  have written.

### Fixed

- **Executable findings honor the opt-out, and proof is no longer agent-authored.**
  `executable_findings: false` no longer treats a `reproduce` field as a proof
  obligation (copied review.json was flipping opted-out projects to `unproven`).
  `aos run review` only executes reproduce commands when the flag is on, or with
  `--execute`. Results are written to `executions.json` (and a detailed
  `review-exec` audit line), not into `review.json` — a forged `pass: true` array
  in the review file is not evidence. Reproduce commands now go through the same
  plan-gate check as live Bash (`ask` is refused; this path has no human to prompt).
- **Audit chain detects trailing deletes.** A valid prefix is a valid chain, so
  deleting the newest lines used to verify clean. Each ledger now keeps a sibling
  `audit.jsonl.head` with the latest `{seq, hash}`; `aos audit verify` fails when
  the tail does not match. A writer who can edit the head can still rewrite
  history — this closes the easy delete-the-end case. `lastLineOf` no longer
  treats a mid-file fragment as a complete last line (which forked the chain).
- **Ingest watermarks flush per file, and summaries/size are bounded.** A crash
  after appending audit lines no longer re-ingests the same transcript as new.
  `file_path` / `url` / `notebook_path` summaries are capped like Bash (300 chars)
  so a long untrusted path cannot fork the chain; transcripts over 32MB are
  skipped; usage is taken from the same parse rather than a second slurp.
- **Finish/close/console warn on `unproven`.** `printReviewOutcome`, the close-path
  warning, and the console's missing-review set treated `absent|invalid|open` as
  the exhaustive list and stayed silent on `unproven` in warn mode.

### Changed

- **The test suite is two layers instead of one 1,300-line file.**
  `test/smoke.sh` is now a driver: it builds the sandbox and sources
  `test/sections/*.sh` in an explicit, load-bearing order (sections read the
  state earlier ones leave behind), with shared helpers in `test/lib.sh`. A
  section file that exists but isn't listed in the driver fails the run rather
  than being silently skipped. Same assertions, same order, same idiom — 313
  end-to-end checks before and after (from 361 assertion sites: a loop over a
  command matrix reports one line).

### Added

- **A unit layer for the pure functions** — `npm run test:unit`, using Node's
  built-in `node --test`, no new dependencies. 70 assertions over the policy
  helpers, scope matching, pricing, the review schema, sign-off tickets, the
  registry, and the path primitives; runs in ~0.2s, so the fast feedback loop
  no longer requires the full end-to-end sandbox. `npm test` is now unit →
  source → bundle, and CI runs the unit job first.
- **A case corpus for the Bash gate** — `test/fixtures/gate-cases.json`, 125
  rows of `{command, expect, note}` covering every historical bypass, run
  through the real engine in the order `hooks.js` applies it. Closing a hole is
  now a one-line fixture edit instead of remembering to write a test. Commands
  are stored as templates over a placeholder table because AOS's own gate
  refuses to write a file containing the literal destructive forms.
- **A `knownLimits` section in that corpus**, asserting what the gate does *not*
  catch: command substitution inside a `-c` payload, variable indirection,
  pipe-to-shell, herestrings, nesting past the recursion cap, and `xargs` taking
  its targets from stdin. They are pinned as `allow` on purpose — if one starts
  failing, the limit was closed and the docs need updating.
- **A seeded fuzzer** (`test/unit/fuzz.test.js`): 20 wrapper prefixes × 6
  destructive and 7 harmless payloads × 5 shell-string forms, plus chaining and
  redirects, over a deterministic PRNG so any failure replays from the seed it
  prints. Invariants: a destructive payload never returns `allow`, an ordinary
  one never returns `deny`, the full wrapper × payload cross product is checked
  exhaustively, degenerate input never throws, and pathological nesting
  terminates. The invariants are scoped to the generated grammar — the
  documented limits above are deliberately not generated, since asserting them
  would claim a guarantee the gate has never made.

## 0.12.0 — 2026-08-03

Gate hardening — five wrapper programs and two ways of running a command from a
string were getting past the structural checks — plus bounded ledgers, a
dist-freshness gate that actually exists, and docs that say what AOS is for next
to the spec and task tools rather than competing with them.

### Fixed

- **The gate missed commands riding on five more wrappers.** `nice`, `timeout`,
  `doas`, `stdbuf` and `setsid` read as unknown programs, so `nice rm -r -f ~`
  sailed past every structural check while bare `rm -r -f ~` was denied. They
  are unwrapped the way `sudo` is — per-wrapper option tables, plus the
  duration operand in `timeout 30 cmd` — and get the wrapped command's verdict.
- **`eval "cmd"` and `bash -c "cmd"` erased their own evidence.** Quote-stripping
  removed the payload before the regex tiers ran, and the structural checks saw
  `eval`/`bash`, not the command inside — `eval "rm -rf /"` and
  `bash -c "rm -rf /"` were both allows. The payload of an `eval` segment, and
  of `-c` on `bash`/`sh`/`zsh`/`dash`, is now evaluated through the same gate
  (recursion-capped, escaped-quote nesting included), so `eval "ls"` still
  doesn't prompt.
- **`git -c core.hooksPath=/tmp push` bypassed the hook-rewiring gate** — the
  check required the literal word `config`. The per-command `-c` form is
  flagged the same way; an ordinary `-c user.email=…` stays clean.
- **The dist-freshness gate the README advertised didn't exist.** Bundle-mode
  `test:bundle` now fails fast ("dist is stale, run npm run build") when any
  file under `src/` or `scripts/build.mjs` is newer than `dist/aos.mjs`,
  instead of passing against yesterday's bundle.
- **No more literal NUL bytes in the sources.** The glob placeholder in
  `policy.js` and the console's markdown-fence sentinel were raw `\x00` bytes,
  which made both files read as "data" to file(1) and choke UTF-8 tooling.
  Both are escapes now (`\u0000`, private-use `\uE000`) — same runtime value,
  byte-safe source.
- **`sessions.jsonl` and per-run `audit.jsonl` grew without bound** while every
  reader slurped them whole (`hook-errors.log` already had its 1MB cap). Both
  rotate at 10MB — to `sessions.jsonl.1` and `audit.1.jsonl`, one generation.
  Session totals and contract history read the rotated generation, so no total
  silently resets at the boundary; the console's audit tail is display-only
  and reads the current file as before.

### Changed

- **Positioning: AOS complements the spec and task tools, it doesn't replace
  them.** Spec Kit, Taskmaster and BMAD produce the plan; they enforce it by
  convention. AOS enforces what happens while the work is done — gates that are
  hooks, audit that is automatic, contracts that must pass before a run closes.
  README and DOCS now lead with that instead of a feature list.
- **Cost tracking is documented, not advertised.** `aos cost` is worth having
  next to the runs and the gates, but it isn't why you'd install AOS — dedicated
  usage dashboards do it better from the same files. Removed from both
  quickstarts; the full reference in DOCS is unchanged.
- **Memory is described for what it is:** curated, diffable, deterministic
  markdown — a tail of exactly what was written, not embeddings and not an
  AI-compressed summary of what an agent once knew.
- **The fleet hub is described as context inheritance, not orchestration.**
  "Files and a `cd`" was already in the README; it now says what that buys —
  every session that touches a registered repo inherits that repo's gates,
  context, and audit — instead of half-apologising for the process supervision
  it deliberately doesn't have.

## 0.11.1 — 2026-07-27

Fixes to 0.11.0, which shipped with a sign-off gap and a console that
misreported its own numbers. **Upgrade from 0.11.0.**

### Fixed

- **A run could be closed with no sign-off.** `aos run finish --state
  done|shipped` reaches the same terminal state as `aos run state done|shipped`,
  but only the latter was gated and only the latter recorded `closed_by` — so a
  run could reach `done` with no prompt, no approver, and a record saying nobody
  closed it. Reachable without `--force`. Both spellings now take the same
  sign-off route and the policy's close rule matches both; plain `aos run finish`
  (to `awaiting-review`) is not a close and stays ungated.
- **A sign-off approval was not bound to what it approved.** The ticket recorded
  the action but not the target, so a prompt shown for `--run A` authorized
  closing `--run B` for the next five minutes. An approval is for a specific
  thing or it is not an approval; tickets now carry the run they were shown for.
  (Found as a flaky test: an early gate assertion left a live ticket that let a
  later "must refuse without sign-off" case succeed, intermittently, depending
  on how fast the suite ran.)
- **Sign-off tickets were minted where nobody is prompted.** Claude Code fires
  `PreToolUse` in every permission mode and honours `deny` even under
  `--dangerously-skip-permissions`, so the forbidden tier always held — but an
  `ask` only reaches a human in a prompting mode. In `bypassPermissions`,
  `acceptEdits`, `auto` and `dontAsk` the ticket asserted an approval nobody
  gave. None is minted in those modes now, and every gate decision records the
  `permission_mode` it was taken under.
- **The console reported two things that were not true.** Leverage read "no
  finished runs" beside a panel reading "RUNS 5"; review coverage counted
  `adversarial_review === 'present'`, a pre-0.11 value, so every run finished
  under the new schema — including `forced` — silently vanished from the stat.
  `warn` mode displayed as "✓ required". A project in `dry_run` looked fully
  protected. All four corrected, with a test that fails if the console stops
  naming any review state the gate can stamp.
- **`review.json` could not be viewed at all** — the run API enumerated markdown
  only. Runs gained a Review tab rendering findings, dispositions and locations,
  parsed by the same code the finish gate uses.
- **`aos run link` applied a partial change on rejection**, and `--pr` with no
  value reported success while linking nothing. All inputs are validated before
  meta.json is touched. A malformed `%` in a ticket URL no longer kills
  `run start`.
- **The close audit line contradicted meta.json** on the review state: a run
  stamped `forced` was audited as `absent`. The audit now records what meta
  actually says.
- Touched-file paths render home-relative in the console, matching the repo path
  and run folder.

### New

- **Runs record where the change lives**: `branch` (read off `.git/HEAD`, no
  subprocess), `ticket_url` when `--ticket` is given a tracker URL, `pr_url` via
  **`aos run link`**, and `files` — what the run actually touched, reconstructed
  from its own audit trail. Only http(s) URLs are accepted, at capture and again
  at render.
- **The run page says what is waiting on you and how to do it**: `/aos-approve`,
  the direct close command, and `claude --resume <session>`, each copyable, with
  the PR link first. Plus a Record panel showing sign-off identity and route,
  per-run contract results, the state timeline and the bound session.
- Runs table gained a Review column so `forced` is scannable; the Policy panel
  shows the 0.11 guards; run rows are keyboard-reachable.

## 0.11.0 — 2026-07-26

The adversarial review stops being a checkbox, a silently-absent gate stops
being invisible, the review queue stops being a graveyard, and the cost number
stops lying.

**Upgrading.** Three behaviour changes worth knowing before you update:
`aos run finish` now refuses without a `review.json` (set
`adversarial_review: warn` to keep the old behaviour); destructive git commands
now ask (set `tiers.protect_worktree: false` to opt out); and reported token
totals will *drop*, because they were being double-counted — the new numbers are
the correct ones. Re-run `aos init` in each repo to pick up the new policy
template, then `aos doctor`.

### New

- **Runs record where the change lives.** Reviewing a run means reading its
  diff, and a run had no idea what branch it was on. `run start` now reads the
  branch straight off `.git/HEAD` (no subprocess — the CLI shells out for
  verification contracts and nothing else) and `run finish` re-reads it, since
  work often starts on main and moves to a feature branch once the plan is
  approved. `--ticket` accepts a tracker URL and keeps the link while still
  deriving a readable run id. **`aos run link`** attaches the PR, ticket URL or
  branch after the fact — a PR cannot be auto-detected without a network call.
  Only http(s) URLs are accepted, at capture and again at render.
- **Runs record what they touched.** `meta.files` is reconstructed from the
  run's own audit trail at finish — relative to the repo where they sit inside
  it, excluding the run's own bookkeeping writes — so "what did this actually
  change" no longer means reading audit.jsonl. Shell writes are counted, never
  parsed into filenames.
- **`aos cost`** — what the agent actually cost, at API list prices, from the
  per-model buckets AOS already records. Grouped by project (default), `run`,
  `model`, or `contract`; windowed with `--since 7d|24h|2w|<date>`.
  - It always reports **session spend** and **spend inside runs** separately,
    plus the share. That gap is the honest answer to "how much of my agent bill
    goes through the pipeline", and collapsing the two into one number would
    flatter the pipeline's coverage.
  - `--by contract` shows which contracts fail and what the runs they failed in
    cost — labelled as exactly that, not as "cost caused by", because retry
    tokens are not separable from the rest of a run.
  - When a run's tokens settle, its price tag is stamped into `outcome.md` under
    `## Cost`, so a PR drafted from that file carries its own cost. Marked and
    idempotent: re-stamping replaces, never duplicates, and never touches the
    prose above it.
  - Models with no pricing rule are counted as `unpriced` and called out rather
    than guessed at. Override rates in `~/.aos/pricing.yaml`.
- **`aos init --hooks-only`** — installs the layer that works without anyone
  invoking anything: context injection, gates, audit, token accounting. No
  skills, no pipeline. The project home is still scaffolded, because
  `policy.yaml` *is* the gate and `pack.md` *is* the memory. Running plain
  `aos init` later adds the pipeline on top. The README now leads with this.
- **Scope gate** — when a run's `plan.md` has a `## Files` (or `## Scope`)
  section, writes outside that list ask. This is the one gate that knows what
  the work is *supposed* to be: everything else asks "is this command
  dangerous", this asks "is this the change you described" — the drift plan
  approval cannot catch, where an agent gets sign-off for a two-file fix and
  then refactors nine other modules. Entries may be exact paths, directories or
  globs; commentary and backticks are stripped and prose lines ignored.
  **Self-activating**: a plan that declares nothing gates nothing, so no
  existing project changes behaviour and there is no flag to remember.
  `scope_gate: false` switches it off.
- **`dry_run: true`** — record what every gate *would* decide and let the tool
  through, for tuning a policy against a real workflow before it starts
  blocking. `aos status` prints the suppressed decisions with a breakdown by
  action, and **`aos doctor` fails** while it is on: a forgotten `dry_run` looks
  exactly like a healthy install from inside a session, because nothing ever
  prompts. No sign-off tickets are minted in dry run — there is no prompt to
  approve. Closing a run still works there, recorded as
  `via: dry-run` so the record says plainly that nobody was asked.

### Fixed

- **Permission modes are accounted for.** Claude Code fires `PreToolUse` in every
  mode and honours `deny` even under `--dangerously-skip-permissions`, so the
  forbidden tier always holds — but an `ask` only reaches a human in a
  prompting mode. Every gate decision now records the `permission_mode` it was
  taken under, and **no sign-off ticket is minted** in `bypassPermissions`,
  `acceptEdits`, `auto` or `dontAsk`: the ticket claims a human approved a
  prompt, which is untrue where the mode auto-approves. Closing a run in those
  modes falls back to the terminal route.
- **The run page says what is waiting on you and how to do it.** A run parked at
  `awaiting-review` reported its state and nothing else — not the decision owed,
  not how to take it, not how to get the agent to do the legwork. It now leads
  with the action, copyable: `/aos-approve <run>` to have the agent re-check and
  propose the close, the direct `aos run state` command, and
  `claude --resume <session>` to reopen the session bound to the run. Blocked
  runs and unapproved plans get the same treatment.
- **The run page shows the rest of the record.** Sign-off identity and route
  (`closed_by` / `approved_by`), per-run contract results, the state timeline,
  the bound session, and whether learnings were captured were all recorded in
  meta.json and none of them were displayed.
- **Closing a run is gated whichever command gets there.** `aos run finish
  --state done|shipped` reaches the same terminal state as `aos run state
  done|shipped`, but only the latter was gated and only the latter recorded
  `closed_by`. A run could be closed with no prompt, no sign-off and a record
  saying nobody closed it. Both commands now take the same route, and the
  policy's close rule matches both.
- **Session token accounting was double-counting, by a lot.** Claude Code fires
  SessionEnd more than once for the same session — resume, `/clear` and logout
  each end a session whose transcript keeps growing — and every firing appended
  that session's *cumulative* total to `sessions.jsonl`. Summing every line
  therefore multiplied a resumed session's spend by the number of times it
  ended — a heavily resumed session can be counted the better part of ten times
  over, which is enough to make a project's reported tokens **mostly re-counts**
  and its dollar estimate wrong by a multiple. Readers now deduplicate by
  session id and keep the largest total (a rotated transcript can under-report a
  later line, never erase an earlier one). The log itself stays append-only —
  the sequence is what the learnings-debt marker reads.
  - Runs *bound* to a session were already settled exactly once and were never
    affected. Runs started outside a session were: they accumulated the raw
    cumulative total on every firing, so they carried the same inflation. They
    now keep a per-session high-water mark and credit only what is new, while
    still summing genuinely distinct sessions.
  - A `aos run finish` that the review gate **refuses** no longer settles the
    run either. It used to latch the total at whatever had been spent mid-work,
    so every token spent fixing the review vanished and the price tag stamped
    into `outcome.md` was a fraction of the truth.
- **The gate now protects the working tree.** `git reset --hard`, `git clean -f`,
  `git checkout -- .`, `git restore`, `git switch --force`, `git branch -D` and
  `git stash drop|clear` destroy work that exists in no commit — the accident
  that actually happens to agents, far more than `rm -rf /` — and nothing in the
  gate saw them, because none of them names the file it overwrites. They are now
  parsed structurally and gated at **ask**, never deny. The parser resolves
  flag clusters (`-Df`), `git -C .`, and wrapper prefixes with their own options
  (`sudo -E`, `sudo -u root`, `env -u FOO`, `xargs -n 1`, `VAR=x`) — a wrapper
  flag used to leave the real program unrecognized, which silently disabled the
  self-protection checks too. For `git checkout`, whether an operand is a branch
  or a path is settled by asking the working tree rather than by the shape of
  the name: a branch called `fix/typo.md` is not gated, a directory called `src`
  is. Two operands and an explicit `--` are git's own grammar for a path restore
  and always ask.
  Non-destructive neighbours stay silent: `git checkout <branch>`,
  `git checkout -b new main`, `git checkout v1.0.0`, `git restore --staged`,
  `git reset --soft`, plain `git stash`. They also count as writes now, so
  `git checkout -- .claude/settings.json` can't disarm the hooks. Opt out with
  `tiers.protect_worktree: false`.
- **`gsed -i` was a bypass.** Command aliasing is resolved before any check:
  GNU `g`-prefixes folded (`gsed`, `gawk`, `gcp` — the macOS/Homebrew spelling),
  `busybox`/`toybox` applets unwrapped, and leading `VAR=value` assignments
  skipped. `git`, `grep` and `gh` are deliberately not folded. Every check built
  on `commandWritesFiles` — the plan gate and the protected paths — was
  bypassable by spelling `sed` as `gsed`.
- **The leverage ratio no longer reports a percentage it can't support.** Below
  10 finished runs `aos status` shows the raw fraction
  (`clean-first-pass: 1/3 runs (too few to rate)`) instead of "33%".
- **The review queue is drained in-session, not in a dashboard.** Closing a run
  required a TTY, which put the sign-off in the one place the human is not: they
  are in the Claude Code session, and the second terminal is a context switch
  that does not happen. In practice runs piled up at `awaiting-review` rather
  than being closed.
  - The `Stop` hook now blocks once when the session's run is sitting at
    `awaiting-review`, and hands the close back to the model that did the work:
    present the change and the review findings, recommend a disposition, run the
    close. `review_capture: false` opts out.
  - The gate already stops `aos run state done|shipped` and shows the human the
    exact command. Approving that prompt is now accepted as the sign-off: the
    PreToolUse hook mints a **single-use, 5-minute ticket** when it asks, and the
    CLI consumes it, recording `via: gate-prompt` alongside the OS user. A TTY
    still counts (`via: tty`) and still ranks first.
  - What the ticket proves is narrow, and the docs say so: the command was gated
    and then ran, which cannot happen without someone approving the prompt. It is
    not proof against an agent that invokes `aos hook pre-tool` itself to mint
    one — the same adversarial model the hook layer already declines to cover.
  - With no route at all the close still refuses, and the message now names all
    three ways to authorize it instead of only the terminal.
  - `aos run finish` points at the in-session close; `/aos-ticket` gained a
    close-out stage; `/aos-approve` proposes the close instead of telling the
    human to go open a terminal.
  - `signoff.json` joins the self-protected AOS state files: an agent writing
    one would be forging a human's approval to close a run, so creating it is
    the gate's job alone.

### Enforced

- **Adversarial review is now a gate, not a note.** The old check — a heading
  matching `adversarial|skeptic|refut` in `verification.md` plus 20 characters
  of body — was evidence-of-process a model satisfied by writing the heading.
  Reviews are now structured claims in the run's **`review.json`** (`reviewer`,
  `scope`, and `findings` with `severity` / `summary` / `location` / `status` /
  `resolution`), and **`aos run finish` refuses** while that file is missing,
  malformed, or holds a finding still marked `open`. This does not prove a review
  was *good* — nothing mechanical can — but it moves the bar from "a heading
  exists" to "explicit claims, each dispositioned", and makes the one checkable
  thing a hard stop: no run reaches review with a known-open finding in it.
  - **`aos run review`** validates the file on demand, against the same checks
    the gate uses, so the fix loop doesn't run through `finish`.
  - Escape hatches are loud: `aos run finish --force` finishes anyway and stamps
    the run `adversarial_review: forced` in meta *and* audit;
    `verification.adversarial_review: warn` in `policy.yaml` downgrades the gate
    to the previous warning behaviour; `false` still opts out entirely.
  - `meta.json` records the review state (`clean` / `resolved` / `open` /
    `invalid` / `absent` / `not-required` / `forced`) plus per-status counts.
  - The gate covers **both** entries into `awaiting-review` — `aos run finish`
    and `aos run state awaiting-review` — so the review can't be stepped around
    with the other command.
  - Forced jumps that skip `awaiting-review` entirely (`run state done --force`,
    `run finish --state done --force`) never block — the human sign-off is the
    authority at close — but they are **visible**: the review state is stamped
    into meta and the audit line, and the close prints
    "⚠ Closed with adversarial review: absent". No path leaves the run stuck at
    `pending` as if the question never came up.
  - `warn` mode warns out loud at finish (not just in meta), and `aos verify` /
    the console report the tri-state mode honestly instead of collapsing `warn`
    into "required".
  - **Upgrading:** projects on `adversarial_review: true` will find `aos run
    finish` blocked until a `review.json` exists. `/aos-verify` and `/aos-ticket`
    write it; set `warn` to keep the old behaviour.
- **A dead hook command is now detectable.** Hook commands end in `|| true` so a
  missing `aos` can never break a session — which also meant a moved or
  uninstalled binary turned every gate off with no visible symptom. `aos doctor`
  now resolves each wired hook command (launcher path, then the `PATH` fallback)
  and fails loudly when none resolve.
- **The fail-open path is tested.** New smoke coverage: every hook entry point
  swallows malformed input, exits 0, emits no decision, and logs to
  `hook-errors.log` where `doctor` surfaces it; and the launcher chain still
  exits silently with 0 when the binary is gone.
- **Docs** — README and DOCS.md rewritten to state plainly which parts are
  enforced mechanism (gates, plan approval, review gate, state machine, audit)
  and which are prompt-authored convention.

## 0.10.0 — 2026-07-19

Hardening: the pipeline's promises get teeth — captured learnings, a real state
machine, sign-off identity, verification for non-JS repos, and memory that
curates itself instead of silently forgetting.

- **Learnings capture** — a session that does substantive work without writing
  `learnings.md`/`decisions.md` is flagged at SessionEnd (`learnings_owed`),
  surfaced to the next session, reminded at `aos run finish`
  (`learnings_recorded` in meta), and backstopped by a new **Stop hook** that
  blocks the stop once so the in-session model extracts 1-3 learnings while it
  still has the context. No separate model call. Opt out with
  `learnings_capture: false`.
- **Run state machine** — `aos run state` validates transitions instead of
  writing free text: `in-progress → shipped` (skipping review) is now an error.
  Reopen paths stay legal; `--force` overrides and is audited.
- **Sign-off identity** — closing a run (`aos run state done|shipped`) now
  requires an interactive TTY (an agent's shell has none); plan approval stays
  prompt-based. Both record who signed off (`closed_by` / `approved_by`: OS
  user, via `tty`/`prompt`/`headless-env`, timestamp) in meta + audit. CI
  escape: `AOS_ALLOW_HEADLESS_APPROVE=1`, itself recorded.
- **Non-JS verification contracts** — `aos init` now seeds a required test
  contract for Go (`go test ./...`), Rust (`cargo test`), Python (`pytest`),
  Ruby (rspec), JVM (mvn/gradle), and Makefile/justfile `test` targets — and
  warns loudly when verification is empty instead of staying silent.
- **Budgeted session context** — the memory sections (decisions, learnings,
  open runs) are guaranteed their share of the 9k-char context; a bloated pack
  is truncated instead of amputating them. When `learnings.md` outgrows its
  ~30-line window the session is told to compact it (`/aos-learn` step 6).
- **`/aos-onboard`** — new skill: replace the scaffolded templates with the
  repo's actual truth — fill the pack from the code, mine git history for
  `decisions.md`, seed learnings from CI/TODOs, author contracts (policy writes
  stay ask-gated). Session start nags while the pack is still a template.
- Fixed a latent SessionEnd crash when the hook payload had no
  `transcript_path` (missing `models` bucket in the fallback usage object).

## 0.9.2 — 2026-07-19

The fleet: one primary agent, aware of everything, governed by AOS.

- **`aos fleet`** scaffolds `~/.aos/fleet/` — an AGENTS.md hub that turns a
  single Claude Code session into a primary agent over every registered
  project: routing table generated from the registry, dispatch recipes for
  crewmate sessions (each task tracked as an AOS run, so results land in the
  decision queue), and hard boundaries (delegate-don't-implement; gated
  actions still end at the operator's approval prompt). The default only
  writes files and prints how to start — **AOS never executes agents by
  default; agents execute AOS**. `--launch [claude|codex|opencode|droid]` is
  the explicit convenience that opens the hub in a runtime (bare `--launch`
  picks the first one installed). Never overwrites a tuned hub.
- **`aos find <query> --all`** — cross-project search over every project's
  memory (runs, decisions, learnings, audit), grouped by project. The
  "have we solved this anywhere before?" query a primary agent needs.
- **`aos run session [--run <id>]`** — prints the Claude Code session id bound
  to a run (the hooks have always recorded it). Enables resuming the exact
  crewmate that worked a run: `claude --resume $(aos run session --run <id>)`.

## 0.9.1 — 2026-07-19

- **The review action now exists.** `aos run state <state> --run <id>` targets
  any run — previously a finished run in `awaiting-review` had no supported way
  out (the command only touched the active run). Closing states (`done`/
  `shipped`) are **gated** like plan approval: an agent may review and propose
  the close, and the permission prompt is the human sign-off. Reopening
  (`in-progress`) is not gated.
- **New `/aos-approve` skill** — agent-assisted review of awaiting-review runs:
  verifies outcome.md's claims against the actual diff and acceptance criteria,
  recommends approve/send-back, then closes through the sign-off gate.
- **Console UX** (from the CONSOLE-1 review fleet): run-screen tabs switch via
  targeted rendering (no full-page redraw, no scroll jump, no entrance-
  animation replay); redraw guard compares full content so same-length changes
  ("12m"→"13m") update and identical content never destroys focus; runs show
  how long they took ("Took" column + run-screen duration, elapsed-so-far for
  open runs, `~` marker for pre-tracking runs); every markdown file in a run
  folder (findings.md, intake.md, reviews/*.md) is viewable as a tab, served
  with symlink AND hardlink guards, O_NOFOLLOW reads, and size caps; run paths
  display home-relative (`~/.aos/...`) so screenshots don't leak usernames
  (copy button still copies the full path); client run cache capped.

## 0.9.0 — 2026-07-19

New in this cycle — cost visibility, operator metrics, and portability:

- **Estimated dollar cost, honestly labeled.** Token usage is now recorded
  per model (cache writes split from fresh input — they bill at 1.25×/2×, not
  1×), and `aos status` plus the console show **≈ $ estimated at API list
  prices** for projects and per run. Subscription usage is flagged as
  API-equivalent value; unknown models stay unpriced rather than guessed;
  rates are overridable in `~/.aos/pricing.yaml` and applied at display time,
  so updating the table corrects history.
- **Operator metrics from data AOS already has.** Runs record when they enter
  each state (`state_times`); the console shows **cycle time** per run, median
  cycle per project, the **oldest-waiting** age on the decision queue with
  stale (>48h) items flagged, **adversarial-review coverage** (% of finished
  runs with a review actually recorded), and per-contract failure counts from
  each run's latest verify attempt.
- **`aos export` — the context pack as AGENTS.md.** Writes the project's pack,
  recent decisions, and learnings to the repo's `AGENTS.md`, which Codex CLI,
  Cursor, Copilot, and Claude Code (as fallback) read natively. Context only —
  gates and audit remain Claude Code-side. Refuses to overwrite a hand-written
  AGENTS.md; re-exports over its own marker.

Accuracy and hardening: the console's numbers now hold up to scrutiny, and the
gates cover the shell path they previously missed.

Round two (adversarial review of the gates + supply-chain pipeline):

- **Precise per-run token attribution.** Runs now record a token *baseline* at
  bind time and settle exactly once — at `aos run finish` (via the post-tool
  hook) or at SessionEnd, whichever comes first. A session that executes two
  runs back-to-back credits each with its own spend instead of dumping the
  whole session onto the last one; tokens spent before `run start` are no
  longer charged to the run.
- **Write-intent heuristic covers interpreters and more tools.** `python -c`/
  `node -e`/`perl`/`ruby` one-liners that plausibly write (open(…,'w'),
  writeFileSync, shutil, …), `sed -Ei`/`-ri` combined flags, `perl -pi`,
  `sort -o`, `curl -o`, `wget`, `tar` extract/create, `unzip`, `git am`.
- **Fewer false positives.** Quoted text no longer trips the gates: `git grep
  "a > b"` and arrow functions aren't "writes", a command merely *mentioning* a
  forbidden string is asked about rather than hard-denied (real invocations are
  caught structurally), heredoc bodies aren't parsed as commands.
- **Gate coverage:** `rm -rf /` inside `$(…)`, backticks, and loop bodies is
  now caught; `git config core.hooksPath` (hook rewiring without a file write)
  requires approval; quoted force flags (`'-f'`) and combined ones (`-uf`)
  count as force; `node dist/aos.mjs run approve` hits the approval gate;
  plan-gate exemption is per pipeline segment (chaining a repo write with a
  run-folder note no longer exempts the repo write) and understands `~`/`$HOME`
  forms of the run folder.
- **Installer/pipeline hardening:** all installer downloads are https-only
  (including redirects); integrity verification requires sha-512 exactly, as
  documented; `AOS_TARBALL_SHA256` allows out-of-band pinning for mirror
  installs (the same-origin `.sha256` sidecar is documented as
  corruption-only); the old install is kept as a backup until the new one
  verifies, then swapped; the release workflow now re-checks that committed
  `dist/` matches the source at the tag before publishing; GitHub Actions are
  pinned to commit SHAs; CI runs with read-only permissions; the release
  script stages only release files.

- **Fixed: finished runs no longer report 0 tokens.** The standard pipeline ends
  with `aos run finish` *inside* the session, which cleared the active-run
  pointer before `SessionEnd` fired — so token usage never reached the run.
  Attribution now falls back to the run bound to the session, active or not.
- **Fixed: no free verification pass.** `aos verify` with zero contracts
  configured used to record `verification: pass`, letting unverified runs count
  as clean-first-pass in the leverage ratio. It now records nothing, says
  "nothing was verified", and still exits 0.
- **Plan gate covers Bash.** With `plan_gate: ask`, write-intent shell commands
  (`tee`, `> file`, `sed -i`, `git apply`, `cp`/`mv`/…) are gated until
  `aos run approve`, closing the path that let an agent implement the whole
  change via redirection while the plan sat unapproved. Writes into the run
  folder and project memory stay open.
- **Protected paths cover Bash.** Shell commands that write to
  `.claude/settings.json`, `.git/hooks/`, or AOS policy/audit state get the
  same "ask" the file tools would.
- **Evasive git-push forms caught structurally.** `git -C . push` and other
  global-option forms the regex tiers missed now resolve to the push gate
  (forced pushes → denied); `git stash push` stays clean.
- **Hook failures are no longer invisible.** Hooks still fail open by design
  (a broken AOS must never break a session), but swallowed errors now land in
  `~/.aos/hook-errors.log` and `aos doctor` flags them.
- **Console accuracy.** Audit tab shows the true entry count (tail-of-60 is
  labeled); the Implement stage lights only on write/Bash activity, not reads;
  "Active runs" became "In progress" and counts what it says; the attempts
  column tooltip says "total attempts"; project cards date by latest update,
  not latest-created run; the sync indicator says "offline" when polling fails;
  token tooltips note the numbers are best-effort. Plus `nosniff`/`no-store`
  headers and apostrophe-safe HTML escaping.

## 0.8.1 — 2026-07-05

The open-source release: public repository, provenance-attested publishes, and
two features that make day one useful — a repo-aware `aos init` and recorded
(not assumed) adversarial review.

- **`aos init` drafts the context pack from your repo.** Instead of a blank
  template, `context/pack.md` starts filled in: description, runtime, language,
  frameworks, package manager, and top-level structure detected from
  `package.json`, `tsconfig.json`, lockfiles, the README, and
  Python/Go/Rust/Ruby/JVM markers. You review and refine instead of facing an
  empty page. Repos with no signal still get the blank template; re-running
  `init` never overwrites an existing pack.
- **`aos init` seeds verification contracts.** Detected `test`/`typecheck`/`lint`
  scripts become `verification.contracts` in the scaffolded `policy.yaml`
  (tests required, the rest advisory), so `aos verify` works out of the box.
  Package-manager aware — including Bun, where the seeded command is
  `bun run test` because `bun test` bypasses `scripts.test` for Bun's native
  runner. The template's guidance comments survive the injection.
- **Adversarial review is recorded, not assumed.** `aos run finish` scans the
  run's `verification.md` for an adversarial-review section and records
  `present`/`absent`/`not-required` in `meta.json`. Surfaced everywhere the
  operator decides: a warning on `finish`, an `adv:` column in `aos run list`,
  and ⚠/✓ flags in the `aos status` review queue. The `/aos-ticket` and
  `/aos-verify` skills now write findings under a standardized
  `## Adversarial review` heading. This verifies evidence-of-process, not
  quality — honest by design.
- Note: `aos run list` and `aos status` output gained the adversarial-review
  segment — adjust anything parsing that stdout positionally.

Prepared the repository to be public.

- **Source-install URL is HTTPS**, not SSH — `AOS_FROM_SOURCE=1` and the
  documented `git clone` now work for everyone, not just those with push access.
- **npm provenance enabled** (`publishConfig.provenance: true`). Releases from
  this version onward carry a signed attestation tracing the bundle back to this
  repo's CI. Attestations require a public repository.
- **Bundled-dependency licenses attributed.** Added `THIRD-PARTY-LICENSES.md`
  crediting the inlined `yaml` (ISC), and switched the build to esbuild
  `legalComments: external` so dependency license banners are preserved.
- **Package metadata:** added `homepage` and `bugs` fields.
- **Governance:** added `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`,
  issue/PR templates, Dependabot config, and README badges.
- **`aos update` help text** no longer claims `git pull` for release installs
  (stale since 0.7.1).

## 0.7.2 — 2026-07-05

Packaging + a cleaner network-access surface.

- **The compiled CLI makes no network requests.** `aos update` used to `fetch`
  the npm registry to check for a newer version. That check was redundant — the
  local `install.sh` already resolves the latest version from the registry and
  verifies its sha-512. `aos update` now just runs that installer, passing the
  running version so it no-ops when already current. All outbound access lives in
  one place (the installer); `dist/aos.mjs` calls no `fetch` and reaches no host.
- **Fixes "EntryPointError" from package analyzers.** `package.json` declared
  only `bin` (AOS is a CLI), so tools that resolve an entry point couldn't find
  one. Added `main` and an `exports` map pointing at the compiled bundle.
- **Importing the package no longer runs the CLI.** `dist/aos.mjs` now runs its
  command dispatch only when it is the process entry point (resolved via realpath
  so the `aos` launcher symlink and npm's bin shim still count); imported instead,
  it just exposes `main` and has no side effects — notably it no longer creates
  `~/.aos` on an importer's machine. Source and compiled invocation, including via
  symlink, are unchanged (verified in the smoke suite).

## 0.7.1 — 2026-07-05

Security: harden `aos update` against remote-script execution.

- **No more `curl … install.sh | bash`.** The self-update path used to fetch a
  fresh installer from a CDN and pipe it straight into a shell — a supply-chain
  risk (a compromised CDN could serve a malicious script). `aos update` now runs
  the `install.sh` that shipped *inside the already-integrity-verified install*
  on disk, via `execFileSync('bash', [path])` — no network-fetched script is
  executed, and no string is interpolated into a shell. The installer still
  downloads the new tarball and verifies the registry's sha-512 hash before
  swapping it in, so the update itself stays integrity-checked. Falls back to a
  printed `npm i -g` instruction if the local installer is somehow absent.
- Smoke suite gains a regression guard asserting the compiled bundle never pipes
  into a shell.

## 0.7.0 — 2026-07-05

Console redesign: from a single page to a proper multi-screen app.

- **Screens + navigation:** sidebar (projects with needs-you badges and live-run
  dots), breadcrumbs, hash routing — Overview → Project → Run; Esc walks back up.
- **Overview:** fleet KPIs (projects, need-you, active runs, tokens incl. cache),
  decision queue, per-project cards with leverage bars and state counts.
- **Project screen:** runs table with state filter chips + search, tokens-per-session
  sparkline, project memory (context pack / decisions / learnings, rendered), policy
  digest (plan gate, rule counts, contracts), playbooks.
- **Run screen:** full page replacing the drawer — pipeline stage strip
  (intake → plan → implement → verify → package), plan-approval chip, tabbed
  Outcome / Verification / Audit / Ticket / Plan with safe markdown rendering
  (tables, task lists, fenced code), audit timeline with event filters, copyable
  run folder path.
- **New API:** read-only `/api/project` (memory, policy digest, session series);
  `/api/run` now includes the run folder path. Same localhost + safe-id guards.
- **Visual design ("The Ledger"):** warm paper-and-ink theme with serif display
  type, monospace figures, earthy semantic status colors (olive/clay/ochre/teal)
  replacing the generic dark-dashboard look; hairline rules over boxed cards,
  status dot+label tags, a ledger-style KPI strip, a paper-grain texture, one
  entrance reveal on navigation, and a warm-charcoal `prefers-color-scheme: dark`
  counterpart. Still one self-contained file, no external fonts or assets.

## 0.6.0 — 2026-07-04

Guardrail hardening + concurrency/attribution fixes (from the first external-style review).

- **File writes are gated:** `PreToolUse` now covers `Write`/`Edit`/`MultiEdit`/`NotebookEdit`,
  not just Bash. Built-in protections: `.claude/settings.json`, `.git/hooks/`, and AOS's own
  policy/audit/state files require approval — an agent can no longer rewire or silence its own
  guardrails. User-defined `tiers.protected_paths` globs supported. Re-run `aos init` in each
  repo to pick up the wider hook matcher (`aos doctor` flags stale wiring).
- **Script laundering closed:** shell scripts being written are scanned with the same policy —
  writing `run.sh` containing `git push --force` is denied at write time, not discovered at run time.
- **Structural `rm` check:** catastrophic deletes are parsed token-wise (flag permutations like
  `-fr`/`-Rf`, `sudo` prefixes, `/*` and `$HOME` targets), no longer regex-only.
- **Sharper default patterns:** `--force-with-lease` downgrades from forbidden to gated;
  `+refspec` force-pushes forbidden; `deploy` anchored to invocations (`cat docs/deploy.md`
  no longer trips it).
- **`plan_gate: ask` is enforced, not remembered:** implementation file writes stay gated until
  the human approves via the new `aos run approve` (agent self-approval is itself gated).
- **Run ↔ session binding:** each run binds to the session that started it; audit lines and
  tokens from concurrent sessions in the same repo land in the project log instead of the run.
- **Concurrency safety:** all read-modify-write cycles on `state.json`/`meta.json` go through
  a bounded advisory lock; tmp files for atomic writes are pid-unique.
- **Cache-read token accounting:** cache reads tracked separately in `sessions.jsonl`, run
  meta, and `aos status` — no longer silently dropped.

## 0.5.1 — 2026-07-04

Polish pass: correctness, DX, and release discipline.

- **CLI exit codes:** `run finish`/`run state` with no active run and `find` without a
  query now exit 1 instead of 0 — errors are scriptable.
- **npm README fixed:** the package page no longer links to an unavailable site;
  the npm package page is the public home.
- **Release tooling:** `npm run release -- <patch|minor|major|x.y.z>` — bumps, enforces
  a CHANGELOG entry, builds, runs both test suites, commits, and tags; pushing stays
  deliberate. Documented in RELEASING.md.
- **Workflow hardening:** release fails fast if `package.json` doesn't match the tag;
  CI cancels superseded runs, uses current action versions, and shellchecks all scripts.
- **Package metadata:** declares `os: darwin/linux` honestly; `npm test` now runs both
  source and bundle suites; manual `npm publish` self-verifies via `prepublishOnly`.

## 0.5.0 — 2026-07-04

Public distribution via npm.

- **The npm registry is now the public channel.** The package ships the compiled
  single-file bundle (`dist/aos.mjs`), the skills/templates (`assets/`), and metadata.
  `bin` points at the bundle; `yaml` moved to devDependencies (it's inlined).
- **Two install methods, one artifact:** `npm i -g @albsugy/aos`, or
  `curl -fsSL https://cdn.jsdelivr.net/npm/@albsugy/aos/install.sh | bash` — the
  installer ships inside the package and is served by the jsDelivr CDN.
- **The curl installer resolves versions from the npm registry** and verifies the
  registry's sha-512 integrity hash before unpacking. `AOS_VERSION` pins an npm
  version; `AOS_NPM_REGISTRY` supports mirrors; direct-URL and from-source modes remain.
- **`aos update`** on release installs checks the npm registry (was GitHub Releases).
- **Release workflow** publishes to npm on `v*` tags when the `NPM_TOKEN` secret is set
  (skips with a notice otherwise) and attaches the npm-pack tarball to the GitHub release.

## 0.4.0 — 2026-07-04

Standard package distribution: release artifacts instead of source clones.

- **Installs no longer clone the repo.** The installer downloads `aos.tar.gz` from
  GitHub Releases (runtime only: `dist/` + `assets/` + metadata, ~150 KB), verifies
  its **SHA-256 checksum**, unpacks, and links. git is no longer required to install.
- **Release workflow** builds and attaches `aos.tar.gz` + `aos.tar.gz.sha256` to every
  `v*` release after re-running both smoke suites.
- **`aos update`** on release installs checks the latest GitHub release and only
  downloads when newer; dev checkouts keep the `git pull` path.
- **`AOS_VERSION=vX.Y.Z`** pins installs to a release; `AOS_TARBALL_URL` supports
  mirrors/testing; `AOS_FROM_SOURCE=1` clones and builds for contributors.
- Installer refuses to overwrite a dev checkout at the install path, and `aos doctor`
  now reports the install mode (release artifact vs dev checkout) and verifies layout.

## 0.3.1 — 2026-07-04

CI reliability + release infrastructure.

- **Fixed flaky console-UI smoke check** — `curl | grep -q` under `pipefail` races
  (grep exits on first match → curl gets EPIPE → pipeline fails despite a match);
  surfaced on ubuntu CI. Console checks now capture responses and match without pipes.
- **Dist-freshness gate hardened:** also fails on *untracked* files in `dist/`,
  which `git diff` alone cannot see.
- **Release workflow:** pushing a `v*` tag re-verifies both suites and creates a
  GitHub Release with generated notes.
- **npm publish readiness:** `files` allowlist, `publishConfig.access=public`,
  `prepublishOnly` build.

## 0.3.0 — 2026-07-04

Compiled installs.

- **Installs ship a compiled single-file bundle:** `dist/aos.mjs` — all
  dependencies inlined, minified, built by esbuild (`npm run build`) and committed;
  the installer links it directly. No npm download at install time.
- **Node ≥ 22 required** (was 18) — installer, `engines`, `aos doctor`, docs, and CI updated.
- **CI:** smoke suite runs against both source and the compiled bundle on node 22/24;
  a dist-freshness job fails if `dist/` wasn't rebuilt with source changes.
- **`aos update`** in compiled installs no longer touches npm at all — the pull delivers the new bundle.
- Source entry restructured: CLI moved to `src/cli.js`; `bin/aos.js` is a thin shim for dev/npm use.

## 0.2.0 — 2026-07-04

Production hardening.

- **Reproducible installs:** committed `package-lock.json`; installer and `aos update` use `npm ci` when the lockfile is present.
- **Pinned installs:** `AOS_REF=<tag|branch>` selects what the installer checks out (default `main`).
- **Console security:** project/run ids validated against path traversal; requests with a non-localhost `Host` header are refused (DNS-rebinding protection); friendly error when the port is taken.
- **Corruption resilience:** a corrupt `registry.yaml` degrades reads with a warning and blocks writes instead of clobbering; JSON state files are written atomically.
- **`aos doctor`:** diagnoses node version, app install, dependencies, `AOS_HOME`, registry integrity, dangling repo paths, and the current repo's hook wiring (including old-format detection).
- **Stable hook launcher** (from 0.1.x fixes): hooks call `$HOME/.local/bin/aos` with a PATH fallback instead of a pinned install path; `aos init` migrates old entries.
- **`aos update`** skips reinstalling dependencies when already up to date.
- **CI:** smoke suite (26 checks) on ubuntu/macos × node 18/20/22, plus shellcheck on the installer.

## 0.1.0 — 2026-07-04

Initial release: file spec (`~/.aos`), policy gates, run lifecycle, audit, Claude Code
skills (`/aos-ticket`, `/aos-verify`, `/aos-learn`, `/aos-ask`) and hooks, verification
contracts, local console, and curl installer.
