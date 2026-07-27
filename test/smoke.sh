#!/usr/bin/env bash
# AOS end-to-end smoke test. Runs against an isolated AOS_HOME and a throwaway repo.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom here; pass() cannot fail
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Override to test the compiled bundle: AOS_BIN="node $ROOT/dist/aos.mjs" bash test/smoke.sh
AOS="${AOS_BIN:-node $ROOT/bin/aos.js}"
WORK="$(mktemp -d)"
export AOS_HOME="$WORK/aos-home"
# The suite runs headless; sign-off commands (approve / state done|shipped)
# require a TTY unless this CI escape hatch is set. The refusal itself is
# tested explicitly by unsetting it for one call.
export AOS_ALLOW_HEADLESS_APPROVE=1
REPO="$WORK/demo-repo"
mkdir -p "$REPO"

pass() { echo "✅ $1"; }
fail() { echo "❌ $1"; exit 1; }

active_run_dir() {
  local project="${1:-demo}"
  echo "$AOS_HOME/projects/$project/runs/$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/$project/state.json")"
}
# `aos run finish` is gated on the adversarial review. Sections that aren't
# testing that gate satisfy it the way a real skeptic would — a hunt that
# found nothing. The gate itself is tested in its own section below.
review_active() {
  printf '%s' '{"reviewer":"skeptic subagent","scope":["src/demo.js","acceptance criteria"],"findings":[]}' \
    > "$(active_run_dir "${1:-demo}")/review.json"
}

cd "$REPO"
git init -q -b main

# --- init ---
$AOS init --name demo >/dev/null
[ -f "$AOS_HOME/registry.yaml" ] || fail "registry created"
[ -f "$AOS_HOME/projects/demo/policy.yaml" ] || fail "policy scaffolded"
[ -f "$REPO/.claude/skills/aos-ticket/SKILL.md" ] || fail "skills installed"
grep -q "hook pre-tool" "$REPO/.claude/settings.json" || fail "hooks wired"
pass "init: registry, spec, skills, hooks"

# hooks must reference the stable launcher (invoked path), never a realpath pin
grep -q '|| aos hook pre-tool' "$REPO/.claude/settings.json" || fail "hook PATH fallback missing"
grep -q '|| true' "$REPO/.claude/settings.json" || fail "hook never-fail tail missing"
pass "init: hooks use launcher + fallback"

# init twice must be idempotent (each entry mentions its cmd twice: primary + fallback)
$AOS init --name demo >/dev/null
HOOK_COUNT=$(grep -o "hook pre-tool" "$REPO/.claude/settings.json" | wc -l | tr -d ' ')
[ "$HOOK_COUNT" = "2" ] && pass "init: idempotent hooks" || fail "init duplicated hooks ($HOOK_COUNT)"

# old-format entries (pinned absolute path) get migrated on re-init
node -e '
  const fs = require("fs"); const p = process.argv[1];
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  s.hooks.PreToolUse = [{ matcher: "Bash", hooks: [{ type: "command", command: "node \"/old/gone/aos/bin/aos.js\" hook pre-tool" }] }];
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
' "$REPO/.claude/settings.json"
$AOS init --name demo >/dev/null
grep -q "/old/gone" "$REPO/.claude/settings.json" && fail "old-format hook not migrated" || pass "init: migrates old-format hooks"

# --- run lifecycle ---
$AOS run start --ticket "LIN-1" --title "Demo ticket" | grep -q "Run started" || fail "run start"
RUN_DIR=$(find "$AOS_HOME/projects/demo/runs" -mindepth 1 -maxdepth 1 -type d | head -1)
[ -f "$RUN_DIR/ticket.md" ] || fail "ticket.md scaffolded"
pass "run start + scaffold"

# --- hooks: gate decisions ---
hook_out() {
  printf '%s' "$1" | $AOS hook pre-tool
}
IN_ALLOW='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"ls -la"},"session_id":"s1"}'
IN_ASK='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"git push origin main"},"session_id":"s1"}'
IN_DENY='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"git push --force origin main"},"session_id":"s1"}'

[ -z "$(hook_out "$IN_ALLOW")" ] && pass "gate: safe command → allow (silent)" || fail "gate allow"
hook_out "$IN_ASK"  | grep -q '"permissionDecision":"ask"'  && pass "gate: git push → ask"  || fail "gate ask"
hook_out "$IN_DENY" | grep -q '"permissionDecision":"deny"' && pass "gate: force-push → deny" || fail "gate deny"
grep -q '"event":"gate"' "$RUN_DIR/audit.jsonl" && pass "gate decisions audited" || fail "gate audit"

# --- hooks: post-tool audit + session-start context ---
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Write","tool_input":{"file_path":"src/a.js"},"session_id":"s1"}' | $AOS hook post-tool
grep -q '"tool":"Write"' "$RUN_DIR/audit.jsonl" && pass "post-tool audited" || fail "post-tool audit"
CTX=$(printf '%s' '{"cwd":"'"$REPO"'","session_id":"s1"}' | $AOS hook session-start)
echo "$CTX" | grep -q "AOS project context" && pass "session-start injects context" || fail "session context"
echo "$CTX" | grep -q "Open runs" && pass "session context lists open runs" || fail "open runs in context"

# --- verify: contracts ---
cat > "$AOS_HOME/projects/demo/policy.yaml" <<'EOF'
version: 1
plan_gate: auto
verification:
  adversarial_review: true
  contracts:
    - name: passing-check
      command: "true"
      required: true
    - name: failing-check
      command: "false"
      required: false
EOF
$AOS verify >/dev/null 2>&1 && pass "verify: required contract passes → exit 0" || fail "verify exit code"
grep -q "Verdict: PASS" "$RUN_DIR/verification.md" && pass "verification.md written" || fail "verification report"
grep -q '"name": "passing-check"' "$RUN_DIR/meta.json" && pass "verify: per-contract results recorded in meta" || fail "contract results not in meta"

# required failure → exit 1
cat > "$AOS_HOME/projects/demo/policy.yaml" <<'EOF'
version: 1
verification:
  contracts:
    - name: must-fail
      command: "false"
      required: true
EOF
if $AOS verify >/dev/null 2>&1; then fail "verify should exit 1 on required failure"; else pass "verify: required failure → exit 1"; fi

# zero contracts → nothing verified: exit 0, but the run's verdict must NOT flip to pass
cat > "$AOS_HOME/projects/demo/policy.yaml" <<'EOF'
version: 1
EOF
$AOS verify 2>/dev/null | grep -q "nothing was verified" && pass "verify: no contracts → says so" || fail "no-contract wording"
grep -q '"verification": "fail"' "$RUN_DIR/meta.json" && pass "verify: no contracts → no free pass recorded" || fail "zero-contract verify granted a pass"

# --- finish + status + find ---
review_active
$AOS run finish >/dev/null
$AOS status | grep -q "awaiting-review" && pass "status shows awaiting-review" || fail "status"
# the review action: a FINISHED run (no active pointer) must be closable via --run
RUN1_ID=$(basename "$RUN_DIR")
$AOS run state "done" --run "$RUN1_ID" | grep -q "→ done" && pass "run state --run closes a finished run" || fail "state --run failed"
$AOS run state awaiting-review --run "$RUN1_ID" >/dev/null   # restore for later console tests
$AOS run state "done" --run "no-such-run" 2>/dev/null && fail "state --run accepted unknown run" || pass "run state --run rejects unknown run"
$AOS find "LIN-1" | grep -q "ticket.md" && pass "find searches project memory" || fail "find"
$AOS find "LIN-1" --all | grep -q "■ demo" && pass "find --all sweeps projects (grouped)" || fail "find --all"

# --- fleet hub: default is scaffold-only (AOS never executes agents by default) ---
FLEET_OUT=$($AOS fleet)
echo "$FLEET_OUT" | grep -q "Fleet hub" || fail "fleet command failed"
echo "$FLEET_OUT" | grep -q "codex" && pass "fleet: prints the supported runtimes" || fail "runtime list missing"
grep -q "primary orchestration agent" "$AOS_HOME/fleet/AGENTS.md" && pass "fleet: AGENTS.md scaffolded" || fail "fleet AGENTS.md missing"
# shellcheck disable=SC2016  # literal backticks — matching the markdown code span, not expanding
grep -q '`demo`' "$AOS_HOME/fleet/AGENTS.md" && pass "fleet: routing table generated from registry" || fail "routing table missing"
grep -q "@AGENTS.md" "$AOS_HOME/fleet/CLAUDE.md" && pass "fleet: CLAUDE.md import shim" || fail "CLAUDE.md shim missing"
printf 'operator-tuned\n' > "$AOS_HOME/fleet/AGENTS.md"
$AOS fleet >/dev/null
grep -q "operator-tuned" "$AOS_HOME/fleet/AGENTS.md" && pass "fleet: re-run never overwrites a tuned hub" || fail "fleet clobbered AGENTS.md"
$AOS fleet --launch bogus 2>/dev/null && fail "fleet accepted unknown runtime" || pass "fleet: --launch rejects unknown runtime"
($AOS fleet --launch bogus 2>&1 || true) | grep -q "claude, codex, opencode, droid" && pass "fleet: --launch lists supported runtimes" || fail "supported list missing"

# --- export: context pack → AGENTS.md for other runtimes ---
$AOS export | grep -q "AGENTS.md" || fail "export did not report AGENTS.md"
grep -q "generated by \`aos export\`" "$REPO/AGENTS.md" && pass "export: writes AGENTS.md with marker" || fail "AGENTS.md marker missing"
grep -q "Context pack" "$REPO/AGENTS.md" && pass "export: includes the context pack" || fail "pack content missing from AGENTS.md"
$AOS export >/dev/null && pass "export: re-export over own file works" || fail "re-export failed"
printf 'hand-written instructions\n' > "$REPO/AGENTS.md"
if $AOS export >/dev/null 2>&1; then fail "export overwrote a hand-written AGENTS.md"; else
  grep -q "hand-written" "$REPO/AGENTS.md" && pass "export: refuses to clobber a hand-written AGENTS.md" || fail "hand-written AGENTS.md was clobbered"
fi
rm "$REPO/AGENTS.md"

# --- hardened Bash gates (defaults merge in even with a partial policy.yaml) ---
IN_RMFR='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"sudo rm -fr /"},"session_id":"s1"}'
IN_RMSTAR='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"rm -rf /*"},"session_id":"s1"}'
IN_FWL='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"git push --force-with-lease origin main"},"session_id":"s1"}'
IN_DOCDEPLOY='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"cat docs/deploy.md"},"session_id":"s1"}'
IN_RUNDEPLOY='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"./deploy prod"},"session_id":"s1"}'
hook_out "$IN_RMFR"   | grep -q '"permissionDecision":"deny"' && pass "gate: rm -fr / → deny (flag permutation)" || fail "rm -fr bypass"
hook_out "$IN_RMSTAR" | grep -q '"permissionDecision":"deny"' && pass "gate: rm -rf /* → deny (glob target)" || fail "rm -rf /* bypass"
hook_out "$IN_FWL"    | grep -q '"permissionDecision":"ask"'  && pass "gate: force-with-lease → ask, not deny" || fail "force-with-lease verdict"
[ -z "$(hook_out "$IN_DOCDEPLOY")" ] && pass "gate: cat docs/deploy.md → allow (no false positive)" || fail "deploy false positive"
hook_out "$IN_RUNDEPLOY" | grep -q '"permissionDecision":"ask"' && pass "gate: ./deploy → ask" || fail "deploy invocation not gated"

# evasive git-push forms: global options between git and the subcommand.
# (FORCE_FLAG indirection keeps this script itself clean under the script-content scan.)
FORCE_FLAG="--""force"
IN_GITC='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"git -C . push origin main"},"session_id":"s1"}'
IN_GITCF='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"git -C . push '$FORCE_FLAG' origin main"},"session_id":"s1"}'
IN_STASH='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"git stash push"},"session_id":"s1"}'
hook_out "$IN_GITC"  | grep -q '"permissionDecision":"ask"'  && pass "gate: git -C . push → ask (evasive form)" || fail "git -C push bypass"
hook_out "$IN_GITCF" | grep -q '"permissionDecision":"deny"' && pass "gate: git -C . push -force → deny" || fail "git -C forced push bypass"
[ -z "$(hook_out "$IN_STASH")" ] && pass "gate: git stash push → allow (no false positive)" || fail "git stash push gated"

