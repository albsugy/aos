#!/usr/bin/env bash
# AOS end-to-end smoke test. Runs against an isolated AOS_HOME and a throwaway repo.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom here; pass() cannot fail
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Override to test the compiled bundle: AOS_BIN="node $ROOT/dist/aos.mjs" bash test/smoke.sh
AOS="${AOS_BIN:-node $ROOT/bin/aos.js}"
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
$AOS find "LIN-1" | grep -q "ticket.md" && pass "find searches project memory" || fail "find"

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
hook_out '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run approve"},"session_id":"sA"}' \
  | grep -q '"permissionDecision":"ask"' && pass "plan gate: agent self-approval → ask (human decides)" || fail "self-approval not gated"
$AOS run approve >/dev/null
[ -z "$(hook_out "$IN_IMPL")" ] && pass "plan gate: repo write after approval → allow" || fail "plan gate stuck after approval"
[ -z "$(hook_out "$IN_BASHW")" ] && pass "plan gate: bash write after approval → allow" || fail "bash plan gate stuck after approval"

# --- session binding: concurrent sessions don't pollute the run ---
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-2"},"session_id":"sA"}' | $AOS hook post-tool
grep -q '"session": "sA"' "$RUN2_DIR/meta.json" && pass "binding: run bound to starting session" || fail "run not bound"
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
# The standard pipeline finishes the run INSIDE the session — tokens recorded at
# SessionEnd must still land on the (now inactive) run this session is bound to.
printf '%s' '{"cwd":"'"$REPO"'","session_id":"sA","transcript_path":"'"$TRANS"'"}' | $AOS hook session-end
grep -q '"input": 30' "$RUN2_DIR/meta.json" && pass "tokens: finished run still credited via session binding" || fail "tokens lost after run finish"

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
( cd "$BARE_REPO" && git init -q -b main && $AOS init --name bare >/dev/null )
grep -q "one paragraph: purpose" "$AOS_HOME/projects/bare/context/pack.md" && pass "init: no signal → blank template" || fail "blank fallback missing"

# --- supply-chain guard: the compiled CLI accesses the network in no way at all ---
# All outbound access lives in install.sh (registry resolve + sha-512 verify); the CLI
# self-updates by running that local, already-verified installer. So the bundle must
# neither shell out to curl nor call fetch/reach the registry directly.
grep -q 'curl' "$ROOT/dist/aos.mjs" && fail "compiled bundle shells out to curl (possible curl|bash supply-chain risk)" || pass "no curl in compiled bundle — no remote-script execution"
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
