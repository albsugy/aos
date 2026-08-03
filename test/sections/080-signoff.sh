# shellcheck shell=bash
# The run state machine and human sign-off: TTY identity, in-session tickets, permission modes, both close paths.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

# --- run state machine + sign-off identity ---
$AOS run start --ticket "LIN-8" >/dev/null
RUN8=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/demo/state.json")
RUN8_DIR="$AOS_HOME/projects/demo/runs/$RUN8"
$AOS run state shipped 2>/dev/null && fail "in-progress → shipped accepted" || pass "state: illegal transition rejected"
$AOS run state bogus 2>/dev/null && fail "unknown state accepted" || pass "state: unknown state rejected"
$AOS run state blocked >/dev/null && $AOS run state in-progress >/dev/null && pass "state: legal transitions still flow" || fail "legal transition rejected"
# close needs a TTY (stdin forced off the terminal so this also holds when run interactively)
OUT_NOTTY=$( (unset AOS_ALLOW_HEADLESS_APPROVE; $AOS run state "done" </dev/null) 2>&1 || true )
echo "$OUT_NOTTY" | grep -q "interactive terminal" && pass "state done: refused without a TTY" || fail "headless close not refused"
# plan approval stays prompt-based: works headless, identity recorded best-effort
$AOS run approve </dev/null >/dev/null
grep -q '"via": "headless-env"' "$RUN8_DIR/meta.json" && pass "approve: sign-off identity recorded in meta" || fail "approved_by not recorded"
$AOS run state shipped --force >/dev/null
grep -q '"state": "shipped"' "$RUN8_DIR/meta.json" && pass "state: --force overrides (escape hatch)" || fail "force override failed"
grep -q '"forced":true' "$RUN8_DIR/audit.jsonl" && pass "state: forced transition audited" || fail "forced transition not audited"
$AOS run state in-progress --force >/dev/null
review_active
$AOS run finish >/dev/null

# --- in-session sign-off: the gate prompt IS the human's approval ---
# Requiring a TTY put the sign-off in the one place the human never is — a
# second terminal — so runs stayed at awaiting-review forever. The gate now
# mints a single-use ticket when it asks, and the CLI accepts that as sign-off.
SIGN_REPO="$WORK/signoff-repo"; mkdir -p "$SIGN_REPO"; (cd "$SIGN_REPO" && git init -q -b main)
(cd "$SIGN_REPO" && $AOS init --name signoff >/dev/null)
sign_start() {  # start a run and bind it to a session, the way the pipeline does
  (cd "$SIGN_REPO" && $AOS run start --ticket "$1" >/dev/null)
  printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket '"$1"'"},"session_id":"'"$2"'"}' | $AOS hook post-tool
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/signoff/state.json"
}
RUNS=$(sign_start "LIN-S" sT)
RUNS_DIR="$AOS_HOME/projects/signoff/runs/$RUNS"
review_active signoff
(cd "$SIGN_REPO" && $AOS run finish) | grep -q "close it with" \
  && pass "finish: points at the in-session close, not a dashboard" || fail "finish gives no close instruction"

# Stop: the run is at awaiting-review and this session is the last one that
# knows what it did — surface the close here, not in a dashboard tomorrow.
STOP_REV=$(printf '%s' '{"cwd":"'"$SIGN_REPO"'","session_id":"sT"}' | $AOS hook stop)
echo "$STOP_REV" | grep -q "sitting at awaiting-review" && pass "stop: surfaces the open review before the session ends" || fail "stop did not surface the review"
echo "$STOP_REV" | grep -q "prompt IS the human" && pass "stop: tells the agent the prompt is the sign-off" || fail "stop nudge missing sign-off instruction"
STOP_REV2=$(printf '%s' '{"cwd":"'"$SIGN_REPO"'","session_id":"sT"}' | $AOS hook stop)
[ -z "$STOP_REV2" ] && pass "stop: review nudge fires once per session" || fail "review nudge repeated"

sign_gate() {  # the PreToolUse gate seeing the close command — mints the ticket
  printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run state '"$1"' --run '"$RUNS"'"},"session_id":"sT"}' | $AOS hook pre-tool
}
close_run() { (cd "$SIGN_REPO" && unset AOS_ALLOW_HEADLESS_APPROVE && $AOS run state "$1" --run "$RUNS" </dev/null) 2>&1; }

# no TTY, no gate prompt, no CI override → refuse, and say where to sign off
OUT_NOSIGN=$(close_run "done" || true)
echo "$OUT_NOSIGN" | grep -q "needs a human sign-off" && pass "close: refused with no sign-off of any kind" || fail "unsigned close accepted"
echo "$OUT_NOSIGN" | grep -q "interactive terminal" && pass "close: refusal still names the terminal route" || fail "refusal missing terminal route"

