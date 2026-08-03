# shellcheck shell=bash
# The adversarial review gate: schema, open findings, warn mode, --force.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

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

