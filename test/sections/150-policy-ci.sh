# shellcheck shell=bash
# Policy CI: `aos policy test` — replay recorded traffic against the current
# policy and against candidates (tightening, loosening, broken).
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them (the seeded history is in 145-audit-chain.sh).
# Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

# --- policy test against the CURRENT policy ---
CUR=$($AOS policy test --since 7d)
echo "$CUR" | grep -q "unique command" && pass "policy test: replays recorded traffic" || fail "policy test produced no report"
echo "$CUR" | grep -q "Candidate: demo's installed policy.yaml" || fail "policy test: no --file → current policy is the candidate"
# git status and npm test ran freely and stay free under the policy that
# watched them run — they must not appear in either would-change list.
# (The window holds 90+ unique commands from earlier sections' gate matrix;
# exact totals are brittle, the per-command verdict is the contract.)
if echo "$CUR" | grep -A3 -E "would (DENY|GATE)" | grep -q "npm test"; then
  fail "policy test: a freely-run command flagged as newly gated"
else
  pass "policy test: current policy leaves the traffic it already allowed alone"
fi

# --- policy test against a CANDIDATE: what would change vs what actually ran ---
cat > "$WORK/candidate.yaml" <<'EOF'
tiers:
  forbidden:
    - pattern: '\bgit\s+status\b'
      reason: status is noisy, use it never
EOF
CAND=$($AOS policy test --file "$WORK/candidate.yaml" --since 7d)
echo "$CAND" | grep -q "Candidate: $WORK/candidate.yaml" || fail "policy test: candidate origin not named"
echo "$CAND" | grep -q "would DENY" && pass "policy test: candidate surfaces what it would newly deny" || fail "no would-DENY row"
echo "$CAND" | grep -q "git status --short" && pass "policy test: names the command and its count" || fail "denied command not listed"
echo "$CAND" | grep -q "status is noisy" || fail "policy test: shows the rule's reason"

# loosening: empty the gated tier — deploy becomes allowed
printf 'tiers:\n  gated: []\n' > "$WORK/loose.yaml"
LOOSE=$($AOS policy test --file "$WORK/loose.yaml" --since 7d)
echo "$LOOSE" | grep -q "would now ALLOW" && pass "policy test: loosening surfaces what it unblocks" || fail "no unblock row"
echo "$LOOSE" | grep -q "./deploy prod" || fail "unblocked command not listed"

# a broken candidate file fails loudly, never silently replays defaults
printf 'tiers: {{{\n' > "$WORK/broken.yaml"
$AOS policy test --file "$WORK/broken.yaml" >/dev/null 2>&1 && fail "policy test accepted broken YAML" || pass "policy test: broken candidate → non-zero, no silent default replay"
