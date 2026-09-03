# shellcheck shell=bash
# Project removal: the gate on `aos remove`, the open-run guard, registry-only
# removal (data kept, receipt written), and the signed-off --purge.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

RM_REPO="$WORK/rm-repo"; mkdir -p "$RM_REPO"; (cd "$RM_REPO" && git init -q -b main)
(cd "$RM_REPO" && $AOS init --name gone >/dev/null)
RM2_REPO="$WORK/rm2-repo"; mkdir -p "$RM2_REPO"; (cd "$RM2_REPO" && git init -q -b main)
(cd "$RM2_REPO" && $AOS init --name gone2 >/dev/null)

# --- removing a project is a gated act: unregistering turns the gates off ---
RM_IN='{"cwd":"'"$RM_REPO"'","tool_name":"Bash","tool_input":{"command":"aos remove gone"},"session_id":"s1"}'
hook_out "$RM_IN" | grep -q '"permissionDecision":"ask"' && pass "remove: gated — an agent running it is asked, not allowed" || fail "aos remove not gated"

# --- refuses while a run is open ---
(cd "$RM_REPO" && $AOS run start --ticket "LIN-9" >/dev/null)
if $AOS remove gone >/dev/null 2>&1; then fail "remove succeeded with an open run"; else pass "remove: refuses while a run is in progress"; fi
RM_REFUSAL=$($AOS remove gone 2>&1 || true)
echo "$RM_REFUSAL" | grep -q "open run" || fail "open-run refusal is not explained"
grep -q 'id: gone$' "$AOS_HOME/registry.yaml" || fail "refused removal still unregistered the project"

# --- registry-only removal: data kept, receipt written, listings updated ---
$AOS remove gone --force 2>&1 | grep -q "data kept" && pass "remove: --force unregisters and keeps the data" || fail "force removal output wrong"
grep -q 'id: gone$' "$AOS_HOME/registry.yaml" && fail "gone still registered" || pass "remove: gone from the registry"
[ -d "$AOS_HOME/projects/gone" ] && pass "remove: the data dir survives without --purge" || fail "data dir was deleted without --purge"
[ -f "$AOS_HOME/removals.jsonl" ] || fail "no removals ledger"
grep -q '"id":"gone"' "$AOS_HOME/removals.jsonl" && grep -q '"purged":false' "$AOS_HOME/removals.jsonl" \
  && pass "remove: registry-only removal recorded as purged:false" || fail "receipt wrong or missing"
if $AOS projects | grep -q "gone2"; then :; else fail "gone2 should still be listed"; fi
$AOS projects | grep -Eq "^gone2" && ! $AOS projects | grep -q "^gone " \
  && pass "remove: aos projects lists gone2 but not gone" || fail "projects listing wrong after removal"

# --- --purge demands a human sign-off ---
if env -u AOS_ALLOW_HEADLESS_APPROVE "$AOS" remove gone2 --purge >/dev/null 2>&1; then
  fail "purge succeeded without a sign-off"
else
  pass "remove: --purge without TTY/gate/CI-env refuses"
fi
grep -q 'id: gone2$' "$AOS_HOME/registry.yaml" || fail "refused purge still unregistered the project"

# with the CI escape hatch (the driver exports it), the purge proceeds
$AOS remove gone2 --purge 2>&1 | grep -q "deleted its data" && pass "remove: signed-off purge proceeds" || fail "purge did not run"
[ ! -d "$AOS_HOME/projects/gone2" ] && pass "remove: --purge deletes the project data" || fail "data dir survived --purge"
grep -q '"id":"gone2"' "$AOS_HOME/removals.jsonl" && grep -q '"purged":true' "$AOS_HOME/removals.jsonl" \
  && pass "remove: purge recorded as purged:true" || fail "purge receipt wrong or missing"
# the receipt carries who authorized it
grep -q '"via":"headless-env"' "$AOS_HOME/removals.jsonl" && pass "remove: the purge receipt names the route" || fail "receipt lacks the sign-off route"

# --- degenerate cases ---
if $AOS remove nosuch >/dev/null 2>&1; then fail "unknown id removed"; else pass "remove: unknown id errors, never fakes success"; fi
# the audit sweep still walks the remaining projects cleanly (demo verifies)
$AOS audit verify --project demo | grep -q "All ledgers verify" && pass "remove: audit verify unaffected" || fail "verify broke after removals"

# --- the receipt ledger is protected evidence, and tamper-evident itself ---
# An agent must not forge or rewrite the ledger that survives the purge.
# demo is still registered; the unregistered repos no longer trigger the gate.
RM_FORGE='{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"echo forged > '"$AOS_HOME"'/removals.jsonl"},"session_id":"s1"}'
hook_out "$RM_FORGE" | grep -q '"permissionDecision":"ask"' && pass "remove: writing removals.jsonl via shell is gated" || fail "removals.jsonl shell write bypass"
RM_INGEST='{"cwd":"'"$REPO"'","tool_name":"Write","tool_input":{"file_path":"'"$AOS_HOME"'/projects/demo/ingest.json"},"session_id":"s1"}'
hook_out "$RM_INGEST" | grep -q '"permissionDecision":"ask"' && pass "remove: writing ingest.json via file tool is gated" || fail "ingest.json file write bypass"

# the receipts are hash-chained and verified by the same sweep as the audits
grep -q '"chain"' "$AOS_HOME/removals.jsonl" && pass "remove: receipts are hash-chained" || fail "receipts not chained"
SWEEP_RM=$($AOS audit verify 2>&1 || true)
echo "$SWEEP_RM" | grep -q "removals ledger" && pass "remove: audit verify walks the removals ledger" || fail "sweep ignores removals: $SWEEP_RM"
