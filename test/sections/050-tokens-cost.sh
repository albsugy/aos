# shellcheck shell=bash
# Token accounting, settle-once precision, session dedup, and cost estimation.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver
# shellcheck disable=SC2153  # RUN2_DIR/RUN2B_DIR are distinct runs, not a typo

# --- token accounting: cache reads tracked, attribution respects binding ---
TRANS="$WORK/transcript.jsonl"
echo '{"message":{"usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":7}}}' > "$TRANS"
printf '%s' '{"cwd":"'"$REPO"'","session_id":"sA","transcript_path":"'"$TRANS"'"}' | $AOS hook session-end
grep -q '"cache_read_tokens":100' "$AOS_HOME/projects/demo/sessions.jsonl" && pass "tokens: cache reads recorded per session" || fail "cache reads not recorded"
grep -q '"cache_read": 100' "$RUN2_DIR/meta.json" && pass "tokens: cache reads attributed to bound run" || fail "cache reads not on run"
printf '%s' '{"cwd":"'"$REPO"'","session_id":"sB","transcript_path":"'"$TRANS"'"}' | $AOS hook session-end
grep -q '"cache_read": 100' "$RUN2_DIR/meta.json" && pass "tokens: foreign session tokens not attributed to run" || fail "foreign tokens leaked into run"
review_active
$AOS run finish >/dev/null
# Settlement is once-only: a second SessionEnd for the same bound session must
# not double-count the already-settled run.
printf '%s' '{"cwd":"'"$REPO"'","session_id":"sA","transcript_path":"'"$TRANS"'"}' | $AOS hook session-end
grep -q '"input": 15' "$RUN2_DIR/meta.json" && pass "tokens: settle is once-only (no double count)" || fail "run tokens double-counted"

# --- token precision: baseline at start, settle at finish (sequential runs) ---
TRANS2="$WORK/transcript2.jsonl"
cat "$TRANS" "$TRANS" > "$TRANS2"   # totals: 30 in / 14 out / 200 cache
$AOS run start --ticket "LIN-2b" >/dev/null
RUN2B=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/demo/state.json")
RUN2B_DIR="$AOS_HOME/projects/demo/runs/$RUN2B"
# bind with the session's usage-so-far (TRANS = 15 in) as the baseline
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-2b"},"session_id":"sC","transcript_path":"'"$TRANS"'"}' | $AOS hook post-tool
$AOS run approve >/dev/null
review_active
$AOS run finish >/dev/null
# the post-tool hook for `aos run finish` settles the delta: 30 - 15 = 15 in
# (checked via node, not grep — tokens_baseline also contains "input": 15)
run_tokens() { node -e 'const m=require(process.argv[1]);console.log(m.tokens.input,m.tokens.output)' "$1"; }
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run finish"},"session_id":"sC","transcript_path":"'"$TRANS2"'"}' | $AOS hook post-tool
[ "$(run_tokens "$RUN2B_DIR/meta.json")" = "15 7" ] && pass "tokens: finish settles usage above bind-time baseline" || fail "baseline delta wrong ($(run_tokens "$RUN2B_DIR/meta.json"))"
# SessionEnd afterwards must be a no-op for this already-settled run
printf '%s' '{"cwd":"'"$REPO"'","session_id":"sC","transcript_path":"'"$TRANS2"'"}' | $AOS hook session-end
[ "$(run_tokens "$RUN2B_DIR/meta.json")" = "15 7" ] && pass "tokens: session-end after settle is a no-op" || fail "session-end re-credited a settled run"
node -e 'const m=require(process.argv[1]);process.exit(m.state_times && m.state_times["awaiting-review"]?0:1)' "$RUN2B_DIR/meta.json" \
  && pass "runs: state_times recorded at finish (cycle time derivable)" || fail "state_times missing"