# the gate asks → the human approves the prompt → the same command now closes
sign_gate "done" | grep -q '"permissionDecision":"ask"' && pass "close: gate asks before the close runs" || fail "close not gated"
# flag order must not decide whether the gate fires — `--run X done` is equally
# valid CLI, and missing it left the agent in an unbreakable refusal loop
printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run state --run '"$RUNS"' done"},"session_id":"sT"}' | $AOS hook pre-tool \
  | grep -q '"permissionDecision":"ask"' && pass "close: gate fires whatever the flag order" || fail "flag order evaded the sign-off gate"
printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run state in-progress --run '"$RUNS"'"},"session_id":"sT"}' | $AOS hook pre-tool \
  | grep -q 'reserved for the human' && fail "reopening a run demanded sign-off" || pass "close: reopening stays ungated"
close_run "done" >/dev/null
grep -q '"state": "done"' "$RUNS_DIR/meta.json" && pass "close: gate-prompt approval closes the run in-session" || fail "gate ticket not accepted"
grep -q '"via": "gate-prompt"' "$RUNS_DIR/meta.json" && pass "close: sign-off route recorded as gate-prompt" || fail "sign-off route not recorded"

# single-use: the same approval cannot close a second time
(cd "$SIGN_REPO" && $AOS run state awaiting-review --run "$RUNS" >/dev/null)
close_run "done" >/dev/null 2>&1 && fail "consumed ticket reused" || pass "close: sign-off ticket is single-use"
# an approval shown for one run must not authorize closing a different one —
# without this the gate could ask about run A and a close of run B inside the
# five-minute window would spend that approval
sign_gate_other() {
  printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run state done --run some-other-run"},"session_id":"sT"}' | $AOS hook pre-tool >/dev/null
}
sign_gate_other
close_run "done" >/dev/null 2>&1 && fail "a ticket for another run closed this one" || pass "close: an approval is bound to the run it was shown for"
# and a plan-approval prompt is not a close approval
printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run approve"},"session_id":"sT"}' | $AOS hook pre-tool >/dev/null
close_run "done" >/dev/null 2>&1 && fail "plan-approve ticket closed a run" || pass "close: tickets are bound to their action"

# --- permission modes: an `ask` that reaches nobody is not a sign-off ---
# Claude Code fires PreToolUse in EVERY permission mode and honours `deny` even
# under --dangerously-skip-permissions, but an `ask` only reaches a human in the
# prompting modes. Minting a sign-off ticket in bypassPermissions/acceptEdits/
# dontAsk would let an agent close its own run with nobody in the loop.
mode_gate() {
  printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run state done --run '"$RUNS"'"},"session_id":"sT","permission_mode":"'"$1"'"}' | $AOS hook pre-tool
}
for MODE in bypassPermissions acceptEdits dontAsk auto; do
  rm -f "$AOS_HOME/projects/signoff/signoff.json"
  mode_gate "$MODE" | grep -q '"permissionDecision":"ask"' || fail "gate stopped asking in $MODE"
  [ -f "$AOS_HOME/projects/signoff/signoff.json" ] && fail "sign-off ticket minted in $MODE (no human sees that prompt)"
done
pass "modes: the gate still asks, but mints no sign-off ticket where nobody is prompted"
for MODE in default plan; do
  rm -f "$AOS_HOME/projects/signoff/signoff.json"
  mode_gate "$MODE" >/dev/null
  [ -f "$AOS_HOME/projects/signoff/signoff.json" ] || fail "no sign-off ticket in $MODE (a human IS prompted there)"
done
pass "modes: prompting modes still mint the ticket"
# an older Claude Code sends no permission_mode — assume the interactive default
rm -f "$AOS_HOME/projects/signoff/signoff.json"
printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run state done --run '"$RUNS"'"},"session_id":"sT"}' | $AOS hook pre-tool >/dev/null
[ -f "$AOS_HOME/projects/signoff/signoff.json" ] && pass "modes: a payload without permission_mode still works" || fail "missing permission_mode broke the ticket"
# and the mode is recorded on the gate decision, so an auditor can tell later
rm -f "$AOS_HOME/projects/signoff/signoff.json"
mode_gate bypassPermissions >/dev/null
grep -rq '"mode":"bypassPermissions"' "$AOS_HOME/projects/signoff/" \
  && pass "modes: the permission mode is recorded on the gate decision" || fail "permission mode not audited"
# a forbidden command is denied in every mode — Claude Code honours deny even
# under --dangerously-skip-permissions, so this is the tier that always holds
printf '%s' '{"cwd":"'"$SIGN_REPO"'","tool_name":"Bash","tool_input":{"command":"rm -rf /"},"session_id":"sT","permission_mode":"bypassPermissions"}' | $AOS hook pre-tool \
  | grep -q '"permissionDecision":"deny"' && pass "modes: forbidden stays denied in bypassPermissions" || fail "deny weakened in bypass mode"