# Bash writes to protected targets get the same ask the file tools would
IN_BASHSET='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"echo {} > .claude/settings.json"},"session_id":"s1"}'
IN_BASHHOOKS='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"cp x .git/hooks/pre-commit"},"session_id":"s1"}'
IN_BASHPOLICY='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"echo x > '$AOS_HOME'/projects/demo/policy.yaml"},"session_id":"s1"}'
IN_BASHSCRATCH='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"echo hello > scratch.txt"},"session_id":"s1"}'
hook_out "$IN_BASHSET"    | grep -q '"permissionDecision":"ask"' && pass "gate: bash write to .claude/settings.json → ask" || fail "bash settings write bypass"
hook_out "$IN_BASHHOOKS"  | grep -q '"permissionDecision":"ask"' && pass "gate: bash write to .git/hooks → ask" || fail "bash git-hook write bypass"
hook_out "$IN_BASHPOLICY" | grep -q '"permissionDecision":"ask"' && pass "gate: bash write to policy.yaml → ask" || fail "bash policy write bypass"
[ -z "$(hook_out "$IN_BASHSCRATCH")" ] && pass "gate: ordinary bash write → allow (no plan gate active)" || fail "ordinary bash write gated"
IN_HOOKSPATH='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"git config core.hooksPath /tmp/hooks"},"session_id":"s1"}'
# shellcheck disable=SC2016  # the $(...) must reach the gate literally, not expand here
IN_SUBRM='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"echo $(rm -rf /)"},"session_id":"s1"}'
IN_QUOTED_FORCE='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"echo \"git push '$FORCE_FLAG'\""},"session_id":"s1"}'
hook_out "$IN_HOOKSPATH" | grep -q '"permissionDecision":"ask"'  && pass "gate: git config core.hooksPath → ask (hook rewiring)" || fail "hooksPath rewire not gated"
hook_out "$IN_SUBRM"     | grep -q '"permissionDecision":"deny"' && pass "gate: recursive root delete in command substitution → deny" || fail "subshell rm bypass"
hook_out "$IN_QUOTED_FORCE" | grep -q '"permissionDecision":"ask"' && pass "gate: forbidden string inside quotes → ask, not deny" || fail "quoted mention still hard-denied"

# --- working-tree guard: the destructive-git accident that actually happens ---
# None of these names the file it overwrites, so neither the regex tiers nor
# the write heuristic saw them before. All are `ask`, never deny.
bash_in() { echo '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"'"$1"'"},"session_id":"s1"}'; }
# `git checkout X` is a branch switch or a destructive path restore depending on
# what X IS, so the guard asks the working tree rather than guessing from the
# name. Give it a tree to ask about.
mkdir -p "$REPO/src" && : > "$REPO/src/app.js" && : > "$REPO/Makefile"
for CMD in "git reset --hard" "git clean -fdx" "git checkout -- ." "git checkout ." \
           "git restore src/" "git switch --discard-changes main" "git branch -D feat" \
           "git stash drop" "npm test && git checkout -- ." "git -C . reset --hard" \
           "git rm -r src/" "git rm -f x" "git worktree remove --force wt" \
           "git submodule deinit -f mod" "sudo git -C /repo clean -fdx" "FOO=1 env git clean -f" \
           "git checkout src/app.js" "git checkout HEAD src/app.js" "git branch -Df feat" \
           "git stash -q drop" "sudo -E git reset --hard" "sudo -u root git clean -fd" \
           "sudo -i git clean -fdx" "env -u FOO git reset --hard" "time -p git clean -f" \
           "xargs -n 1 git checkout --" "nohup git reset --merge" \
           "git checkout Makefile" "git checkout HEAD src/app.js 2>&1" "git checkout src"; do
  hook_out "$(bash_in "$CMD")" | grep -q '"permissionDecision":"ask"' \
    || fail "worktree guard missed: $CMD"
done
pass "gate: destructive git → ask (reset/clean/checkout/restore/switch/branch/stash)"
# Non-destructive neighbours must stay silent or the guard is unusable
for CMD in "git checkout main" "git checkout -b feature" "git restore --staged file.js" \
           "git reset --soft HEAD~1" "git stash" "git status" "git diff HEAD" \
           "git rm file.txt" "git rm --cached -r x" "git worktree remove wt" \
           "cat notes-about-git-reset--hard.md" "git checkout feature/login" "git checkout v1.0.0" \
           "git checkout -b feature main" "git checkout @{-1}" \
           "git checkout main 2>&1" "git checkout main >/dev/null" "git checkout -q main >/dev/null 2>&1"; do
  [ -z "$(hook_out "$(bash_in "$CMD")")" ] || fail "worktree guard false positive: $CMD"
done
pass "gate: safe git → allow (branch switch, --staged restore, soft reset, plain stash)"
# Name shape cannot decide branch-vs-path — a branch may be called fix/typo.md
# and a directory may be called src. Existence in the working tree decides.
for CMD in "git checkout fix/typo.md" "git checkout release/2.0.1" "git checkout deleted-file.js"; do
  [ -z "$(hook_out "$(bash_in "$CMD")")" ] || fail "branch-shaped ref gated as a path: $CMD"
done
pass "gate: a ref that names nothing on disk is a ref, whatever it looks like"
# The guard is opt-out, and the opt-out actually works
cp "$AOS_HOME/projects/demo/policy.yaml" "$WORK/policy-backup.yaml"
printf 'version: 1\ntiers:\n  protect_worktree: false\n' > "$AOS_HOME/projects/demo/policy.yaml"
[ -z "$(hook_out "$(bash_in "git reset --hard")")" ] \
  && pass "gate: protect_worktree false disables the guard" || fail "protect_worktree opt-out ignored"
cp "$WORK/policy-backup.yaml" "$AOS_HOME/projects/demo/policy.yaml"
# Destructive git counts as a write, so it can't sidestep the protected paths
hook_out "$(bash_in "git checkout -- .claude/settings.json")" | grep -q '"permissionDecision":"ask"' \
  && pass "gate: git checkout of .claude/settings.json → ask (write path)" || fail "git checkout hook-disarm bypass"

# --- write detection: GNU-prefixed and busybox applets are the same programs ---
# `gsed -i` is the macOS/Homebrew spelling; treating it as a non-writer made it
# a bypass for every check built on commandWritesFiles. Probed through the
# protected-path gate, which only fires on commands that write.
for CMD in "gsed -i s/a/b/ .claude/settings.json" "busybox sed -i s/a/b/ .claude/settings.json" \
           "gcp evil .claude/settings.json"; do
  hook_out "$(bash_in "$CMD")" | grep -q '"permissionDecision":"ask"' || fail "alias write missed: $CMD"
done
pass "writes: gsed/busybox sed/gcp reach the protected-path gate"
# ...without folding tools that merely start with g into their stripped names
for CMD in "grep -i settings .claude/settings.json" "gh pr view 1"; do
  [ -z "$(hook_out "$(bash_in "$CMD")")" ] || fail "alias false positive: $CMD"
done
pass "writes: grep/gh not mistaken for GNU-prefixed writers"

# --- file-write gates: self-protection + script laundering ---
IN_SETTINGS='{"cwd":"'$REPO'","tool_name":"Write","tool_input":{"file_path":"'$REPO'/.claude/settings.json","content":"{}"},"session_id":"s1"}'
IN_POLICY='{"cwd":"'$REPO'","tool_name":"Edit","tool_input":{"file_path":"'$AOS_HOME'/projects/demo/policy.yaml","new_string":"tiers: {}"},"session_id":"s1"}'
IN_LAUNDER='{"cwd":"'$REPO'","tool_name":"Write","tool_input":{"file_path":"'$REPO'/run.sh","content":"#!/bin/bash\ngit push --force origin main"},"session_id":"s1"}'
IN_OKWRITE='{"cwd":"'$REPO'","tool_name":"Write","tool_input":{"file_path":"'$REPO'/src/ok.js","content":"export {}"},"session_id":"s1"}'
hook_out "$IN_SETTINGS" | grep -q '"permissionDecision":"ask"'  && pass "gate: write .claude/settings.json → ask" || fail "settings write not gated"
hook_out "$IN_POLICY"   | grep -q '"permissionDecision":"ask"'  && pass "gate: write policy.yaml → ask (self-protection)" || fail "policy write not gated"
# forging a sign-off ticket is forging a human's approval to close a run
IN_TICKET='{"cwd":"'$REPO'","tool_name":"Write","tool_input":{"file_path":"'$AOS_HOME'/projects/demo/signoff.json","content":"{}"},"session_id":"s1"}'
hook_out "$IN_TICKET"   | grep -q '"permissionDecision":"ask"'  && pass "gate: write signoff.json → ask (no forged sign-off)" || fail "signoff ticket forgeable"
# self-protection must survive a wrapper's own flags — `sudo -E` used to make
# tokens[0] a flag, so nothing downstream saw sed/git at all
for CMD in "sudo -E sed -i s/a/b/ .claude/settings.json" "sudo -E git checkout -- .claude/settings.json"; do
  hook_out "$(bash_in "$CMD")" | grep -q '"permissionDecision":"ask"' || fail "wrapper-flag bypass: $CMD"
done
pass "gate: sudo -E <write to a protected path> → ask (wrapper flags skipped)"
hook_out "$IN_LAUNDER"  | grep -q '"permissionDecision":"deny"' && pass "gate: script with forbidden command → deny (no laundering)" || fail "script laundering not caught"
[ -z "$(hook_out "$IN_OKWRITE")" ] && pass "gate: normal file write → allow (silent)" || fail "normal write gated"

# --- plan gate: enforced, not remembered ---
cat > "$AOS_HOME/projects/demo/policy.yaml" <<'EOF'
version: 1
plan_gate: ask
EOF
$AOS run start --ticket "LIN-2" >/dev/null
RUN2=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/demo/state.json")
RUN2_DIR="$AOS_HOME/projects/demo/runs/$RUN2"
IN_IMPL='{"cwd":"'$REPO'","tool_name":"Write","tool_input":{"file_path":"'$REPO'/src/feature.js","content":"export {}"},"session_id":"sA"}'
IN_PLANFILE='{"cwd":"'$REPO'","tool_name":"Write","tool_input":{"file_path":"'$RUN2_DIR'/plan.md","content":"# Plan"},"session_id":"sA"}'
hook_out "$IN_IMPL" | grep -q '"permissionDecision":"ask"' && pass "plan gate: repo write before approval → ask" || fail "plan gate not enforced"
[ -z "$(hook_out "$IN_PLANFILE")" ] && pass "plan gate: writing plan.md itself → allow" || fail "plan gate blocks plan.md"
# Bash write-intent is plan-gated too — tee/redirect/sed -i can't sidestep the file gate
IN_BASHW='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"echo hack > src/feature.js"},"session_id":"sA"}'
IN_BASHRO='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"grep -r todo src"},"session_id":"sA"}'
IN_BASHRUNDIR='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"echo notes >> '$RUN2_DIR'/plan.md"},"session_id":"sA"}'
hook_out "$IN_BASHW" | grep -q '"permissionDecision":"ask"' && pass "plan gate: bash write before approval → ask" || fail "bash write not plan-gated"
[ -z "$(hook_out "$IN_BASHRO")" ] && pass "plan gate: read-only bash → allow" || fail "read-only bash plan-gated"
[ -z "$(hook_out "$IN_BASHRUNDIR")" ] && pass "plan gate: bash write into run folder → allow" || fail "plan gate blocks run-folder bash write"
# interpreter and combined-flag write shapes are gated; quoted > is not a write
IN_SEDEI='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"sed -Ei s/a/b/ src/feature.js"},"session_id":"sA"}'
IN_PYW='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"python3 -c \"open('"'"'x.py'"'"','"'"'w'"'"').write('"'"'hi'"'"')\""},"session_id":"sA"}'
IN_ARROW='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"node -e \"[1].map(x => x*2)\""},"session_id":"sA"}'
IN_QGT='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"git grep \"a > b\" src"},"session_id":"sA"}'
IN_CHAIN='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"sed -i s/a/b/ src/feature.js && echo done >> '$RUN2_DIR'/notes.md"},"session_id":"sA"}'
hook_out "$IN_SEDEI" | grep -q '"permissionDecision":"ask"' && pass "plan gate: sed -Ei → ask (combined flags)" || fail "sed -Ei bypass"
hook_out "$IN_PYW"   | grep -q '"permissionDecision":"ask"' && pass "plan gate: python -c writing a file → ask" || fail "interpreter write bypass"
[ -z "$(hook_out "$IN_ARROW")" ] && pass "plan gate: arrow function in quotes → allow (no > false positive)" || fail "quoted > false positive"
[ -z "$(hook_out "$IN_QGT")" ] && pass "plan gate: git grep \"a > b\" → allow" || fail "quoted redirect false positive"
hook_out "$IN_CHAIN" | grep -q '"permissionDecision":"ask"' && pass "plan gate: repo write chained with run-dir note → ask (per-segment)" || fail "chained write exempted by run-dir mention"
hook_out '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run approve"},"session_id":"sA"}' \
  | grep -q '"permissionDecision":"ask"' && pass "plan gate: agent self-approval → ask (human decides)" || fail "self-approval not gated"
# closing a review is gated the same way; reopening is not
hook_out '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run state done --run some-run"},"session_id":"sA"}' \
  | grep -q '"permissionDecision":"ask"' && pass "review gate: agent closing a review → ask (human sign-off)" || fail "review close not gated"
[ -z "$(hook_out '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run state in-progress --run some-run"},"session_id":"sA"}')" ] \
  && pass "review gate: reopening a run → allow" || fail "reopen wrongly gated"
$AOS run approve >/dev/null
[ -z "$(hook_out "$IN_IMPL")" ] && pass "plan gate: repo write after approval → allow" || fail "plan gate stuck after approval"
[ -z "$(hook_out "$IN_BASHW")" ] && pass "plan gate: bash write after approval → allow" || fail "bash plan gate stuck after approval"

