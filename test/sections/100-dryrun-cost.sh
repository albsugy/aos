# shellcheck shell=bash
# Dry-run mode and cost attribution/groupings.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

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


