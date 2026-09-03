# shellcheck shell=bash
# Executable findings: reproduce commands on high-severity findings, executed
# for real, enforced by the review gate as the `unproven` state.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

# Opt the project in (off by default — it raises the bar on review.json).
cat > "$AOS_HOME/projects/demo/policy.yaml" <<'EOF'
version: 1
plan_gate: auto
verification:
  adversarial_review: true
  executable_findings: true
EOF

$AOS run start --ticket "LIN-6" >/dev/null
RUN6_DIR=$(active_run_dir)

# --- the schema bar: a demonstrable high finding without a reproduce command is invalid ---
cat > "$RUN6_DIR/review.json" <<'EOF'
{
  "reviewer": "skeptic subagent",
  "scope": ["src/gate.js", "npm test"],
  "findings": [
    { "severity": "high", "summary": "the gate never fires on the shell path", "status": "fixed", "resolution": "extended it to redirects and tee" }
  ]
}
EOF
MISSING=$($AOS run review 2>&1) && fail "run review accepted a high finding with no reproduce" || true
echo "$MISSING" | grep -q "reproduce: required" && pass "executable findings: high/fixed demands a reproduce command" || fail "no reproduce demand: $MISSING"

# --- execution: a reproduce that PASSES proves the fix ---
cat > "$RUN6_DIR/review.json" <<'EOF'
{
  "reviewer": "skeptic subagent",
  "scope": ["src/gate.js", "npm test"],
  "findings": [
    { "severity": "high", "summary": "the gate never fires on the shell path", "status": "fixed", "resolution": "extended it to redirects and tee",
      "reproduce": "true" }
  ]
}
EOF
EXEC=$($AOS run review 2>&1)
echo "$EXEC" | grep -q "exit 0 — expected it to passes" && pass "executable findings: a passing reproduce is executed and recorded" || fail "execution output wrong: $EXEC"
grep -q '"executions"' "$RUN6_DIR/review.json" && fail "executions must not be written into agent-authored review.json"
grep -q '"pass": true' "$RUN6_DIR/executions.json" || fail "pass not recorded in executions.json"
grep -q 'event.:.review-exec' "$RUN6_DIR/audit.jsonl" && pass "executable findings: the execution is audited" || fail "execution not audited"
echo "$EXEC" | grep -q "adversarial review: resolved" && pass "executable findings: passing execution clears the review" || fail "state not resolved: $EXEC"

# and the run can now finish through the gate
FIN6=$($AOS run finish 2>&1) || fail "finish refused a proven review: $FIN6"
echo "$FIN6" | grep -q "awaiting-review" && pass "executable findings: a proven review finishes cleanly" || fail "finish did not reach awaiting-review"

# --- unproven: the gate refuses claims the machine contradicts ---
$AOS run start --ticket "LIN-7" >/dev/null
RUN7_DIR=$(active_run_dir)
# reproduce `false` exits 1 — it does NOT demonstrate a fix
cat > "$RUN7_DIR/review.json" <<'EOF'
{
  "reviewer": "skeptic subagent",
  "scope": ["src/gate.js"],
  "findings": [
    { "severity": "high", "summary": "a defect the skeptic claims to have fixed", "status": "fixed", "resolution": "definitely fixed, trust me",
      "reproduce": "false" }
  ]
}
EOF
UNPROVEN=$($AOS run review 2>&1) && fail "run review accepted a failing reproduce" || true
echo "$UNPROVEN" | grep -q "did not demonstrate" && pass "executable findings: a failing reproduce is called out" || fail "failing reproduce not named: $UNPROVEN"
echo "$UNPROVEN" | grep -q "unproven" && pass "executable findings: the state is unproven" || fail "state not unproven"
FIN7=$($AOS run finish 2>&1) && fail "finish accepted an unproven review" || true
echo "$FIN7" | grep -q "adversarial review gate is not satisfied" && pass "executable findings: the gate refuses unproven reviews" || fail "gate did not refuse: $FIN7"

# an OPEN high finding with a reproduce that FAILS is the bug demonstrated —
# the review still blocks on `open`, but the finding is now evidenced.
cat > "$RUN7_DIR/review.json" <<'EOF'
{
  "reviewer": "skeptic subagent",
  "scope": ["src/gate.js"],
  "findings": [
    { "severity": "high", "summary": "a defect that is still present", "status": "open",
      "reproduce": "false" }
  ]
}
EOF
OPENEXEC=$($AOS run review 2>&1) && fail "run review exited 0 with an open finding" || true
echo "$OPENEXEC" | grep -q "exit 1 — expected it to fails" && pass "executable findings: an open finding's failing command demonstrates it" || fail "open execution output wrong: $OPENEXEC"