# --- session binding: concurrent sessions don't pollute the run ---
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-2"},"session_id":"sA"}' | $AOS hook post-tool
grep -q '"session": "sA"' "$RUN2_DIR/meta.json" && pass "binding: run bound to starting session" || fail "run not bound"
[ "$($AOS run session --run "$RUN2")" = "sA" ] && pass "run session: prints the bound session id" || fail "run session wrong"
$AOS run session --run "$RUN1_ID" 2>/dev/null && fail "run session succeeded for unbound run" || pass "run session: unbound run → error"
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Grep","tool_input":{"pattern":"x"},"session_id":"sB"}' | $AOS hook post-tool
grep -q '"session":"sB"' "$RUN2_DIR/audit.jsonl" && fail "foreign session polluted run audit" || pass "binding: foreign session kept out of run audit"
grep -q '"session":"sB"' "$AOS_HOME/projects/demo/audit.jsonl" && pass "binding: foreign session lands in project audit" || fail "foreign session audit lost"

# --- token accounting: cache reads tracked, attribution respects binding ---
TRANS="$WORK/transcript.jsonl"
echo '{"message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":7}}}' > "$TRANS"
printf '%s' '{"cwd":"'"$REPO"'","session_id":"sA","transcript_path":"'"$TRANS"'"}' | $AOS hook session-end
grep -q '"cache_read_tokens":100' "$AOS_HOME/projects/demo/sessions.jsonl" && pass "tokens: cache reads recorded per session" || fail "cache reads not recorded"
grep -q '"cache_read": 100' "$RUN2_DIR/meta.json" && pass "tokens: cache reads attributed to bound run" || fail "cache reads not on run"
printf '%s' '{"cwd":"'"$REPO"'","session_id":"sB","transcript_path":"'"$TRANS"'"}' | $AOS hook session-end
grep -q '"cache_read": 100' "$RUN2_DIR/meta.json" && pass "tokens: foreign session tokens not attributed to run" || fail "foreign tokens leaked into run"
review_active
$AOS run finish >/dev/null
# Settlement is once-only: a second SessionEnd for the same bound session must
# not double-count the already-settled run.
printf '%s' '{"cwd":"'"$REPO"'","session_id":"sA","transcript_path":"'"$TRANS"'"}' | $AOS hook session-end
grep -q '"input": 15' "$RUN2_DIR/meta.json" && pass "tokens: settle is once-only (no double count)" || fail "run tokens double-counted"

# --- token precision: baseline at start, settle at finish (sequential runs) ---
TRANS2="$WORK/transcript2.jsonl"
cat "$TRANS" "$TRANS" > "$TRANS2"   # totals: 30 in / 14 out / 200 cache
$AOS run start --ticket "LIN-2b" >/dev/null
RUN2B=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/demo/state.json")
RUN2B_DIR="$AOS_HOME/projects/demo/runs/$RUN2B"
# bind with the session's usage-so-far (TRANS = 15 in) as the baseline
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-2b"},"session_id":"sC","transcript_path":"'"$TRANS"'"}' | $AOS hook post-tool
$AOS run approve >/dev/null
review_active
$AOS run finish >/dev/null
# the post-tool hook for `aos run finish` settles the delta: 30 - 15 = 15 in
# (checked via node, not grep — tokens_baseline also contains "input": 15)
run_tokens() { node -e 'const m=require(process.argv[1]);console.log(m.tokens.input,m.tokens.output)' "$1"; }
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run finish"},"session_id":"sC","transcript_path":"'"$TRANS2"'"}' | $AOS hook post-tool
[ "$(run_tokens "$RUN2B_DIR/meta.json")" = "15 7" ] && pass "tokens: finish settles usage above bind-time baseline" || fail "baseline delta wrong ($(run_tokens "$RUN2B_DIR/meta.json"))"
# SessionEnd afterwards must be a no-op for this already-settled run
printf '%s' '{"cwd":"'"$REPO"'","session_id":"sC","transcript_path":"'"$TRANS2"'"}' | $AOS hook session-end
[ "$(run_tokens "$RUN2B_DIR/meta.json")" = "15 7" ] && pass "tokens: session-end after settle is a no-op" || fail "session-end re-credited a settled run"
node -e 'const m=require(process.argv[1]);process.exit(m.state_times && m.state_times["awaiting-review"]?0:1)' "$RUN2B_DIR/meta.json" \
  && pass "runs: state_times recorded at finish (cycle time derivable)" || fail "state_times missing"

# --- session totals: a resumed session is counted once, not once per ending ---
# SessionEnd fires again on resume / clear / logout, each time re-summing the
# WHOLE transcript, so the same cumulative total lands in sessions.jsonl
# repeatedly. Summing every line inflated real projects by 2-14x.
DEDUP_REPO="$WORK/dedup-repo"; mkdir -p "$DEDUP_REPO"; (cd "$DEDUP_REPO" && git init -q -b main)
(cd "$DEDUP_REPO" && $AOS init --name dedup >/dev/null)
DTRANS="$WORK/dedup-transcript.jsonl"
echo '{"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":70,"cache_read_input_tokens":400,"output_tokens":30}}}' > "$DTRANS"
cat "$DTRANS" "$DTRANS" > "$WORK/dedup-transcript2.jsonl"   # resumed: 140 in / 60 out / 800 cache
sess_end() { printf '%s' '{"cwd":"'"$DEDUP_REPO"'","session_id":"'"$1"'","transcript_path":"'"$2"'"}' | $AOS hook session-end; }
dedup_tokens() { $AOS status | grep -A4 '(dedup)' | grep 'tokens:'; }
sess_end sR "$DTRANS"
sess_end sR "$WORK/dedup-transcript2.jsonl"   # resumed, transcript grew, SessionEnd again
sess_end sR "$WORK/dedup-transcript2.jsonl"   # a third ending, no new usage
[ "$(grep -c . "$AOS_HOME/projects/dedup/sessions.jsonl")" = "3" ] \
  && pass "sessions: every SessionEnd still appends (log stays an event sequence)" || fail "session log not append-only"
dedup_tokens | grep -q "140 in / 60 out" \
  && pass "sessions: resumed session counted once at its true total (not 3x)" || fail "session tokens double-counted: $(dedup_tokens)"
dedup_tokens | grep -q "800 cache-read" \
  && pass "sessions: cache reads deduplicated too" || fail "cache reads double-counted: $(dedup_tokens)"
# a shrinking transcript (rotated/truncated) must not erase the larger total
sess_end sR "$DTRANS"
dedup_tokens | grep -q "140 in / 60 out" \
  && pass "sessions: a smaller later ending cannot under-report the session" || fail "truncated transcript lost tokens"
# distinct sessions still add up
sess_end sS "$DTRANS"
dedup_tokens | grep -q "210 in / 90 out" \
  && pass "sessions: distinct sessions still sum" || fail "distinct sessions not summed: $(dedup_tokens)"

# --- unbound runs: repeated SessionEnd must not multiply their tokens ---
# An unbound run legitimately collects usage from several sessions, but each
# session's transcript total is cumulative and SessionEnd fires repeatedly.
(cd "$DEDUP_REPO" && $AOS run start --ticket "LIN-UB" >/dev/null)
UB_RUN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/dedup/state.json")
UB_DIR="$AOS_HOME/projects/dedup/runs/$UB_RUN"
ub_tokens() { node -e 'const m=require(process.argv[1]);console.log(m.tokens.input,m.tokens.output)' "$UB_DIR/meta.json"; }
sess_end sX "$DTRANS"; sess_end sX "$DTRANS"; sess_end sX "$DTRANS"
[ "$(ub_tokens)" = "70 30" ] && pass "tokens: unbound run counts one session once, not once per ending" || fail "unbound run double-counted ($(ub_tokens))"
sess_end sX "$WORK/dedup-transcript2.jsonl"   # same session, transcript grew
[ "$(ub_tokens)" = "140 60" ] && pass "tokens: unbound run credits only the growth" || fail "unbound growth wrong ($(ub_tokens))"
sess_end sY "$DTRANS"                          # a genuinely different session still adds
[ "$(ub_tokens)" = "210 90" ] && pass "tokens: unbound run still sums distinct sessions" || fail "unbound distinct session lost ($(ub_tokens))"

# --- a REFUSED `run finish` must not settle the run's tokens ---
# The review gate refusing is the designed common path; settling there would
# freeze the total mid-work and stamp a fraction of the real cost into outcome.md.
(cd "$DEDUP_REPO" && $AOS run start --ticket "LIN-RF" >/dev/null)
RF_RUN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/dedup/state.json")
RF_DIR="$AOS_HOME/projects/dedup/runs/$RF_RUN"
printf '%s' '{"cwd":"'"$DEDUP_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-RF"},"session_id":"sZZ"}' | $AOS hook post-tool
(cd "$DEDUP_REPO" && $AOS run finish >/dev/null 2>&1) && fail "finish succeeded without a review" || true
printf '%s' '{"cwd":"'"$DEDUP_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run finish"},"session_id":"sZZ","transcript_path":"'"$DTRANS"'"}' | $AOS hook post-tool
node -e 'const m=require(process.argv[1]);process.exit(m.tokens_settled?1:0)' "$RF_DIR/meta.json" \
  && pass "tokens: a refused finish leaves the run unsettled" || fail "refused finish settled the run"
# ...and the same holds from `blocked`, which is parked, not finished
(cd "$DEDUP_REPO" && $AOS run state blocked --run "$RF_RUN" >/dev/null)
(cd "$DEDUP_REPO" && $AOS run finish >/dev/null 2>&1) && fail "blocked finish succeeded without a review" || true
printf '%s' '{"cwd":"'"$DEDUP_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run finish"},"session_id":"sZZ","transcript_path":"'"$DTRANS"'"}' | $AOS hook post-tool
node -e 'const m=require(process.argv[1]);process.exit(m.tokens_settled?1:0)' "$RF_DIR/meta.json" \
  && pass "tokens: a finish refused from blocked leaves the run unsettled" || fail "blocked+refused finish settled the run"
(cd "$DEDUP_REPO" && $AOS run state in-progress --run "$RF_RUN" >/dev/null)
review_active dedup
(cd "$DEDUP_REPO" && $AOS run finish >/dev/null)
printf '%s' '{"cwd":"'"$DEDUP_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run finish"},"session_id":"sZZ","transcript_path":"'"$WORK/dedup-transcript2.jsonl"'"}' | $AOS hook post-tool
node -e 'const m=require(process.argv[1]);process.exit(m.tokens_settled&&m.tokens.input===140?0:1)' "$RF_DIR/meta.json" \
  && pass "tokens: the finish that succeeds settles the full amount" || fail "successful finish settled wrong"

# --- leverage ratio: a rate needs a sample; below it, show the fraction ---
$AOS status | grep -q "clean-first-pass: .*runs (too few to rate)" \
  && pass "status: small samples report the fraction, not a percentage" || fail "leverage percentage shown on a tiny sample"

# --- cost estimation: per-model buckets → $ at API rates ---
TRANSM="$WORK/transcript-model.jsonl"
echo '{"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":7}}}' > "$TRANSM"
$AOS run start --ticket "LIN-2c" >/dev/null
RUN2C=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/demo/state.json")
RUN2C_DIR="$AOS_HOME/projects/demo/runs/$RUN2C"
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-2c"},"session_id":"sD"}' | $AOS hook post-tool
printf '%s' '{"cwd":"'"$REPO"'","session_id":"sD","transcript_path":"'"$TRANSM"'"}' | $AOS hook session-end
grep -q '"models"' "$AOS_HOME/projects/demo/sessions.jsonl" && pass "cost: per-model buckets recorded per session" || fail "session models missing"
node -e 'const m=require(process.argv[1]);const b=m.tokens.models["claude-sonnet-4-6"];process.exit(b&&b.input===10&&b.cache_write_5m===5?0:1)' "$RUN2C_DIR/meta.json" \
  && pass "cost: per-model buckets attributed to run (cache writes split out)" || fail "run model buckets wrong"
$AOS status | grep -q "est. at API rates" && pass "cost: status shows estimated cost" || fail "status cost missing"
review_active
$AOS run finish >/dev/null

# --- adversarial review gate: structured findings, enforced at finish ---
# The gate is the one quality claim AOS enforces rather than reports: a run
# cannot reach awaiting-review while its review is missing, malformed, or has
# an unresolved finding.
$AOS run start --ticket "LIN-3" >/dev/null
RUN3_DIR=$(active_run_dir)
NO_REVIEW=$($AOS run finish 2>&1) && fail "finish succeeded with no adversarial review" || true
echo "$NO_REVIEW" | grep -q "adversarial review gate is not satisfied" && pass "review gate: no review.json → finish REFUSED" || fail "gate did not refuse"
echo "$NO_REVIEW" | grep -q '"scope"' && pass "review gate: refusal prints the schema to write" || fail "refusal is not actionable"
grep -q '"state": "in-progress"' "$RUN3_DIR/meta.json" && pass "review gate: refused finish leaves the run open" || fail "state moved despite refusal"