# --- session totals: a resumed session is counted once, not once per ending ---
# SessionEnd fires again on resume / clear / logout, each time re-summing the
# WHOLE transcript, so the same cumulative total lands in sessions.jsonl
# repeatedly. Summing every line inflated real projects by 2-14x.
DEDUP_REPO="$WORK/dedup-repo"; mkdir -p "$DEDUP_REPO"; (cd "$DEDUP_REPO" && git init -q -b main)
(cd "$DEDUP_REPO" && $AOS init --name dedup >/dev/null)
DTRANS="$WORK/dedup-transcript.jsonl"
echo '{"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":70,"cache_read_input_tokens":400,"output_tokens":30}}}' > "$DTRANS"
cat "$DTRANS" "$DTRANS" > "$WORK/dedup-transcript2.jsonl"   # resumed: 140 in / 60 out / 800 cache
sess_end() { printf '%s' '{"cwd":"'"$DEDUP_REPO"'","session_id":"'"$1"'","transcript_path":"'"$2"'"}' | $AOS hook session-end; }
dedup_tokens() { $AOS status | grep -A4 '(dedup)' | grep 'tokens:'; }
sess_end sR "$DTRANS"
sess_end sR "$WORK/dedup-transcript2.jsonl"   # resumed, transcript grew, SessionEnd again
sess_end sR "$WORK/dedup-transcript2.jsonl"   # a third ending, no new usage
[ "$(grep -c . "$AOS_HOME/projects/dedup/sessions.jsonl")" = "3" ] \
  && pass "sessions: every SessionEnd still appends (log stays an event sequence)" || fail "session log not append-only"
dedup_tokens | grep -q "140 in / 60 out" \
  && pass "sessions: resumed session counted once at its true total (not 3x)" || fail "session tokens double-counted: $(dedup_tokens)"
dedup_tokens | grep -q "800 cache-read" \
  && pass "sessions: cache reads deduplicated too" || fail "cache reads double-counted: $(dedup_tokens)"
# a shrinking transcript (rotated/truncated) must not erase the larger total
sess_end sR "$DTRANS"
dedup_tokens | grep -q "140 in / 60 out" \
  && pass "sessions: a smaller later ending cannot under-report the session" || fail "truncated transcript lost tokens"
# distinct sessions still add up
sess_end sS "$DTRANS"
dedup_tokens | grep -q "210 in / 90 out" \
  && pass "sessions: distinct sessions still sum" || fail "distinct sessions not summed: $(dedup_tokens)"

# --- unbound runs: repeated SessionEnd must not multiply their tokens ---
# An unbound run legitimately collects usage from several sessions, but each
# session's transcript total is cumulative and SessionEnd fires repeatedly.
(cd "$DEDUP_REPO" && $AOS run start --ticket "LIN-UB" >/dev/null)
UB_RUN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/dedup/state.json")
UB_DIR="$AOS_HOME/projects/dedup/runs/$UB_RUN"
ub_tokens() { node -e 'const m=require(process.argv[1]);console.log(m.tokens.input,m.tokens.output)' "$UB_DIR/meta.json"; }
sess_end sX "$DTRANS"; sess_end sX "$DTRANS"; sess_end sX "$DTRANS"
[ "$(ub_tokens)" = "70 30" ] && pass "tokens: unbound run counts one session once, not once per ending" || fail "unbound run double-counted ($(ub_tokens))"
sess_end sX "$WORK/dedup-transcript2.jsonl"   # same session, transcript grew
[ "$(ub_tokens)" = "140 60" ] && pass "tokens: unbound run credits only the growth" || fail "unbound growth wrong ($(ub_tokens))"
sess_end sY "$DTRANS"                          # a genuinely different session still adds
[ "$(ub_tokens)" = "210 90" ] && pass "tokens: unbound run still sums distinct sessions" || fail "unbound distinct session lost ($(ub_tokens))"

