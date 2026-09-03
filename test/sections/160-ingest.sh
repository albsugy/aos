# shellcheck shell=bash
# History ingest: Claude Code transcripts → chained audit lines + token ledger,
# idempotent, replayable through policy test.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

# A synthetic Claude Code transcript, shaped like the real ones: cwd on entries,
# assistant messages with tool_use blocks and usage, sessionId, timestamps.
CLAUDE_FIX="$WORK/claude-config"
export CLAUDE_CONFIG_DIR="$CLAUDE_FIX"
SESS_DIR="$CLAUDE_FIX/projects/-fixture-demo"
mkdir -p "$SESS_DIR"
SESS_FILE="$SESS_DIR/aaa-ingest-1.jsonl"
node -e '
  const fs = require("fs");
  const repo = process.argv[1], out = process.argv[2];
  const e1 = { type: "mode", sessionId: "ing-1", cwd: repo, timestamp: "2026-08-20T10:00:00Z" };
  const e2 = {
    type: "assistant", isSidechain: false, cwd: repo, timestamp: "2026-08-20T10:00:01Z",
    message: {
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 60 },
      content: [{ type: "tool_use", name: "Bash", input: { command: "git push origin release-branch" } }],
    },
  };
  const e3 = {
    type: "assistant", isSidechain: false, cwd: repo, timestamp: "2026-08-20T10:00:02Z",
    message: {
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 300 },
      content: [{ type: "tool_use", name: "Bash", input: { command: "rm src/old.js" } }],
    },
  };
  fs.writeFileSync(out, [e1, e2, e3].map((e) => JSON.stringify(e)).join("\n") + "\n");
' "$REPO" "$SESS_FILE"

# --- dry run reports and writes nothing ---
DRY=$($AOS ingest --dry-run)
echo "$DRY" | grep -q "dry run — nothing written" && pass "ingest: dry run announces itself" || fail "dry run banner missing"
echo "$DRY" | grep -q "2 tool call(s)" && pass "ingest: dry run counts what it would write" || fail "dry run count wrong: $DRY"
[ ! -f "$AOS_HOME/projects/demo/ingest.json" ] || fail "dry run wrote state"

# --- the real thing: audit lines (chained, original timestamps) + a session line ---
$AOS ingest | grep -q "2 tool call(s)" && pass "ingest: transcript matched demo by its cwd" || fail "no match for the demo repo"
grep -q '"source":"ingested"' "$AOS_HOME/projects/demo/audit.jsonl" && pass "ingest: audit lines marked source=ingested" || fail "no ingested audit lines"
grep -q '"command\?":' "$AOS_HOME/projects/demo/audit.jsonl" 2>/dev/null || true
grep -q '"summary":"git push origin release-branch"' "$AOS_HOME/projects/demo/audit.jsonl" || fail "ingested command not in audit"
node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ing = lines.filter((l) => l.source === "ingested");
  if (ing.length !== 2) { console.error("expected 2 ingested lines, got " + ing.length); process.exit(1); }
  if (!ing.every((l) => l.chain && Number.isInteger(l.chain.seq))) { console.error("ingested lines not chained"); process.exit(1); }
  if (ing[0].ts !== "2026-08-20T10:00:01Z") { console.error("timestamp not preserved: " + ing[0].ts); process.exit(1); }
' "$AOS_HOME/projects/demo/audit.jsonl" && pass "ingest: lines are chained with original timestamps" || fail "ingested lines malformed"

# tokens land in sessions.jsonl, same arithmetic as the SessionEnd hook
# tokens land in sessions.jsonl, same arithmetic as the SessionEnd hook:
# input 100+50 plus cache-creation 60 → 210; cache reads 900+300
node -e '
  const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const ing = lines.find((l) => l.source === "ingested" && l.session === "ing-1");
  if (!ing) { console.error("no ingested session line"); process.exit(1); }
  if (ing.input_tokens !== 210) { console.error("input " + ing.input_tokens + " ≠ 210"); process.exit(1); }
  if (ing.cache_read_tokens !== 1200) { console.error("cache_read " + ing.cache_read_tokens + " ≠ 1200"); process.exit(1); }
' "$AOS_HOME/projects/demo/sessions.jsonl" && pass "ingest: token totals match the transcript usage" || fail "session tokens wrong"
grep -q '"source":"ingested"' "$AOS_HOME/projects/demo/sessions.jsonl" || fail "session line not marked ingested"

# --- idempotent: unchanged file → no new lines; grown file → only the delta ---
LINES_BEFORE=$(grep -c '"source":"ingested"' "$AOS_HOME/projects/demo/audit.jsonl")
AGAIN=$($AOS ingest)
if ! echo "$AGAIN" | grep -q "tool call"; then pass "ingest: re-run over unchanged file writes nothing"; else fail "re-ingest duplicated: $AGAIN"; fi
[ "$(grep -c '"source":"ingested"' "$AOS_HOME/projects/demo/audit.jsonl")" = "$LINES_BEFORE" ] || fail "audit lines grew on re-ingest"

node -e '
  const fs = require("fs");
  const e4 = {
    type: "assistant", isSidechain: false, cwd: process.argv[1], timestamp: "2026-08-20T11:00:00Z",
    message: { model: "claude-sonnet-4-6", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0 },
      content: [{ type: "tool_use", name: "Bash", input: { command: "npm run build" } }] },
  };
  fs.appendFileSync(process.argv[2], JSON.stringify(e4) + "\n");
' "$REPO" "$SESS_FILE"
DELTA=$($AOS ingest)
echo "$DELTA" | grep -q "1 tool call(s)" && pass "ingest: delta ingest picks up only new lines" || fail "delta wrong: $DELTA"
[ "$(grep -c '"source":"ingested"' "$AOS_HOME/projects/demo/audit.jsonl")" = "$((LINES_BEFORE + 1))" ] || fail "delta wrote the wrong number of lines"

# --- the point of the pairing: ingested history is replayable policy evidence ---
# The ingested `git push origin main` was never gated (it predates AOS); a
# candidate that forbids pushes must surface it. (Single-quoted pattern —
# YAML double quotes process \s as an escape, and the regex must arrive intact.)
cat > "$WORK/no-push.yaml" <<'EOF'
tiers:
  forbidden:
    - pattern: '\bgit\s+push\b'
      reason: pushes go through the human
EOF
REPLAY=$($AOS policy test --file "$WORK/no-push.yaml" --since 30d)
echo "$REPLAY" | grep -q "git push origin release-branch" && pass "policy test: INGESTED history is replay evidence" || fail "ingested command not replayed: $REPLAY"
echo "$REPLAY" | grep -q "would DENY" || fail "no deny row for ingested push"

unset CLAUDE_CONFIG_DIR