# malformed → refused with per-field errors (the message must be enough to fix the file by)
printf '%s' '{"reviewer":"x","findings":[{"severity":"urgent","summary":"nope","status":"wontfix"}]}' > "$RUN3_DIR/review.json"
BAD_REVIEW=$($AOS run finish 2>&1) && fail "finish accepted a malformed review" || true
echo "$BAD_REVIEW" | grep -q "severity: must be one of" && pass "review gate: malformed review → per-field errors" || fail "no per-field errors"
echo "$BAD_REVIEW" | grep -q "scope: required" && pass "review gate: a review must say what it hunted through" || fail "scope not required"

# a disposition that says nothing is not a disposition
printf '%s' '{"reviewer":"skeptic subagent","scope":["src/gate.js"],"findings":[{"severity":"low","summary":"a real enough finding to state","status":"dismissed","resolution":"no"}]}' > "$RUN3_DIR/review.json"
THIN=$($AOS run finish 2>&1) && fail "finish accepted an empty resolution" || true
echo "$THIN" | grep -q 'resolution: required for status "dismissed"' && pass "review gate: empty disposition rejected" || fail "thin resolution accepted"

# an OPEN finding blocks — this is the part that is a gate rather than a record
cat > "$RUN3_DIR/review.json" <<'EOF'
{
  "reviewer": "skeptic subagent",
  "scope": ["src/gate.js", "acceptance criterion 2"],
  "findings": [
    { "severity": "high", "summary": "the gate never fires on the shell path", "location": "src/gate.js:12", "status": "open" }
  ]
}
EOF
OPEN_OUT=$($AOS run finish 2>&1) && fail "finish accepted an open finding" || true
echo "$OPEN_OUT" | grep -q "still open" && pass "review gate: open finding blocks the finish" || fail "open finding did not block"
echo "$OPEN_OUT" | grep -q "src/gate.js:12" && pass "review gate: refusal names the open finding" || fail "open finding not named"
$AOS run review >/dev/null 2>&1 && fail "aos run review exited 0 with an open finding" || pass "review gate: aos run review reports the same verdict, non-zero"

# resolving it unblocks — and the dispositions are recorded, not just the fact of a review
cat > "$RUN3_DIR/review.json" <<'EOF'
{
  "reviewer": "skeptic subagent",
  "scope": ["src/gate.js", "acceptance criterion 2"],
  "findings": [
    { "severity": "high", "summary": "the gate never fires on the shell path", "location": "src/gate.js:12", "status": "fixed", "resolution": "extended the check to Bash redirects and tee" },
    { "severity": "low", "summary": "the error message says file when it means path", "status": "dismissed", "resolution": "cosmetic, and the wording matches the docs" }
  ]
}
EOF
$AOS run review | grep -q "all dispositioned" && pass "review gate: aos run review validates a complete review" || fail "valid review not accepted"
FIN3=$($AOS run finish)
echo "$FIN3" | grep -q "1 fixed, 1 dismissed" && pass "finish: prints the dispositions" || fail "dispositions not printed"
grep -q '"adversarial_review": "resolved"' "$RUN3_DIR/meta.json" && pass "finish: records adversarial_review=resolved" || fail "resolved not recorded"
grep -q '"total": 2' "$RUN3_DIR/meta.json" && pass "finish: records the finding counts in meta" || fail "counts not recorded"

# a genuine hunt that found nothing is a legitimate result
$AOS run start --ticket "LIN-4" >/dev/null
RUN4_DIR=$(active_run_dir)
review_active
$AOS run finish >/dev/null
grep -q '"adversarial_review": "clean"' "$RUN4_DIR/meta.json" && pass "finish: empty findings + scope → clean" || fail "clean hunt not recorded"

# --force is the escape hatch, and it is audited — skipping the review is visible forever
$AOS run start --ticket "LIN-4b" >/dev/null
RUN4B_DIR=$(active_run_dir)
FORCED=$($AOS run finish --force)
echo "$FORCED" | grep -q "FORCED" && pass "review gate: --force finishes but says so" || fail "forced finish not announced"
grep -q '"adversarial_review": "forced"' "$RUN4B_DIR/meta.json" && pass "review gate: forced state recorded in meta" || fail "forced state not recorded"
grep -q '"review_forced":true' "$RUN4B_DIR/audit.jsonl" && pass "review gate: force audited" || fail "forced finish not audited"

# the other way into awaiting-review must clear the same gate, or the review is
# one command away from being skipped
$AOS run start --ticket "LIN-4c" >/dev/null
BYPASS=$($AOS run state awaiting-review 2>&1) && fail "run state reached awaiting-review with no review" || true
echo "$BYPASS" | grep -q "cannot reach awaiting-review" && pass "review gate: aos run state awaiting-review is gated too" || fail "state path bypasses the review gate"
$AOS run state awaiting-review --force >/dev/null && pass "review gate: --force overrides on the state path too" || fail "forced state transition refused"

# policy opt-out: `warn` keeps the pre-gate behaviour (record, never block)
WARN_REPO="$WORK/warn-repo"; mkdir -p "$WARN_REPO"
( cd "$WARN_REPO" && git init -q -b main && $AOS init --name warnproj >/dev/null )
cat > "$AOS_HOME/projects/warnproj/policy.yaml" <<'EOF'
version: 1
verification:
  adversarial_review: warn
EOF
( cd "$WARN_REPO" && $AOS run start --ticket "W-1" >/dev/null )
WARN_FIN=$( cd "$WARN_REPO" && $AOS run finish )
pass "review gate: adversarial_review=warn does not block"
# warn's whole promise is that the warning still happens — a silent warn mode
# is indistinguishable from off (regression caught in review, now pinned)
echo "$WARN_FIN" | grep -q "recorded, not blocking" && pass "review gate: warn mode WARNS at finish" || fail "warn mode finished silently"
grep -rq '"adversarial_review": "absent"' "$AOS_HOME/projects/warnproj/runs" && pass "review gate: warn mode still records the absence" || fail "warn mode recorded nothing"
( cd "$WARN_REPO" && $AOS verify 2>/dev/null ) | grep -q "warn, not block" && pass "verify: warn mode message says warn, not required" || fail "verify misreports warn as a hard gate"

# --force straight to done (skipping awaiting-review entirely) must be VISIBLE:
# review state stamped in meta, in the audit line, and shown to the signing human
$AOS run start --ticket "LIN-4d" >/dev/null
RUN4D_DIR=$(active_run_dir)
CLOSE_OUT=$($AOS run state "done" --force)
echo "$CLOSE_OUT" | grep -q "Closed with adversarial review: absent" && pass "review gate: forced close warns the signing human" || fail "forced close was silent"
grep -q '"adversarial_review": "absent"' "$RUN4D_DIR/meta.json" && pass "review gate: forced close stamps meta (not stuck pending)" || fail "forced close left adversarial_review=pending"
grep -q '"adversarial_review":"absent"' "$RUN4D_DIR/audit.jsonl" && pass "review gate: forced close audited with review state" || fail "forced close audit has no review state"
# finish --force must actually force the transition its error message advertises
$AOS run start --ticket "LIN-4e" >/dev/null
$AOS run finish --state "done" 2>/dev/null && fail "illegal finish transition accepted without force" || true
$AOS run finish --state "done" --force >/dev/null && pass "review gate: finish --force forces the transition too" || fail "finish --force did not force the transition"

# --- learnings capture: finish reminder, Stop-hook extraction, SessionEnd debt ---
grep -q "hook stop" "$REPO/.claude/settings.json" && pass "init: Stop hook wired" || fail "Stop hook not wired"
$AOS run start --ticket "LIN-5" >/dev/null
RUN5=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/demo/state.json")
RUN5_DIR="$AOS_HOME/projects/demo/runs/$RUN5"
# bind the run to session sE, then three substantive file edits, no learnings write
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-5"},"session_id":"sE"}' | $AOS hook post-tool
for F in a b c; do
  printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Edit","tool_input":{"file_path":"src/'"$F"'.js"},"session_id":"sE"}' | $AOS hook post-tool
done
review_active
FINISH5=$($AOS run finish)
echo "$FINISH5" | grep -q "No learnings recorded" && pass "finish: reminds when no learnings yet" || fail "no learnings reminder"
grep -q '"learnings_recorded": "absent"' "$RUN5_DIR/meta.json" && pass "finish: records learnings_recorded=absent" || fail "learnings absent not recorded"
# Stop: finished run + no memory write → block once with extraction instructions
STOP1=$(printf '%s' '{"cwd":"'"$REPO"'","session_id":"sE"}' | $AOS hook stop)
echo "$STOP1" | grep -q '"decision":"block"' && pass "stop: blocks once to extract learnings" || fail "stop did not block"
STOP2=$(printf '%s' '{"cwd":"'"$REPO"'","session_id":"sE"}' | $AOS hook stop)
[ -z "$STOP2" ] && pass "stop: nudges only once per session" || fail "stop nudged twice"
STOP3=$(printf '%s' '{"cwd":"'"$REPO"'","session_id":"sZ","stop_hook_active":true}' | $AOS hook stop)
[ -z "$STOP3" ] && pass "stop: stop_hook_active never re-blocks" || fail "stop_hook_active re-blocked"
# SessionEnd: substantive session with no learnings flags debt; next session-start surfaces it
printf '%s' '{"cwd":"'"$REPO"'","session_id":"sE"}' | $AOS hook session-end
grep -q '"learnings_owed":true' "$AOS_HOME/projects/demo/sessions.jsonl" && pass "session-end: flags learnings debt" || fail "debt not flagged"
CTX_OWED=$(printf '%s' '{"cwd":"'"$REPO"'","session_id":"sH"}' | $AOS hook session-start)
echo "$CTX_OWED" | grep -q "recorded no learnings" && pass "session-start: surfaces learnings debt" || fail "debt not surfaced"
# a light session (no substantive work) owes nothing
printf '%s' '{"cwd":"'"$REPO"'","session_id":"sH"}' | $AOS hook session-end
tail -1 "$AOS_HOME/projects/demo/sessions.jsonl" | grep -q "learnings_owed" && fail "light session owes learnings" || pass "session-end: light session owes nothing"
# ...but the older debt still surfaces — light sessions don't bury it
CTX_STILL=$(printf '%s' '{"cwd":"'"$REPO"'","session_id":"sI"}' | $AOS hook session-start)
echo "$CTX_STILL" | grep -q "recorded no learnings" && pass "session-start: debt persists past light sessions" || fail "debt buried by light session"
# reads of memory files must NOT count as capture
$AOS run start --ticket "LIN-6" >/dev/null
RUN6=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/demo/state.json")
RUN6_DIR="$AOS_HOME/projects/demo/runs/$RUN6"
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-6"},"session_id":"sF"}' | $AOS hook post-tool
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Read","tool_input":{"file_path":"'"$AOS_HOME"'/projects/demo/learnings.md"},"session_id":"sF"}' | $AOS hook post-tool
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"grep gate '"$AOS_HOME"'/projects/demo/context/decisions.md"},"session_id":"sF"}' | $AOS hook post-tool
review_active
$AOS run finish >/dev/null
grep -q '"learnings_recorded": "absent"' "$RUN6_DIR/meta.json" && pass "finish: reads of learnings.md don't count as capture" || fail "read counted as memory write"
# a learnings append (via shell redirect) clears the whole path: reminder, stop, and debt
$AOS run start --ticket "LIN-7" >/dev/null
RUN7=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/demo/state.json")
RUN7_DIR="$AOS_HOME/projects/demo/runs/$RUN7"
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-7"},"session_id":"sG"}' | $AOS hook post-tool
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"echo learned >> '"$AOS_HOME"'/projects/demo/learnings.md"},"session_id":"sG"}' | $AOS hook post-tool
review_active
$AOS run finish >/dev/null
grep -q '"learnings_recorded": "present"' "$RUN7_DIR/meta.json" && pass "finish: records learnings_recorded=present" || fail "learnings present not recorded"
# The run is still at awaiting-review, so the review nudge fires — but the
# learnings ask must not, and the two are independent.
STOP4=$(printf '%s' '{"cwd":"'"$REPO"'","session_id":"sG"}' | $AOS hook stop)
echo "$STOP4" | grep -q "nothing was recorded to learnings.md" && fail "stop asked for learnings despite the write" \
  || pass "stop: learnings written → no learnings ask"
echo "$STOP4" | grep -q "awaiting-review" && pass "stop: the review ask is independent of the learnings ask" || fail "review ask missing"
# session-end records the memory write, which retires the older debt at session-start
printf '%s' '{"cwd":"'"$REPO"'","session_id":"sG"}' | $AOS hook session-end
tail -1 "$AOS_HOME/projects/demo/sessions.jsonl" | grep -q '"memory_write":true' && pass "session-end: records memory write" || fail "memory write not recorded"
CTX_CLEAR=$(printf '%s' '{"cwd":"'"$REPO"'","session_id":"sJ"}' | $AOS hook session-start)
echo "$CTX_CLEAR" | grep -q "recorded no learnings" && fail "retired debt still surfaced" || pass "session-start: memory write retires debt"

