# shellcheck shell=bash
# Learnings capture: the finish reminder, Stop-hook extraction, SessionEnd debt.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

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

