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

# --- file-write gates: self-protection + script laundering ---
IN_SETTINGS='{"cwd":"'$REPO'","tool_name":"Write","tool_input":{"file_path":"'$REPO'/.claude/settings.json","content":"{}"},"session_id":"s1"}'
IN_POLICY='{"cwd":"'$REPO'","tool_name":"Edit","tool_input":{"file_path":"'$AOS_HOME'/projects/demo/policy.yaml","new_string":"tiers: {}"},"session_id":"s1"}'
IN_LAUNDER='{"cwd":"'$REPO'","tool_name":"Write","tool_input":{"file_path":"'$REPO'/run.sh","content":"#!/bin/bash\ngit push --force origin main"},"session_id":"s1"}'
IN_OKWRITE='{"cwd":"'$REPO'","tool_name":"Write","tool_input":{"file_path":"'$REPO'/src/ok.js","content":"export {}"},"session_id":"s1"}'
hook_out "$IN_SETTINGS" | grep -q '"permissionDecision":"ask"'  && pass "gate: write .claude/settings.json → ask" || fail "settings write not gated"
hook_out "$IN_POLICY"   | grep -q '"permissionDecision":"ask"'  && pass "gate: write policy.yaml → ask (self-protection)" || fail "policy write not gated"
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
$AOS run finish >/dev/null

# --- adversarial review: evidence-of-process recorded at finish ---
$AOS run start --ticket "LIN-3" >/dev/null
RUN3=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/demo/state.json")
RUN3_DIR="$AOS_HOME/projects/demo/runs/$RUN3"
FINISH_OUT=$($AOS run finish)
echo "$FINISH_OUT" | grep -q "No adversarial review" && pass "finish: warns when adversarial review absent" || fail "no absent warning"
grep -q '"adversarial_review": "absent"' "$RUN3_DIR/meta.json" && pass "finish: records adversarial_review=absent" || fail "absent not recorded"
$AOS run start --ticket "LIN-4" >/dev/null
RUN4=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/demo/state.json")
RUN4_DIR="$AOS_HOME/projects/demo/runs/$RUN4"
printf '## Adversarial review\n\nSkeptic hunted the acceptance criteria and edge cases; found nothing unmet.\n' > "$RUN4_DIR/verification.md"
$AOS run finish >/dev/null
grep -q '"adversarial_review": "present"' "$RUN4_DIR/meta.json" && pass "finish: records adversarial_review=present" || fail "present not recorded"

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
$AOS run finish >/dev/null
grep -q '"learnings_recorded": "absent"' "$RUN6_DIR/meta.json" && pass "finish: reads of learnings.md don't count as capture" || fail "read counted as memory write"
# a learnings append (via shell redirect) clears the whole path: reminder, stop, and debt
$AOS run start --ticket "LIN-7" >/dev/null
RUN7=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/demo/state.json")
RUN7_DIR="$AOS_HOME/projects/demo/runs/$RUN7"
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-7"},"session_id":"sG"}' | $AOS hook post-tool
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"echo learned >> '"$AOS_HOME"'/projects/demo/learnings.md"},"session_id":"sG"}' | $AOS hook post-tool
$AOS run finish >/dev/null
grep -q '"learnings_recorded": "present"' "$RUN7_DIR/meta.json" && pass "finish: records learnings_recorded=present" || fail "learnings present not recorded"
STOP4=$(printf '%s' '{"cwd":"'"$REPO"'","session_id":"sG"}' | $AOS hook stop)
[ -z "$STOP4" ] && pass "stop: learnings written → no block" || fail "stop blocked despite learnings"
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
OUT_NOTTY=$( (env -u AOS_ALLOW_HEADLESS_APPROVE $AOS run state done </dev/null) 2>&1 || true )
echo "$OUT_NOTTY" | grep -q "interactive terminal" && pass "state done: refused without a TTY" || fail "headless close not refused"
# plan approval stays prompt-based: works headless, identity recorded best-effort
$AOS run approve </dev/null >/dev/null
grep -q '"via": "headless-env"' "$RUN8_DIR/meta.json" && pass "approve: sign-off identity recorded in meta" || fail "approved_by not recorded"
$AOS run state shipped --force >/dev/null
grep -q '"state": "shipped"' "$RUN8_DIR/meta.json" && pass "state: --force overrides (escape hatch)" || fail "force override failed"
grep -q '"forced":true' "$RUN8_DIR/audit.jsonl" && pass "state: forced transition audited" || fail "forced transition not audited"
$AOS run state in-progress --force >/dev/null
$AOS run finish >/dev/null

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

# --- console API + security ---
# extra run docs (findings.md, reviews/*.md) must be served alongside the canonical four
printf '# Findings\n\nRoot cause: flux capacitor.\n' > "$RUN_DIR/findings.md"
mkdir -p "$RUN_DIR/reviews"
printf '# Arch review\n\nLooks sound.\n' > "$RUN_DIR/reviews/arch.md"
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
PROJ=$(curl -s "http://127.0.0.1:$PORT/api/project?project=demo")
case "$PROJ" in *'"policy"'*) pass "console API: project detail";; *) kill $CONSOLE_PID; fail "console project detail";; esac
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