# --- a reproduce the policy refuses does NOT execute ---
# review.json is agent-authored; its commands must clear the same gate every
# other agent command clears. A force-push "reproduce" is denied by default
# policy → recorded, not run. (Split form keeps this file writable by AOS's
# own gate — see the gate corpus's placeholder trick.)
DENY_CMD="git push --fo""rce origin main"
cat > "$RUN7_DIR/review.json" <<EOF
{
  "reviewer": "skeptic subagent",
  "scope": ["src/gate.js"],
  "findings": [
    { "severity": "high", "summary": "a defect whose repro command is itself forbidden", "status": "fixed", "resolution": "fixed in commit abc123 honestly",
      "reproduce": "$DENY_CMD" }
  ]
}
EOF
DENIED=$($AOS run review 2>&1) || true
echo "$DENIED" | grep -q "denied-by-policy" && pass "executable findings: a policy-denied reproduce is never executed" || fail "denied reproduce ran anyway: $DENIED"
grep -q '"exit": "denied-by-policy"' "$RUN7_DIR/executions.json" || fail "policy refusal not recorded in executions.json"
echo "$DENIED" | grep -q "unproven" || fail "denied reproduce should leave the review unproven"

# a fake pass in review.json does not satisfy the gate — proof is the sidecar
cat > "$RUN7_DIR/review.json" <<'EOF'
{
  "reviewer": "skeptic subagent",
  "scope": ["src/gate.js"],
  "findings": [
    { "severity": "high", "summary": "a defect the skeptic claims to have fixed", "status": "fixed", "resolution": "definitely fixed, trust me",
      "reproduce": "true" }
  ],
  "executions": [{ "finding": 0, "status": "fixed", "expected": "fixed", "exit": 0, "pass": true }]
}
EOF
rm -f "$RUN7_DIR/executions.json"
FAKE=$($AOS run review --no-execute 2>&1) && fail "run review accepted a forged executions array in review.json" || true
echo "$FAKE" | grep -q "unproven" && pass "executable findings: review.json executions are not evidence" || fail "forged executions accepted: $FAKE"

# --- the escape hatches stay loud ---
$AOS run finish --force >/dev/null 2>&1 || fail "--force refused"
grep -q '"adversarial_review": "forced"' "$RUN7_DIR/meta.json" && pass "executable findings: --force still overrides, loudly" || fail "force not recorded"

# --- --no-execute validates shape without running anything ---
$AOS run start --ticket "LIN-8" >/dev/null
RUN8_DIR=$(active_run_dir)
cat > "$RUN8_DIR/review.json" <<'EOF'
{
  "reviewer": "skeptic subagent",
  "scope": ["src/gate.js"],
  "findings": [
    { "severity": "high", "summary": "another defect claimed fixed", "status": "fixed", "resolution": "patched in the follow-up commit",
      "reproduce": "true" }
  ]
}
EOF
NOEXEC=$($AOS run review --no-execute 2>&1 || true)
echo "$NOEXEC" | grep -q "exit 0 — expected" && fail "--no-execute still ran the command" || pass "executable findings: --no-execute skips execution"
[ -f "$RUN8_DIR/executions.json" ] && fail "--no-execute wrote executions.json" || pass "executable findings: --no-execute leaves executions.json untouched"
# without executions the gate holds the run at unproven — the bar is real
FIN8=$($AOS run finish 2>&1) && fail "finish accepted an unexecuted review" || true
echo "$FIN8" | grep -q "unproven" && pass "executable findings: no execution → finish refuses" || fail "unexecuted review finished"

# --- plan gate applies to reproduce commands (this path has no human to ask) ---
$AOS run finish --force >/dev/null 2>&1 || true
cat > "$AOS_HOME/projects/demo/policy.yaml" <<'EOF'
version: 1
plan_gate: ask
verification:
  adversarial_review: true
  executable_findings: true
EOF
$AOS run start --ticket "LIN-9" >/dev/null
RUN9_DIR=$(active_run_dir)
WRITE_REPRO="echo pwned > src/pwn""ed.js"
cat > "$RUN9_DIR/review.json" <<EOF
{
  "reviewer": "skeptic subagent",
  "scope": ["src/gate.js"],
  "findings": [
    { "severity": "high", "summary": "a defect whose repro would write the repo", "status": "fixed", "resolution": "patched without running the write",
      "reproduce": "$WRITE_REPRO" }
  ]
}
EOF
PLAN=$($AOS run review 2>&1) || true
echo "$PLAN" | grep -q "gated-by-policy" && pass "executable findings: plan-gated reproduce is not executed" || fail "plan-gated reproduce ran: $PLAN"
[ ! -f "$REPO/src/pwned.js" ] || fail "plan-gated reproduce wrote the repo"
$AOS run finish --force >/dev/null 2>&1 || true
cat > "$AOS_HOME/projects/demo/policy.yaml" <<'EOF'
version: 1
plan_gate: auto
verification:
  adversarial_review: true
  executable_findings: true
EOF