# --- run state machine + sign-off identity ---
$AOS run start --ticket "LIN-8" >/dev/null
RUN8=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/demo/state.json")
RUN8_DIR="$AOS_HOME/projects/demo/runs/$RUN8"
$AOS run state shipped 2>/dev/null && fail "in-progress → shipped accepted" || pass "state: illegal transition rejected"
$AOS run state bogus 2>/dev/null && fail "unknown state accepted" || pass "state: unknown state rejected"
$AOS run state blocked >/dev/null && $AOS run state in-progress >/dev/null && pass "state: legal transitions still flow" || fail "legal transition rejected"
# close needs a TTY (stdin forced off the terminal so this also holds when run interactively)
OUT_NOTTY=$( (unset AOS_ALLOW_HEADLESS_APPROVE; $AOS run state "done" </dev/null) 2>&1 || true )
echo "$OUT_NOTTY" | grep -q "interactive terminal" && pass "state done: refused without a TTY" || fail "headless close not refused"
# plan approval stays prompt-based: works headless, identity recorded best-effort
$AOS run approve </dev/null >/dev/null
grep -q '"via": "headless-env"' "$RUN8_DIR/meta.json" && pass "approve: sign-off identity recorded in meta" || fail "approved_by not recorded"
$AOS run state shipped --force >/dev/null
grep -q '"state": "shipped"' "$RUN8_DIR/meta.json" && pass "state: --force overrides (escape hatch)" || fail "force override failed"
grep -q '"forced":true' "$RUN8_DIR/audit.jsonl" && pass "state: forced transition audited" || fail "forced transition not audited"
$AOS run state in-progress --force >/dev/null
review_active
$AOS run finish >/dev/null

# --- in-session sign-off: the gate prompt IS the human's approval ---
# Requiring a TTY put the sign-off in the one place the human never is — a
# second terminal — so runs stayed at awaiting-review forever. The gate now
# mints a single-use ticket when it asks, and the CLI accepts that as sign-off.
SIGN_REPO="$WORK/signoff-repo"; mkdir -p "$SIGN_REPO"; (cd "$SIGN_REPO" && git init -q -b main)
(cd "$SIGN_REPO" && $AOS init --name signoff >/dev/null)
sign_start() {  # start a run and bind it to a session, the way the pipeline does
  (cd "$SIGN_REPO" && $AOS run start --ticket "$1" >/dev/null)
  printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket '"$1"'"},"session_id":"'"$2"'"}' | $AOS hook post-tool
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/signoff/state.json"
}
RUNS=$(sign_start "LIN-S" sT)
RUNS_DIR="$AOS_HOME/projects/signoff/runs/$RUNS"
review_active signoff
(cd "$SIGN_REPO" && $AOS run finish) | grep -q "close it with" \
  && pass "finish: points at the in-session close, not a dashboard" || fail "finish gives no close instruction"

# Stop: the run is at awaiting-review and this session is the last one that
# knows what it did — surface the close here, not in a dashboard tomorrow.
STOP_REV=$(printf '%s' '{"cwd":"'"$SIGN_REPO"'","session_id":"sT"}' | $AOS hook stop)
echo "$STOP_REV" | grep -q "sitting at awaiting-review" && pass "stop: surfaces the open review before the session ends" || fail "stop did not surface the review"
echo "$STOP_REV" | grep -q "prompt IS the human" && pass "stop: tells the agent the prompt is the sign-off" || fail "stop nudge missing sign-off instruction"
STOP_REV2=$(printf '%s' '{"cwd":"'"$SIGN_REPO"'","session_id":"sT"}' | $AOS hook stop)
[ -z "$STOP_REV2" ] && pass "stop: review nudge fires once per session" || fail "review nudge repeated"

sign_gate() {  # the PreToolUse gate seeing the close command — mints the ticket
  printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run state '"$1"' --run '"$RUNS"'"},"session_id":"sT"}' | $AOS hook pre-tool
}
close_run() { (cd "$SIGN_REPO" && unset AOS_ALLOW_HEADLESS_APPROVE && $AOS run state "$1" --run "$RUNS" </dev/null) 2>&1; }

# no TTY, no gate prompt, no CI override → refuse, and say where to sign off
OUT_NOSIGN=$(close_run "done" || true)
echo "$OUT_NOSIGN" | grep -q "needs a human sign-off" && pass "close: refused with no sign-off of any kind" || fail "unsigned close accepted"
echo "$OUT_NOSIGN" | grep -q "interactive terminal" && pass "close: refusal still names the terminal route" || fail "refusal missing terminal route"

# the gate asks → the human approves the prompt → the same command now closes
sign_gate "done" | grep -q '"permissionDecision":"ask"' && pass "close: gate asks before the close runs" || fail "close not gated"
# flag order must not decide whether the gate fires — `--run X done` is equally
# valid CLI, and missing it left the agent in an unbreakable refusal loop
printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run state --run '"$RUNS"' done"},"session_id":"sT"}' | $AOS hook pre-tool \
  | grep -q '"permissionDecision":"ask"' && pass "close: gate fires whatever the flag order" || fail "flag order evaded the sign-off gate"
printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run state in-progress --run '"$RUNS"'"},"session_id":"sT"}' | $AOS hook pre-tool \
  | grep -q 'reserved for the human' && fail "reopening a run demanded sign-off" || pass "close: reopening stays ungated"
close_run "done" >/dev/null
grep -q '"state": "done"' "$RUNS_DIR/meta.json" && pass "close: gate-prompt approval closes the run in-session" || fail "gate ticket not accepted"
grep -q '"via": "gate-prompt"' "$RUNS_DIR/meta.json" && pass "close: sign-off route recorded as gate-prompt" || fail "sign-off route not recorded"

# single-use: the same approval cannot close a second time
(cd "$SIGN_REPO" && $AOS run state awaiting-review --run "$RUNS" >/dev/null)
close_run "done" >/dev/null 2>&1 && fail "consumed ticket reused" || pass "close: sign-off ticket is single-use"
# an approval shown for one run must not authorize closing a different one —
# without this the gate could ask about run A and a close of run B inside the
# five-minute window would spend that approval
sign_gate_other() {
  printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run state done --run some-other-run"},"session_id":"sT"}' | $AOS hook pre-tool >/dev/null
}
sign_gate_other
close_run "done" >/dev/null 2>&1 && fail "a ticket for another run closed this one" || pass "close: an approval is bound to the run it was shown for"
# and a plan-approval prompt is not a close approval
printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run approve"},"session_id":"sT"}' | $AOS hook pre-tool >/dev/null
close_run "done" >/dev/null 2>&1 && fail "plan-approve ticket closed a run" || pass "close: tickets are bound to their action"

# --- permission modes: an `ask` that reaches nobody is not a sign-off ---
# Claude Code fires PreToolUse in EVERY permission mode and honours `deny` even
# under --dangerously-skip-permissions, but an `ask` only reaches a human in the
# prompting modes. Minting a sign-off ticket in bypassPermissions/acceptEdits/
# dontAsk would let an agent close its own run with nobody in the loop.
mode_gate() {
  printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run state done --run '"$RUNS"'"},"session_id":"sT","permission_mode":"'"$1"'"}' | $AOS hook pre-tool
}
for MODE in bypassPermissions acceptEdits dontAsk auto; do
  rm -f "$AOS_HOME/projects/signoff/signoff.json"
  mode_gate "$MODE" | grep -q '"permissionDecision":"ask"' || fail "gate stopped asking in $MODE"
  [ -f "$AOS_HOME/projects/signoff/signoff.json" ] && fail "sign-off ticket minted in $MODE (no human sees that prompt)"
done
pass "modes: the gate still asks, but mints no sign-off ticket where nobody is prompted"
for MODE in default plan; do
  rm -f "$AOS_HOME/projects/signoff/signoff.json"
  mode_gate "$MODE" >/dev/null
  [ -f "$AOS_HOME/projects/signoff/signoff.json" ] || fail "no sign-off ticket in $MODE (a human IS prompted there)"
done
pass "modes: prompting modes still mint the ticket"
# an older Claude Code sends no permission_mode — assume the interactive default
rm -f "$AOS_HOME/projects/signoff/signoff.json"
printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run state done --run '"$RUNS"'"},"session_id":"sT"}' | $AOS hook pre-tool >/dev/null
[ -f "$AOS_HOME/projects/signoff/signoff.json" ] && pass "modes: a payload without permission_mode still works" || fail "missing permission_mode broke the ticket"
# and the mode is recorded on the gate decision, so an auditor can tell later
rm -f "$AOS_HOME/projects/signoff/signoff.json"
mode_gate bypassPermissions >/dev/null
grep -rq '"mode":"bypassPermissions"' "$AOS_HOME/projects/signoff/" \
  && pass "modes: the permission mode is recorded on the gate decision" || fail "permission mode not audited"
# a forbidden command is denied in every mode — Claude Code honours deny even
# under --dangerously-skip-permissions, so this is the tier that always holds
printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"rm -rf /"},"session_id":"sT","permission_mode":"bypassPermissions"}' | $AOS hook pre-tool \
  | grep -q '"permissionDecision":"deny"' && pass "modes: forbidden stays denied in bypassPermissions" || fail "deny weakened in bypass mode"

# review_capture: false opts out (last — it replaces the policy wholesale)
RUNU=$(sign_start "LIN-U" sU)
review_active signoff
(cd "$SIGN_REPO" && $AOS run finish >/dev/null)
printf 'version: 1\nreview_capture: false\n' > "$AOS_HOME/projects/signoff/policy.yaml"
STOP_OFF=$(printf '%s' '{"cwd":"'"$SIGN_REPO"'","session_id":"sU"}' | $AOS hook stop)
echo "$STOP_OFF" | grep -q "sitting at awaiting-review" && fail "review_capture false still nudged ($RUNU)" \
  || pass "stop: review_capture false disables the nudge"

# --- closing a run is gated whichever command gets there ---
# `run finish --state done` reaches the same terminal state as `run state done`.
# Gating only one of them let a run close with no prompt, no sign-off, and a
# record saying nobody closed it.
CLOSE_REPO="$WORK/close-repo"; mkdir -p "$CLOSE_REPO"
(cd "$CLOSE_REPO" && git init -q -b main && $AOS init --name closer >/dev/null)
(cd "$CLOSE_REPO" && $AOS run start --ticket "CL-1" >/dev/null)
CLOSE_RUN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/closer/state.json")
review_active closer
(cd "$CLOSE_REPO" && $AOS run state awaiting-review >/dev/null)
# the gate must see BOTH spellings of a close
for CMD in "aos run finish --state done" "aos run finish --state shipped" "aos run state done --run $CLOSE_RUN"; do
  printf '%s' '{"cwd":"'"$CLOSE_REPO"'","tool_name":"Bash","tool_input":{"command":"'"$CMD"'"},"session_id":"sC"}' | $AOS hook pre-tool \
    | grep -q 'reserved for the human' || fail "close not gated: $CMD"
done
pass "close: the gate sees run finish --state done|shipped as well as run state"
# plain `run finish` (to awaiting-review) is NOT a close and must stay ungated
printf '%s' '{"cwd":"'"$CLOSE_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run finish"},"session_id":"sC"}' | $AOS hook pre-tool \
  | grep -q 'reserved for the human' && fail "plain run finish demanded sign-off" || pass "close: plain run finish stays ungated"
# and the CLI refuses without one, then records who closed it when given one.
# The gate calls above minted a ticket — clear it, or this tests nothing.
rm -f "$AOS_HOME/projects/closer/signoff.json"
OUT_UNSIGNED=$( (cd "$CLOSE_REPO" && unset AOS_ALLOW_HEADLESS_APPROVE && $AOS run finish --state "done" </dev/null) 2>&1 || true )
echo "$OUT_UNSIGNED" | grep -q "needs a human sign-off" && pass "close: run finish --state done refuses without sign-off" || fail "unsigned finish-close accepted"
(cd "$CLOSE_REPO" && $AOS run finish --state "done" >/dev/null)   # AOS_ALLOW_HEADLESS_APPROVE is set suite-wide
grep -q '"closed_by"' "$AOS_HOME/projects/closer/runs/$CLOSE_RUN/meta.json" \
  && pass "close: run finish --state done records who closed it" || fail "closed_by missing after finish-close"
# the audit line must agree with what meta actually says about the review
(cd "$CLOSE_REPO" && $AOS run start --ticket "CL-2" >/dev/null)
CLOSE_RUN2=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/closer/state.json")
(cd "$CLOSE_REPO" && $AOS run finish --force >/dev/null)
(cd "$CLOSE_REPO" && $AOS run state "done" --run "$CLOSE_RUN2" >/dev/null)
# shellcheck disable=SC2016  # the node script's own $ must not expand here
node -e '
  const fs = require("fs"), path = require("path");
  const [runDir, projDir] = process.argv.slice(1);
  const m = require(path.join(runDir, "meta.json"));
  // finish clears activeRun, so the close line lands in the PROJECT log rather
  // than the run folder — check both.
  const lines = [path.join(runDir, "audit.jsonl"), path.join(projDir, "audit.jsonl")]
    .flatMap((f) => { try { return fs.readFileSync(f, "utf8").trim().split("\n"); } catch { return []; } })
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const close = lines.reverse().find((l) => l.event === "run-state" && l.state === "done" && l.run === m.run);
  if (!close) { console.error("no close audit line found for " + m.run); process.exit(1); }
  if (close.adversarial_review !== m.adversarial_review) {
    console.error(`audit says ${close.adversarial_review}, meta says ${m.adversarial_review}`);
    process.exit(1);
  }
