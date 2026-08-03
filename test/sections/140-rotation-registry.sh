# shellcheck shell=bash
# Bounded log growth and degradation on a corrupt registry.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

# --- bounded growth: sessions.jsonl and audit.jsonl rotate at 10MB ---
# Both ledgers were append-only-and-forever while every reader slurps the file
# whole. The rotated generation (sessions.jsonl.1 / audit.1.jsonl) must still
# count toward totals, or a rotation silently resets the project's numbers.
ROT_REPO="$WORK/rot-repo"; mkdir -p "$ROT_REPO"; (cd "$ROT_REPO" && git init -q -b main)
(cd "$ROT_REPO" && $AOS init --name rot >/dev/null)
ROT_PROJ="$AOS_HOME/projects/rot"
ROT_TRANS="$WORK/rot-transcript.jsonl"
echo '{"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":70,"cache_read_input_tokens":400,"output_tokens":30}}}' > "$ROT_TRANS"
# sA's ending is in the file BEFORE it crosses the threshold; sB's lands after
printf '%s' '{"cwd":"'"$ROT_REPO"'","session_id":"sA","transcript_path":"'"$ROT_TRANS"'"}' | $AOS hook session-end
node -e 'require("fs").appendFileSync(process.argv[1], "x".repeat(10500000) + "\n")' "$ROT_PROJ/sessions.jsonl"
printf '%s' '{"cwd":"'"$ROT_REPO"'","session_id":"sB","transcript_path":"'"$ROT_TRANS"'"}' | $AOS hook session-end
[ -f "$ROT_PROJ/sessions.jsonl.1" ] && pass "rotation: sessions.jsonl rolls to .1 past the threshold" || fail "sessions.jsonl did not rotate"
[ "$(grep -c . "$ROT_PROJ/sessions.jsonl")" = "1" ] && pass "rotation: the fresh sessions.jsonl holds only new lines" || fail "rotation did not start a fresh file"
$AOS status | grep -A4 '(rot)' | grep -q "140 in / 60 out" \
  && pass "rotation: status totals span the boundary (old generation still counts)" || fail "rotation reset session totals"
(cd "$ROT_REPO" && $AOS cost) | grep -q "140" \
  && pass "rotation: cost totals span the boundary too" || fail "rotation reset cost totals"

# per-run audit.jsonl: same bound, and the display readers must not care
(cd "$ROT_REPO" && $AOS run start --ticket "LIN-ROT" >/dev/null)
ROT_RUN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$ROT_PROJ/state.json")
ROT_RUN_DIR="$ROT_PROJ/runs/$ROT_RUN"
node -e 'require("fs").appendFileSync(process.argv[1], "x".repeat(10500000) + "\n")' "$ROT_RUN_DIR/audit.jsonl"
printf '%s' '{"cwd":"'"$ROT_REPO"'","tool_name":"Write","tool_input":{"file_path":"src/b.js"},"session_id":"sA"}' | $AOS hook post-tool
[ -f "$ROT_RUN_DIR/audit.1.jsonl" ] && pass "rotation: audit.jsonl rolls to audit.1.jsonl past the threshold" || fail "audit.jsonl did not rotate"
grep -q '"tool":"Write"' "$ROT_RUN_DIR/audit.jsonl" && pass "rotation: the fresh audit.jsonl keeps recording" || fail "audit lost after rotation"
$AOS status >/dev/null && pass "rotation: status works with rotated logs" || fail "status broke on rotated logs"
ROT_PORT=45998
$AOS console --port $ROT_PORT >/dev/null 2>&1 &
ROT_CONSOLE_PID=$!
sleep 1
ROT_DETAIL=$(curl -s "http://127.0.0.1:$ROT_PORT/api/run?project=rot&run=$ROT_RUN")
case "$ROT_DETAIL" in *'"audit"'*) pass "rotation: console serves a run whose audit rotated" ;; *) kill $ROT_CONSOLE_PID; fail "console broke on rotated audit";; esac
kill $ROT_CONSOLE_PID 2>/dev/null

# --- corrupt registry: reads degrade, writes refuse to clobber ---
echo '{{{ not yaml' > "$AOS_HOME/registry.yaml"
$AOS status >/dev/null 2>&1 && pass "corrupt registry: status still works" || fail "status crashed on corrupt registry"
if $AOS init --name demo >/dev/null 2>&1; then
  fail "init overwrote a corrupt registry"
else
  grep -q "not yaml" "$AOS_HOME/registry.yaml" && pass "corrupt registry: init refuses to clobber" || fail "registry was clobbered"
fi