# review_capture: false opts out (last — it replaces the policy wholesale)
RUNU=$(sign_start "LIN-U" sU)
review_active signoff
(cd "$SIGN_REPO" && $AOS run finish >/dev/null)
printf 'version: 1\nreview_capture: false\n' > "$AOS_HOME/projects/signoff/policy.yaml"
STOP_OFF=$(printf '%s' '{"cwd":"'"$SIGN_REPO"'","session_id":"sU"}' | $AOS hook stop)
echo "$STOP_OFF" | grep -q "sitting at awaiting-review" && fail "review_capture false still nudged ($RUNU)" \
  || pass "stop: review_capture false disables the nudge"

# --- closing a run is gated whichever command gets there ---
# `run finish --state done` reaches the same terminal state as `run state done`.
# Gating only one of them let a run close with no prompt, no sign-off, and a
# record saying nobody closed it.
CLOSE_REPO="$WORK/close-repo"; mkdir -p "$CLOSE_REPO"
(cd "$CLOSE_REPO" && git init -q -b main && $AOS init --name closer >/dev/null)
(cd "$CLOSE_REPO" && $AOS run start --ticket "CL-1" >/dev/null)
CLOSE_RUN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/closer/state.json")
review_active closer
(cd "$CLOSE_REPO" && $AOS run state awaiting-review >/dev/null)
# the gate must see BOTH spellings of a close
for CMD in "aos run finish --state done" "aos run finish --state shipped" "aos run state done --run $CLOSE_RUN"; do
  printf '%s' '{"cwd":"'"$CLOSE_REPO"'","tool_name":"Bash","tool_input":{"command":"'"$CMD"'"},"session_id":"sC"}' | $AOS hook pre-tool \
    | grep -q 'reserved for the human' || fail "close not gated: $CMD"
done
pass "close: the gate sees run finish --state done|shipped as well as run state"
# plain `run finish` (to awaiting-review) is NOT a close and must stay ungated
printf '%s' '{"cwd":"'"$CLOSE_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run finish"},"session_id":"sC"}' | $AOS hook pre-tool \
  | grep -q 'reserved for the human' && fail "plain run finish demanded sign-off" || pass "close: plain run finish stays ungated"
# and the CLI refuses without one, then records who closed it when given one.
# The gate calls above minted a ticket — clear it, or this tests nothing.
rm -f "$AOS_HOME/projects/closer/signoff.json"
OUT_UNSIGNED=$( (cd "$CLOSE_REPO" && unset AOS_ALLOW_HEADLESS_APPROVE && $AOS run finish --state "done" </dev/null) 2>&1 || true )
echo "$OUT_UNSIGNED" | grep -q "needs a human sign-off" && pass "close: run finish --state done refuses without sign-off" || fail "unsigned finish-close accepted"
(cd "$CLOSE_REPO" && $AOS run finish --state "done" >/dev/null)   # AOS_ALLOW_HEADLESS_APPROVE is set suite-wide
grep -q '"closed_by"' "$AOS_HOME/projects/closer/runs/$CLOSE_RUN/meta.json" \
  && pass "close: run finish --state done records who closed it" || fail "closed_by missing after finish-close"
# the audit line must agree with what meta actually says about the review
(cd "$CLOSE_REPO" && $AOS run start --ticket "CL-2" >/dev/null)
CLOSE_RUN2=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/closer/state.json")
(cd "$CLOSE_REPO" && $AOS run finish --force >/dev/null)
(cd "$CLOSE_REPO" && $AOS run state "done" --run "$CLOSE_RUN2" >/dev/null)
# shellcheck disable=SC2016  # the node script's own $ must not expand here
node -e '
  const fs = require("fs"), path = require("path");
  const [runDir, projDir] = process.argv.slice(1);
  const m = require(path.join(runDir, "meta.json"));
  // finish clears activeRun, so the close line lands in the PROJECT log rather
  // than the run folder — check both.
  const lines = [path.join(runDir, "audit.jsonl"), path.join(projDir, "audit.jsonl")]
    .flatMap((f) => { try { return fs.readFileSync(f, "utf8").trim().split("\n"); } catch { return []; } })
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const close = lines.reverse().find((l) => l.event === "run-state" && l.state === "done" && l.run === m.run);
  if (!close) { console.error("no close audit line found for " + m.run); process.exit(1); }
  if (close.adversarial_review !== m.adversarial_review) {
    console.error(`audit says ${close.adversarial_review}, meta says ${m.adversarial_review}`);
    process.exit(1);
  }
' "$AOS_HOME/projects/closer/runs/$CLOSE_RUN2" "$AOS_HOME/projects/closer" \
  && pass "close: the audit line records what meta actually says (forced stays forced)" || fail "close audit contradicts meta"