' "$AOS_HOME/projects/closer/runs/$CLOSE_RUN2" "$AOS_HOME/projects/closer" \
  && pass "close: the audit line records what meta actually says (forced stays forced)" || fail "close audit contradicts meta"

# --- run provenance: branch, ticket link, PR link, files touched ---
# Reviewing a run means reading its diff. Without a branch and a PR the console
# can only describe the change, so the branch is read off .git/HEAD at start
# (no subprocess — the CLI shells out for contracts and nothing else).
PROV_REPO="$WORK/prov-repo"; mkdir -p "$PROV_REPO/src"
(cd "$PROV_REPO" && git init -q -b main && git checkout -q -b feat/limits && $AOS init --name prov >/dev/null)
(cd "$PROV_REPO" && $AOS run start --ticket "https://linear.app/acme/issue/LIN-482" --title "Harden upload" >/dev/null)
PROV_RUN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/prov/state.json")
PROV_DIR="$AOS_HOME/projects/prov/runs/$PROV_RUN"
prov_meta() { node -e 'const m=require(process.argv[1]);console.log(m[process.argv[2]])' "$PROV_DIR/meta.json" "$1"; }
[ "$(prov_meta branch)" = "feat/limits" ] && pass "provenance: branch read from .git/HEAD at run start" || fail "branch not captured ($(prov_meta branch))"
[ "$(prov_meta ticket)" = "LIN-482" ] && pass "provenance: a ticket URL still yields a readable run id" || fail "ticket id not derived"
case "$PROV_RUN" in *lin-482*) pass "provenance: run folder named from the ticket, not the URL";; *) fail "run id from URL: $PROV_RUN";; esac
[ "$(prov_meta ticket_url)" = "https://linear.app/acme/issue/LIN-482" ] && pass "provenance: the source ticket link is kept" || fail "ticket_url lost"
# a PR cannot be auto-detected (no network calls), so it is linked explicitly
(cd "$PROV_REPO" && $AOS run link --pr "https://github.com/acme/app/pull/91" >/dev/null)
[ "$(prov_meta pr_url)" = "https://github.com/acme/app/pull/91" ] && pass "provenance: PR link attached" || fail "pr_url not stored"
# a rejected link must leave NOTHING behind — validating inside the mutator
# persisted the fields that passed and then threw, with no audit line
(cd "$PROV_REPO" && $AOS run link --pr "ftp://x/y" --branch other-branch >/dev/null 2>&1) && fail "ftp URL accepted" || true
[ "$(prov_meta branch)" = "feat/limits" ] && pass "provenance: a rejected link applies nothing at all" || fail "partial link write ($(prov_meta branch))"
# a valueless flag must not report success while linking nothing
OUT_BARE=$( (cd "$PROV_REPO" && $AOS run link --pr) 2>&1 || true )
echo "$OUT_BARE" | grep -q "Nothing to link" && pass "provenance: --pr with no value is refused, not silently ignored" || fail "bare --pr reported success"
# a url that would become a click target in the console must never be stored
(cd "$PROV_REPO" && $AOS run link --pr "javascript:alert(1)" >/dev/null 2>&1) && fail "javascript: URL accepted" || pass "provenance: non-http(s) URLs refused"
[ "$(prov_meta pr_url)" = "https://github.com/acme/app/pull/91" ] && pass "provenance: a refused link leaves the old one intact" || fail "rejected url clobbered pr_url"
# files touched are reconstructed from the audit, repo-relative, excluding the
# run's own bookkeeping writes
printf '%s' '{"cwd":"'"$PROV_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-482"},"session_id":"sP"}' | $AOS hook post-tool
printf '%s' '{"cwd":"'"$PROV_REPO"'","tool_name":"Write","tool_input":{"file_path":"'"$PROV_REPO"'/src/upload.js"},"session_id":"sP"}' | $AOS hook post-tool
printf '%s' '{"cwd":"'"$PROV_REPO"'","tool_name":"Edit","tool_input":{"file_path":"'"$PROV_DIR"'/plan.md"},"session_id":"sP"}' | $AOS hook post-tool
printf '%s' '{"cwd":"'"$PROV_REPO"'","tool_name":"Bash","tool_input":{"command":"echo x > src/other.js"},"session_id":"sP"}' | $AOS hook post-tool
review_active prov
(cd "$PROV_REPO" && $AOS run finish >/dev/null)
node -e 'const m=require(process.argv[1]);process.exit(JSON.stringify(m.files)===JSON.stringify(["src/upload.js"])?0:1)' "$PROV_DIR/meta.json" \
  && pass "provenance: files touched are repo-relative and exclude run bookkeeping" || fail "files wrong: $(prov_meta files)"
[ "$(prov_meta bash_writes)" = "1" ] && pass "provenance: shell writes are counted, not guessed at" || fail "bash_writes wrong ($(prov_meta bash_writes))"
# a tracker URL with a stray percent is legal and must not take the command down
PCT_REPO="$WORK/pct-repo"; mkdir -p "$PCT_REPO"
(cd "$PCT_REPO" && git init -q -b main && $AOS init --name pct >/dev/null)
(cd "$PCT_REPO" && $AOS run start --ticket "https://jira.example.com/browse/AB-1?done=50%" >/dev/null 2>&1) \
  && pass "provenance: a malformed percent in a ticket URL does not crash run start" || fail "run start died on a percent"

# --- scope gate: the plan declares its files, drift asks ---
# Self-activating: a plan with no Files section gates nothing, so no existing
# project changes behaviour. Declaring the section is the opt-in.
SCOPE_REPO="$WORK/scope-repo"; mkdir -p "$SCOPE_REPO/src" "$SCOPE_REPO/docs"
(cd "$SCOPE_REPO" && git init -q -b main && $AOS init --name scoped >/dev/null)
(cd "$SCOPE_REPO" && $AOS run start --ticket "LIN-SC" >/dev/null)
SCOPE_RUN_DIR=$(active_run_dir scoped)
scope_write() {
  printf '%s' '{"cwd":"'"$SCOPE_REPO"'","tool_name":"Write","tool_input":{"file_path":"'"$SCOPE_REPO"'/'"$1"'","content":"x"},"session_id":"sV"}' | $AOS hook pre-tool
}
[ -z "$(scope_write src/anything.js)" ] && pass "scope: no plan.md → nothing gated" || fail "scope gated without a plan"
cat > "$SCOPE_RUN_DIR/plan.md" <<'PLAN'
# Plan
## Approach
Tighten the gate.
## Files
- `src/gate.js` — extend the check to Bash redirects
- src/policy.js
- docs/ (the tier table)
- test/**/*.sh
- Add tests: test/labelled.sh
- Do not touch config/production.yaml
- No changes to src/untouchable.js
- Add a helper for flag clusters
## Risks
None worth noting.
PLAN
[ -z "$(scope_write src/gate.js)" ] && pass "scope: declared file → allow" || fail "declared file gated"
[ -z "$(scope_write docs/tiers.md)" ] && pass "scope: file under a declared directory → allow" || fail "declared directory gated"
[ -z "$(scope_write test/deep/x.sh)" ] && pass "scope: glob match → allow" || fail "declared glob gated"
scope_write src/other.js | grep -q '"permissionDecision":"ask"' && pass "scope: undeclared file → ask" || fail "scope drift not gated"
scope_write src/other.js | grep -q "outside the scope plan.md declared" && pass "scope: reason names the plan and the declared list" || fail "scope reason unhelpful"
# a labelled path (`Add tests: test/x.sh`) is a real declaration, not prose
[ -z "$(scope_write test/labelled.sh)" ] && pass "scope: 'Label: path' lines still count as declared" || fail "labelled path dropped"
# ...but prose that FORBIDS a file must never be read as declaring it — a scope
# gate that grants what the plan excludes is worse than no scope gate at all
for CMD in config/production.yaml src/untouchable.js; do
  scope_write "$CMD" | grep -q '"permissionDecision":"ask"' || fail "negation prose granted scope: $CMD"
done
pass "scope: 'Do not touch X' does not declare X"
# the repo-relative path comes from the REPO root, not the session's cwd — a
# session started in a subdirectory used to invert the gate entirely
mkdir -p "$SCOPE_REPO/packages/web"
scope_sub() {
  printf '%s' '{"cwd":"'"$SCOPE_REPO"'/packages/web","tool_name":"Write","tool_input":{"file_path":"'"$SCOPE_REPO"'/'"$1"'","content":"x"},"session_id":"sV"}' | $AOS hook pre-tool
}
[ -z "$(scope_sub src/gate.js)" ] && pass "scope: declared file allowed from a subdirectory session" || fail "subdir session flagged a declared file"
scope_sub src/other.js | grep -q '"permissionDecision":"ask"' && pass "scope: drift still caught from a subdirectory session" || fail "subdir session missed scope drift"
# writes into the run folder and project memory stay open
printf '%s' '{"cwd":"'"$SCOPE_REPO"'","tool_name":"Write","tool_input":{"file_path":"'"$SCOPE_RUN_DIR"'/outcome.md","content":"x"},"session_id":"sV"}' | $AOS hook pre-tool \
  | grep -q 'plan-scope' && fail "run folder gated by scope" || pass "scope: the run's own files stay writable"
# and the gate is switchable
printf 'version: 1\nscope_gate: false\n' > "$AOS_HOME/projects/scoped/policy.yaml"
[ -z "$(scope_write src/other.js)" ] && pass "scope: scope_gate false disables it" || fail "scope_gate opt-out ignored"

# --- dry run: record what would gate, enforce nothing, and say so loudly ---
printf 'version: 1\ndry_run: true\n' > "$AOS_HOME/projects/scoped/policy.yaml"
DRY_PUSH='{"cwd":"'$SCOPE_REPO'","tool_name":"Bash","tool_input":{"command":"git push origin main"},"session_id":"sV"}'
[ -z "$(printf '%s' "$DRY_PUSH" | $AOS hook pre-tool)" ] && pass "dry-run: gate emits no decision (tool proceeds)" || fail "dry-run still enforced"
grep -rq '"dry_run":true' "$AOS_HOME/projects/scoped/" && pass "dry-run: the suppressed decision is audited" || fail "dry-run decision not recorded"
$AOS status | grep -q "DRY RUN — gates are recording, not enforcing" && pass "status: dry run is called out loudly" || fail "dry run not surfaced in status"
$AOS status | grep -q "ask:git-push" && pass "status: dry run breaks down what it suppressed" || fail "dry run breakdown missing"
(cd "$SCOPE_REPO" && $AOS doctor >/dev/null 2>&1) && fail "doctor passed while gates were off" || pass "doctor: dry run is a failure, not a note"
# doctor exits 1 here by design, so capture before grepping (pipefail)
DOCTOR_DRY=$( (cd "$SCOPE_REPO" && $AOS doctor 2>&1) || true )
echo "$DOCTOR_DRY" | grep -q "RECORDED, not enforced" && pass "doctor: says exactly what dry run means" || fail "doctor dry-run message unclear"
# dry run must not make closing a run the one thing it makes HARDER: the gate
# never prompts, so no ticket can exist, and requiring one would deadlock.
(cd "$SCOPE_REPO" && $AOS run start --ticket "LIN-DR" >/dev/null)
DR_RUN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/scoped/state.json")
review_active scoped
(cd "$SCOPE_REPO" && $AOS run finish >/dev/null)
(cd "$SCOPE_REPO" && unset AOS_ALLOW_HEADLESS_APPROVE && $AOS run state "done" --run "$DR_RUN" </dev/null >/dev/null) \
  && pass "dry-run: a run can still be closed" || fail "dry run deadlocked the close"
grep -q '"via": "dry-run"' "$AOS_HOME/projects/scoped/runs/$DR_RUN/meta.json" \
  && pass "dry-run: the close records that no human was actually asked" || fail "dry-run close route not recorded"

# --- cost: attribution, groupings, and the price tag on the run ---
$AOS cost --all | grep -q "Estimated cost at API list prices" && pass "cost: reports at list prices" || fail "cost command broken"
$AOS cost --all | grep -q "Session spend" && pass "cost: separates session spend from run spend" || fail "cost conflates session and run spend"
for BY in run model contract; do
  $AOS cost --all --by "$BY" >/dev/null || fail "cost --by $BY failed"
