#!/usr/bin/env bash
# AOS end-to-end smoke test. Runs against an isolated AOS_HOME and a throwaway repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
AOS="node $ROOT/bin/aos.js"
WORK="$(mktemp -d)"
export AOS_HOME="$WORK/aos-home"
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

# init twice must be idempotent (no duplicate hooks)
$AOS init --name demo >/dev/null
HOOK_COUNT=$(grep -o "hook pre-tool" "$REPO/.claude/settings.json" | wc -l | tr -d ' ')
[ "$HOOK_COUNT" = "1" ] && pass "init: idempotent hooks" || fail "init duplicated hooks ($HOOK_COUNT)"

# --- run lifecycle ---
$AOS run start --ticket "LIN-1" --title "Demo ticket" | grep -q "Run started" || fail "run start"
RUN_DIR=$(ls -d "$AOS_HOME/projects/demo/runs/"*/ | head -1)
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
printf '%s' '{"cwd":"'$REPO'","tool_name":"Write","tool_input":{"file_path":"src/a.js"},"session_id":"s1"}' | $AOS hook post-tool
grep -q '"tool":"Write"' "$RUN_DIR/audit.jsonl" && pass "post-tool audited" || fail "post-tool audit"
CTX=$(printf '%s' '{"cwd":"'$REPO'","session_id":"s1"}' | $AOS hook session-start)
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

# --- finish + status + find ---
$AOS run finish >/dev/null
$AOS status | grep -q "awaiting-review" && pass "status shows awaiting-review" || fail "status"
$AOS find "LIN-1" | grep -q "ticket.md" && pass "find searches project memory" || fail "find"

# --- console API ---
PORT=45997
$AOS console --port $PORT >/dev/null 2>&1 &
CONSOLE_PID=$!
sleep 1
STATE=$(curl -s "http://127.0.0.1:$PORT/api/state")
echo "$STATE" | grep -q '"id":"demo"' && pass "console API: state" || { kill $CONSOLE_PID; fail "console state"; }
RUN_ID=$(basename "$RUN_DIR")
DETAIL=$(curl -s "http://127.0.0.1:$PORT/api/run?project=demo&run=$RUN_ID")
echo "$DETAIL" | grep -q '"audit"' && pass "console API: run detail" || { kill $CONSOLE_PID; fail "console run detail"; }
curl -s "http://127.0.0.1:$PORT/" | grep -q "AOS Console" && pass "console serves UI" || { kill $CONSOLE_PID; fail "console UI"; }
kill $CONSOLE_PID 2>/dev/null

echo ""
echo "All smoke tests passed."
rm -rf "$WORK"