# --- a REFUSED `run finish` must not settle the run's tokens ---
# The review gate refusing is the designed common path; settling there would
# freeze the total mid-work and stamp a fraction of the real cost into outcome.md.
(cd "$DEDUP_REPO" && $AOS run start --ticket "LIN-RF" >/dev/null)
RF_RUN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/dedup/state.json")
RF_DIR="$AOS_HOME/projects/dedup/runs/$RF_RUN"
printf '%s' '{"cwd":"'"$DEDUP_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-RF"},"session_id":"sZZ"}' | $AOS hook post-tool
(cd "$DEDUP_REPO" && $AOS run finish >/dev/null 2>&1) && fail "finish succeeded without a review" || true
printf '%s' '{"cwd":"'"$DEDUP_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run finish"},"session_id":"sZZ","transcript_path":"'"$DTRANS"'"}' | $AOS hook post-tool
node -e 'const m=require(process.argv[1]);process.exit(m.tokens_settled?1:0)' "$RF_DIR/meta.json" \
  && pass "tokens: a refused finish leaves the run unsettled" || fail "refused finish settled the run"
# ...and the same holds from `blocked`, which is parked, not finished
(cd "$DEDUP_REPO" && $AOS run state blocked --run "$RF_RUN" >/dev/null)
(cd "$DEDUP_REPO" && $AOS run finish >/dev/null 2>&1) && fail "blocked finish succeeded without a review" || true
printf '%s' '{"cwd":"'"$DEDUP_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run finish"},"session_id":"sZZ","transcript_path":"'"$DTRANS"'"}' | $AOS hook post-tool
node -e 'const m=require(process.argv[1]);process.exit(m.tokens_settled?1:0)' "$RF_DIR/meta.json" \
  && pass "tokens: a finish refused from blocked leaves the run unsettled" || fail "blocked+refused finish settled the run"
(cd "$DEDUP_REPO" && $AOS run state in-progress --run "$RF_RUN" >/dev/null)
review_active dedup
(cd "$DEDUP_REPO" && $AOS run finish >/dev/null)
printf '%s' '{"cwd":"'"$DEDUP_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run finish"},"session_id":"sZZ","transcript_path":"'"$WORK/dedup-transcript2.jsonl"'"}' | $AOS hook post-tool
node -e 'const m=require(process.argv[1]);process.exit(m.tokens_settled&&m.tokens.input===140?0:1)' "$RF_DIR/meta.json" \
  && pass "tokens: the finish that succeeds settles the full amount" || fail "successful finish settled wrong"

# --- leverage ratio: a rate needs a sample; below it, show the fraction ---
$AOS status | grep -q "clean-first-pass: .*runs (too few to rate)" \
  && pass "status: small samples report the fraction, not a percentage" || fail "leverage percentage shown on a tiny sample"

# --- cost estimation: per-model buckets → $ at API rates ---
TRANSM="$WORK/transcript-model.jsonl"
echo '{"message":{"model":"claude-sonnet-4-6","usage":{"input_tokens":10,"cache_creation_input_tokens":5,"cache_read_input_tokens":100,"output_tokens":7}}}' > "$TRANSM"
$AOS run start --ticket "LIN-2c" >/dev/null
RUN2C=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/demo/state.json")
RUN2C_DIR="$AOS_HOME/projects/demo/runs/$RUN2C"
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-2c"},"session_id":"sD"}' | $AOS hook post-tool
printf '%s' '{"cwd":"'"$REPO"'","session_id":"sD","transcript_path":"'"$TRANSM"'"}' | $AOS hook session-end
grep -q '"models"' "$AOS_HOME/projects/demo/sessions.jsonl" && pass "cost: per-model buckets recorded per session" || fail "session models missing"
node -e 'const m=require(process.argv[1]);const b=m.tokens.models["claude-sonnet-4-6"];process.exit(b&&b.input===10&&b.cache_write_5m===5?0:1)' "$RUN2C_DIR/meta.json" \
  && pass "cost: per-model buckets attributed to run (cache writes split out)" || fail "run model buckets wrong"
$AOS status | grep -q "est. at API rates" && pass "cost: status shows estimated cost" || fail "status cost missing"
review_active
$AOS run finish >/dev/null