done
pass "cost: run / model / contract groupings all render"
$AOS cost --all --since 7d | grep -q "since 7d" && pass "cost: --since windows the report" || fail "--since ignored"
$AOS cost --since nonsense >/dev/null 2>&1 && fail "unreadable --since accepted" || pass "cost: unreadable --since refused"
$AOS cost --by wat >/dev/null 2>&1 && fail "unknown --by accepted" || pass "cost: unknown --by refused"
# the price tag is stamped after tokens settle, not at finish (they aren't final yet)
COST_REPO="$WORK/cost-repo"; mkdir -p "$COST_REPO"; (cd "$COST_REPO" && git init -q -b main)
(cd "$COST_REPO" && $AOS init --name costed >/dev/null && $AOS run start --ticket "LIN-C" >/dev/null)
COST_RUN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/costed/state.json")
COST_DIR="$AOS_HOME/projects/costed/runs/$COST_RUN"
echo "# Outcome" > "$COST_DIR/outcome.md"
printf '%s' '{"cwd":"'"$COST_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-C"},"session_id":"sW"}' | $AOS hook post-tool
review_active costed
(cd "$COST_REPO" && $AOS run finish >/dev/null)
printf '%s' '{"cwd":"'"$COST_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run finish"},"session_id":"sW","transcript_path":"'"$TRANSM"'"}' | $AOS hook post-tool
grep -q '## Cost' "$COST_DIR/outcome.md" && pass "cost: outcome.md carries the run's price tag" || fail "outcome.md not stamped"
grep -q 'aos:cost' "$COST_DIR/outcome.md" && pass "cost: the stamp is marked so it can be replaced, not duplicated" || fail "cost stamp unmarked"
STAMPS_BEFORE=$(grep -c 'aos:cost' "$COST_DIR/outcome.md")
printf '%s' '{"cwd":"'"$COST_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run finish"},"session_id":"sW","transcript_path":"'"$TRANSM"'"}' | $AOS hook post-tool
[ "$(grep -c 'aos:cost' "$COST_DIR/outcome.md")" = "$STAMPS_BEFORE" ] && pass "cost: re-stamping replaces, never duplicates" || fail "cost stamp duplicated"
grep -q "# Outcome" "$COST_DIR/outcome.md" && pass "cost: the agent's own outcome.md content survives stamping" || fail "cost stamp clobbered outcome.md"
# content appended BELOW the stamp (reviewer notes on a reopened run) must
# survive a re-stamp too — replacing marker-to-EOF silently deleted it
printf '\n## Reviewer notes\n\nLooks good to me.\n' >> "$COST_DIR/outcome.md"
printf '%s' '{"cwd":"'"$COST_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run finish"},"session_id":"sW","transcript_path":"'"$TRANSM"'"}' | $AOS hook post-tool
grep -q "## Reviewer notes" "$COST_DIR/outcome.md" && pass "cost: re-stamping preserves content below the stamp" || fail "re-stamp deleted content below it"
[ "$(grep -c 'aos:cost' "$COST_DIR/outcome.md")" = "2" ] && pass "cost: exactly one delimited stamp remains" || fail "stamp markers duplicated"
# a malformed marker pair (END before START) must not append forever
printf '<!-- /aos:cost -->\n\n# Outcome\n' > "$COST_DIR/outcome.md"
for _ in 1 2 3; do
  printf '%s' '{"cwd":"'"$COST_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run finish"},"session_id":"sW","transcript_path":"'"$TRANSM"'"}' | $AOS hook post-tool
done
[ "$(grep -c 'aos:cost' "$COST_DIR/outcome.md")" = "2" ] \
  && pass "cost: malformed markers converge on one stamp, not an endless append" || fail "malformed markers appended repeatedly"


# --- init --hooks-only: the layer that works without invoking anything ---
HO_REPO="$WORK/hooks-only-repo"; mkdir -p "$HO_REPO"; (cd "$HO_REPO" && git init -q -b main)
(cd "$HO_REPO" && $AOS init --name hooksonly --hooks-only >/dev/null)
[ -d "$HO_REPO/.claude/skills" ] && fail "--hooks-only installed skills" || pass "init --hooks-only: no skills installed"
grep -q "hook pre-tool" "$HO_REPO/.claude/settings.json" && pass "init --hooks-only: hooks still wired" || fail "--hooks-only skipped hooks"
[ -f "$AOS_HOME/projects/hooksonly/policy.yaml" ] && pass "init --hooks-only: policy scaffolded (it IS the gate)" || fail "--hooks-only skipped policy"
[ -f "$AOS_HOME/projects/hooksonly/context/pack.md" ] && pass "init --hooks-only: context pack scaffolded (it IS the memory)" || fail "--hooks-only skipped pack"
(cd "$HO_REPO" && $AOS init --name hooksonly >/dev/null)
[ -d "$HO_REPO/.claude/skills" ] && pass "init: a later full init adds the pipeline skills" || fail "upgrade from hooks-only failed"

# --- CLI robustness: a value-less flag must not reach path.join as `true` ---
for SUB in "run session" "run review" "run state done"; do
  # shellcheck disable=SC2086  # SUB is a deliberate two-word subcommand
  OUT_BAREFLAG=$( (cd "$REPO" && $AOS $SUB --run </dev/null) 2>&1 || true )
  echo "$OUT_BAREFLAG" | grep -q "must be of type string" && fail "aos $SUB --run crashed on a bare flag"
done
pass "cli: --run with no value degrades instead of throwing a type error"
$AOS doctor >/dev/null 2>&1 || true   # doctor must never throw either
pass "cli: doctor survives a fully-populated home"

# --- context: template nudge, learnings overflow, budgeted pack ---
CTX_REPO="$WORK/ctx-repo"; mkdir -p "$CTX_REPO"
( cd "$CTX_REPO" && git init -q -b main && $AOS init --name ctxdemo >/dev/null )
CTXP="$AOS_HOME/projects/ctxdemo"
[ -f "$CTX_REPO/.claude/skills/aos-onboard/SKILL.md" ] && pass "init: aos-onboard skill installed" || fail "onboard skill missing"
( cd "$CTX_REPO" && $AOS context ) | grep -q "aos-onboard" && pass "context: template pack → onboard nudge" || fail "onboard nudge missing"
printf '# Context pack\n\nA real description of the project.\n' > "$CTXP/context/pack.md"
( cd "$CTX_REPO" && $AOS context ) | grep -q "aos-onboard" && fail "filled pack still nudges onboard" || pass "context: filled pack → no onboard nudge"
for i in $(seq 1 40); do echo "- learning $i" >> "$CTXP/learnings.md"; done
( cd "$CTX_REPO" && $AOS context ) | grep -q "auto-load" && pass "context: learnings overflow warned" || fail "overflow not warned"
node -e 'console.log("# Context pack\n\n" + "x".repeat(12000))' > "$CTXP/context/pack.md"
CTXBIG=$( cd "$CTX_REPO" && $AOS context )
echo "$CTXBIG" | grep -q "## Learnings" && pass "context: huge pack can't amputate learnings" || fail "learnings amputated by big pack"
echo "$CTXBIG" | grep -q "read context/pack.md" && pass "context: oversized pack truncated with pointer" || fail "pack not truncated"

# --- init: non-JS ecosystems seed required test contracts ---
GO_REPO="$WORK/go-repo"; mkdir -p "$GO_REPO"; printf 'module example.com/x\n' > "$GO_REPO/go.mod"
( cd "$GO_REPO" && git init -q -b main && $AOS init --name gox >/dev/null )
grep -q "command: go test" "$AOS_HOME/projects/gox/policy.yaml" && pass "init: go repo seeds go test contract" || fail "go contract missing"
PY_REPO="$WORK/py-repo"; mkdir -p "$PY_REPO"; printf '[project]\nname = "pyx"\n' > "$PY_REPO/pyproject.toml"
( cd "$PY_REPO" && git init -q -b main && $AOS init --name pyx >/dev/null )
grep -q "command: pytest" "$AOS_HOME/projects/pyx/policy.yaml" && pass "init: python repo seeds pytest contract" || fail "pytest contract missing"
MK_REPO="$WORK/mk-repo"; mkdir -p "$MK_REPO"; printf 'test:\n\ttrue\n' > "$MK_REPO/Makefile"
( cd "$MK_REPO" && git init -q -b main && $AOS init --name mkx >/dev/null )
grep -q "command: make test" "$AOS_HOME/projects/mkx/policy.yaml" && pass "init: Makefile test target seeds contract" || fail "make contract missing"

# --- init: repo-aware context pack + seeded verification contracts ---
DETECT_REPO="$WORK/detect-repo"
mkdir -p "$DETECT_REPO/src"
cat > "$DETECT_REPO/package.json" <<'EOF'
{
  "name": "detectme",
  "description": "A sample project for detection.",
  "engines": { "node": ">=22" },
  "scripts": { "test": "node --test", "lint": "eslint .", "typecheck": "tsc --noEmit" },
  "devDependencies": { "react": "^18.0.0" }
}
EOF
touch "$DETECT_REPO/tsconfig.json"
( cd "$DETECT_REPO" && git init -q -b main && $AOS init --name detectme >/dev/null )
DPACK="$AOS_HOME/projects/detectme/context/pack.md"
DPOL="$AOS_HOME/projects/detectme/policy.yaml"
grep -q "A sample project for detection" "$DPACK" && pass "init: pack drafted from package.json" || fail "pack not drafted from repo"
grep -q "TypeScript" "$DPACK" && pass "init: pack detects language" || fail "language not detected in pack"
grep -q "React" "$DPACK" && pass "init: pack detects framework" || fail "framework not detected in pack"
grep -q "name: tests" "$DPOL" && pass "init: seeds required test contract" || fail "test contract not seeded"
grep -q "adversarial_review" "$DPOL" && pass "init: policy keeps template after contract injection" || fail "policy structure lost on injection"
grep -q "Deterministic checks" "$DPOL" && pass "init: contracts guidance comment survives injection" || fail "contracts comment dropped on injection"
# bun: `bun test` bypasses scripts.test (native runner) — seeded command must be `bun run test`,
# and the modern text lockfile (bun.lock) must be detected, not just legacy bun.lockb
BUN_REPO="$WORK/bun-repo"; mkdir -p "$BUN_REPO"
printf '{ "name": "bunny", "description": "Bun app.", "scripts": { "test": "vitest run" } }' > "$BUN_REPO/package.json"
touch "$BUN_REPO/bun.lock"
( cd "$BUN_REPO" && git init -q -b main && $AOS init --name bunny >/dev/null )
grep -q "command: bun run test" "$AOS_HOME/projects/bunny/policy.yaml" && pass "init: bun repo seeds 'bun run test' (not native runner)" || fail "bun test command wrong"
# a repo with no signal falls back to the blank template
BARE_REPO="$WORK/bare-repo"; mkdir -p "$BARE_REPO"
BARE_OUT=$( cd "$BARE_REPO" && git init -q -b main && $AOS init --name bare )
grep -q "one paragraph: purpose" "$AOS_HOME/projects/bare/context/pack.md" && pass "init: no signal → blank template" || fail "blank fallback missing"
echo "$BARE_OUT" | grep -q "Verification is EMPTY" && pass "init: warns loudly when verification is empty" || fail "empty verification not warned"

# --- supply-chain guard: the compiled CLI accesses the network in no way at all ---
# All outbound access lives in install.sh (registry resolve + sha-512 verify); the CLI
# self-updates by running that local, already-verified installer. So the bundle must
# neither shell out to curl nor call fetch/reach the registry directly.
# "curl" as a *policy vocabulary token* (the write-intent heuristic knows curl -o
# writes files) is fine — what must never appear is an exec/spawn that invokes it.
grep -Eq '(exec|spawn)\w*\([^)]{0,80}curl' "$ROOT/dist/aos.mjs" && fail "compiled bundle shells out to curl (possible curl|bash supply-chain risk)" || pass "no curl execution in compiled bundle — no remote-script execution"
grep -Eq 'fetch\(|registry\.npmjs\.org' "$ROOT/dist/aos.mjs" && fail "compiled bundle accesses the network (fetch/registry) — should delegate to install.sh" || pass "no network access in compiled bundle — installer owns all outbound I/O"

# --- entry point: declared + importing the bundle is side-effect-free (no EntryPointError) ---
node -e 'const p=require(process.argv[1]);process.exit(p.main&&p.exports?0:1)' "$ROOT/package.json" \
  && pass "entry point: package.json declares main + exports" || fail "package.json has no main/exports entry point"
IMPORT_HOME="$WORK/import-probe-home"
AOS_HOME="$IMPORT_HOME" node --input-type=module \
  -e "import('file://$ROOT/dist/aos.mjs').then(m => process.exit(typeof m.main === 'function' ? 0 : 1))" \
  || fail "compiled bundle does not export main()"
[ -d "$IMPORT_HOME" ] && fail "importing the bundle created AOS_HOME (side effect on import)" \
  || pass "entry point: bundle exports main, import is side-effect-free"

# --- doctor ---
$AOS doctor >/dev/null 2>&1 && pass "doctor: clean install → exit 0" || fail "doctor exit code"
$AOS doctor 2>/dev/null | grep -q "All clear" && pass "doctor: reports all clear" || fail "doctor output"
$AOS doctor 2>/dev/null | grep -q "hook command resolves" && pass "doctor: verifies the hook command actually resolves" || fail "hook resolution not checked"

