# shellcheck shell=bash
# The plan gate and session binding.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

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