# --- fail-open: a broken hook must never break the session, but must leave a trace ---
# Every hook swallows its own errors and exits 0 (a broken gate allows rather
# than blocks). That is deliberate — and it is exactly why the trace matters:
# without it, a crashing gate is indistinguishable from a quiet one.
BROKEN_OUT=$(printf 'not json' | $AOS hook pre-tool 2>&1)
[ -z "$BROKEN_OUT" ] && pass "fail-open: crashing hook emits no decision (Claude Code proceeds)" || fail "broken hook wrote output"
printf 'not json' | $AOS hook pre-tool >/dev/null 2>&1 && pass "fail-open: crashing hook still exits 0" || fail "broken hook exited non-zero"
for H in post-tool session-start session-end stop; do
  printf 'not json' | $AOS hook "$H" >/dev/null 2>&1 || fail "hook $H exited non-zero on malformed input"
done
pass "fail-open: every hook entry point survives malformed input"
grep -q '"hook":"pre-tool"' "$AOS_HOME/hook-errors.log" && pass "fail-open: the swallowed failure is logged" || fail "hook failure not logged"
# (captured, not piped: doctor exits 1 here and the suite runs under pipefail)
DOC_ERRS=$($AOS doctor 2>/dev/null || true)
echo "$DOC_ERRS" | grep -q "hook failure(s) logged" && pass "doctor: surfaces silently-failed hooks" || fail "doctor missed hook-errors.log"
$AOS doctor >/dev/null 2>&1 && fail "doctor exited 0 with logged hook failures" || pass "doctor: logged hook failures → exit 1"
rm -f "$AOS_HOME/hook-errors.log"

# --- silently-absent gate: the hook command no longer resolves ---
# The launcher ends in `|| true` so a moved or uninstalled aos can never break a
# session — which is precisely what makes it dangerous: every gate turns off and
# nothing looks wrong. Both halves are tested: the shell contract holds, and
# doctor detects the condition.
# shellcheck disable=SC2016  # $HOME must stay literal — the shell in the hook expands it
GONE_CMD='"$HOME/nonexistent-aos-launcher/aos" hook pre-tool 2>/dev/null || aos hook pre-tool 2>/dev/null || true'
GONE_OUT=$(env PATH=/nonexistent-bin /bin/bash -c "$GONE_CMD" </dev/null 2>&1)
[ -z "$GONE_OUT" ] && pass "missing binary: hook chain stays silent" || fail "missing-aos hook emitted output"
env PATH=/nonexistent-bin /bin/bash -c "$GONE_CMD" </dev/null >/dev/null 2>&1 \
  && pass "missing binary: hook chain exits 0 (session unbroken, gates OFF)" || fail "missing-aos hook broke the session"
# doctor is the only thing standing between that and an invisible loss of gating
GONE_REPO="$WORK/gone-repo"; mkdir -p "$GONE_REPO"
( cd "$GONE_REPO" && git init -q -b main && $AOS init --name goneproj >/dev/null )
# shellcheck disable=SC2016  # the $HOME inside the rewritten hook command is literal
node -e '
  const fs = require("fs"); const p = process.argv[1];
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const ev of Object.keys(s.hooks)) {
    for (const entry of s.hooks[ev]) {
      for (const h of entry.hooks || []) {
        h.command = h.command.replace(/^"[^"]+"/, "\"$HOME/nonexistent-aos-launcher/aos\"");
      }
    }
  }
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
' "$GONE_REPO/.claude/settings.json"
# a PATH with node but deliberately no aos — the `|| aos` fallback must not resolve either
NODE_ONLY="$WORK/node-only-bin"; mkdir -p "$NODE_ONLY"
ln -sf "$(command -v node)" "$NODE_ONLY/node"
GONE_DOC=$( cd "$GONE_REPO" && PATH="$NODE_ONLY" $AOS doctor 2>&1 || true )
echo "$GONE_DOC" | grep -q "SILENTLY OFF" && pass "doctor: detects wired-but-unresolvable hooks" || fail "unresolvable hook command not detected"
( cd "$GONE_REPO" && PATH="$NODE_ONLY" $AOS doctor >/dev/null 2>&1 ) && fail "doctor exited 0 with dead hook commands" || pass "doctor: dead hook command → exit 1"

# --- console: the review vocabulary must not drift from the gate ---
# The console counted `adversarial_review === 'present'`, a pre-0.11 value.
# When the gate started emitting clean/resolved/open/invalid/forced instead,
# every run finished under the new schema silently vanished from the coverage
# stat — including `forced`, the one an operator most needs to see. Nothing
# failed, the number just quietly stopped being true. So: every state the gate
# can stamp must be named somewhere in the console.
# shellcheck disable=SC2016  # the $ inside the node script must not expand here
node -e '
  const fs = require("fs");
  const ui = fs.readFileSync(process.argv[1], "utf8");
  const states = ["clean", "resolved", "open", "invalid", "absent", "forced", "not-required", "present"];
  const missing = states.filter((st) => !ui.includes(`"${st}"`) && !ui.includes(`\x27${st}\x27`));
  if (missing.length) {
    console.error("console does not handle review state(s): " + missing.join(", "));
    process.exit(1);
  }
' "$ROOT/src/console/ui.html" \
  && pass "console: handles every review state the gate can stamp" || fail "console review vocabulary drifted from review.js"

# --- console API + security ---
# extra run docs (findings.md, reviews/*.md) must be served alongside the canonical four
printf '# Findings\n\nRoot cause: flux capacitor.\n' > "$RUN_DIR/findings.md"
mkdir -p "$RUN_DIR/reviews"
printf '# Arch review\n\nLooks sound.\n' > "$RUN_DIR/reviews/arch.md"
# a review with a real finding, so the served payload is the parsed shape and
# not just an empty envelope
printf '%s' '{"reviewer":"skeptic subagent","scope":["src/demo.js"],"findings":[{"severity":"high","summary":"the gate never fires on the shell path","location":"src/demo.js:12","status":"fixed","resolution":"extended the check to redirects and tee"}]}' > "$RUN_DIR/review.json"
# a symlink planted in the run folder must NOT be served (file disclosure guard)
ln -s /etc/hosts "$RUN_DIR/leak.md"
# neither must a hardlink (same filesystem — link to AOS state)
ln "$AOS_HOME/registry.yaml" "$RUN_DIR/hardleak.md" 2>/dev/null || true
PORT=45997
$AOS console --port $PORT >/dev/null 2>&1 &
CONSOLE_PID=$!
sleep 1
# No `curl | grep -q` here: with pipefail, grep -q exiting on first match can
# EPIPE curl mid-write and fail the pipeline despite a successful match (racy,
# surfaced on Linux CI). Capture responses, then pattern-match without pipes.
STATE=$(curl -s "http://127.0.0.1:$PORT/api/state")
case "$STATE" in *'"id":"demo"'*) pass "console API: state";; *) kill $CONSOLE_PID; fail "console state";; esac
RUN_ID=$(basename "$RUN_DIR")
DETAIL=$(curl -s "http://127.0.0.1:$PORT/api/run?project=demo&run=$RUN_ID")
case "$DETAIL" in *'"audit"'*) pass "console API: run detail";; *) kill $CONSOLE_PID; fail "console run detail";; esac
case "$DETAIL" in *'"findings.md"'*) pass "console API: extra run docs enumerated" ;; *) kill $CONSOLE_PID; fail "findings.md not served";; esac
case "$DETAIL" in *'flux capacitor'*) pass "console API: extra doc content served" ;; *) kill $CONSOLE_PID; fail "doc content missing";; esac
case "$DETAIL" in *'"reviews/arch.md"'*) pass "console API: reviews/ docs enumerated" ;; *) kill $CONSOLE_PID; fail "reviews doc not served";; esac
case "$DETAIL" in *'"leak.md"'*) kill $CONSOLE_PID; fail "symlinked doc was served (file disclosure)" ;; *) pass "console security: symlinked docs skipped";; esac
case "$DETAIL" in *'"hardleak.md"'*) kill $CONSOLE_PID; fail "hardlinked doc was served (file disclosure)" ;; *) pass "console security: hardlinked docs skipped";; esac
case "$DETAIL" in *'"dir_display"'*) pass "console API: home-relative display path present" ;; *) kill $CONSOLE_PID; fail "dir_display missing";; esac
# The adversarial review is the one quality claim the finish gate enforces, so
# the console must be able to show it — extraDocs only enumerates markdown, and
# review.json lived entirely outside the console until it was sent explicitly.
case "$DETAIL" in *'"review"'*) pass "console API: the run's adversarial review is served" ;; *) kill $CONSOLE_PID; fail "review not served";; esac
case "$DETAIL" in *'skeptic subagent'*) kill $CONSOLE_PID; fail "raw reviewer string leaked instead of parsed state";; *) : ;; esac
case "$DETAIL" in *'never fires on the shell path'*) pass "console API: review findings included" ;; *) kill $CONSOLE_PID; fail "review findings missing";; esac
# leverage_sample is what lets the console tell "no finished runs" apart from
# "too few to rate" — collapsing them made it report "no data" for projects
# that had finished runs.
case "$STATE" in *'"leverage_sample"'*) pass "console API: leverage sample exposed" ;; *) kill $CONSOLE_PID; fail "leverage_sample missing";; esac
PROJ=$(curl -s "http://127.0.0.1:$PORT/api/project?project=demo")
case "$PROJ" in *'"policy"'*) pass "console API: project detail";; *) kill $CONSOLE_PID; fail "console project detail";; esac
case "$PROJ" in *'"adversarial_review_mode"'*) pass "console API: review mode is the tri-state, not a boolean" ;; *) kill $CONSOLE_PID; fail "adversarial_review_mode missing";; esac
case "$PROJ" in *'"scope_gate"'*) pass "console API: the 0.11 guards are in the policy digest" ;; *) kill $CONSOLE_PID; fail "scope_gate missing from policy digest";; esac
case "$PROJ" in *'"protect_worktree"'*) : ;; *) kill $CONSOLE_PID; fail "protect_worktree missing from policy digest";; esac
# the runs table must be reachable without a mouse — an onclick <tr> is not
UI_HTML=$(curl -s "http://127.0.0.1:$PORT/")
case "$UI_HTML" in *'role="link"'*) pass "console UI: run rows expose a link role" ;; *) kill $CONSOLE_PID; fail "run rows have no role";; esac
case "$UI_HTML" in *"event.key==='Enter'"*) pass "console UI: run rows are keyboard-activated" ;; *) kill $CONSOLE_PID; fail "run rows are mouse-only";; esac
# Column order: the review cell must sit under the Review header. Inserting it
# one <td> too early shifted every value right and put review states under
# "Verify" — invisible to any assertion that only checks presence.
node -e '
  const ui = require("fs").readFileSync(process.argv[1], "utf8");
  // Scope to the row template — searching the whole file matches the
  // reviewCell() function declaration further down and always "passes".
  const row = /class="rowlink[\s\S]*?<\/tr>/.exec(ui);
  const head = /<th>Verify<\/th>\s*<th[^>]*>Review<\/th>/.test(ui);
  if (!row) { console.error("runs-table row template not found"); process.exit(1); }
  const v = row[0].indexOf("VERIFY_TIP"), r = row[0].indexOf("reviewCell(");
  if (v < 0 || r < 0) { console.error("verify/review cells not found in the row"); process.exit(1); }
  if (!head) { console.error("Review header does not follow Verify"); process.exit(1); }
  if (r < v) { console.error("review cell renders before the verify cell — every value shifts a column"); process.exit(1); }
' "$ROOT/src/console/ui.html" \
  && pass "console UI: the review column sits under its own header" || { kill $CONSOLE_PID; fail "review cell/header order mismatch"; }
PMISS=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/project?project=nope")
[ "$PMISS" = "404" ] && pass "console API: unknown project → 404" || { kill $CONSOLE_PID; fail "unknown project ($PMISS)"; }
UI=$(curl -s "http://127.0.0.1:$PORT/")
case "$UI" in *"AOS Console"*) pass "console serves UI";; *) kill $CONSOLE_PID; fail "console UI";; esac

# path traversal in ids must be rejected
TRAV=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/run?project=..%2F..%2Fetc&run=passwd")
[ "$TRAV" = "400" ] && pass "console security: traversal id → 400" || { kill $CONSOLE_PID; fail "traversal not rejected ($TRAV)"; }
# DNS-rebinding protection: non-local Host header must be refused
REBIND=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: evil.example.com" "http://127.0.0.1:$PORT/api/state")
[ "$REBIND" = "403" ] && pass "console security: foreign Host → 403" || { kill $CONSOLE_PID; fail "rebinding not blocked ($REBIND)"; }
kill $CONSOLE_PID 2>/dev/null

# --- corrupt registry: reads degrade, writes refuse to clobber ---
echo '{{{ not yaml' > "$AOS_HOME/registry.yaml"
$AOS status >/dev/null 2>&1 && pass "corrupt registry: status still works" || fail "status crashed on corrupt registry"
if $AOS init --name demo >/dev/null 2>&1; then
  fail "init overwrote a corrupt registry"
else
  grep -q "not yaml" "$AOS_HOME/registry.yaml" && pass "corrupt registry: init refuses to clobber" || fail "registry was clobbered"
fi

echo ""
echo "All smoke tests passed."
rm -rf "$WORK"
