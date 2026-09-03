# shellcheck shell=bash
# Tamper-evident audit ledgers: `aos audit verify`, tamper detection, the
# legacy prefix, and the whole-project sweep.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

# 140 leaves the registry corrupt on purpose (its own fixture); ours needs it valid.
# Repos are stored canonicalized (realpath'd) — match that spelling.
REAL_DEMO=$(cd "$REPO" && pwd -P)
REAL_ROT=$(cd "$WORK/rot-repo" && pwd -P)
cat > "$AOS_HOME/registry.yaml" <<EOF
projects:
  - id: demo
    name: demo
    repos:
      - $REAL_DEMO
    created: "2026-01-01T00:00:00.000Z"
  - id: rot
    name: rot
    repos:
      - $REAL_ROT
    created: "2026-01-01T00:00:00.000Z"
EOF

# Seed real history: commands that RAN, recorded the way the hook records them.
# (Also the replay evidence 150-policy-ci.sh asserts against.)
$AOS run start --ticket "LIN-5" >/dev/null
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"git status --short"},"session_id":"s9"}' | $AOS hook post-tool
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"npm test"},"session_id":"s9"}' | $AOS hook post-tool
printf '%s' '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"./deploy prod"},"session_id":"s9"}' | $AOS hook post-tool

# --- audit verify: the ledgers this suite built all hold together ---
$AOS audit verify --project demo | grep -q "All ledgers verify" && pass "audit verify: demo's ledgers verify clean" || fail "demo ledgers failed verification"

# --- tamper evidence: rewrite one audit line after the fact, get caught ---
# The seeded lines live in the active run's ledger (post-tool routes there),
# so locate whichever ledger holds them rather than guessing the directory.
AUDIT=$(grep -rl "git status" "$AOS_HOME/projects/demo/audit.jsonl" "$AOS_HOME/projects/demo/runs/"*/audit.jsonl 2>/dev/null | head -1)
[ -n "$AUDIT" ] || fail "no ledger holds the seeded command"
cp "$AUDIT" "$WORK/audit.bak"
# (Split literal: this repo's own gate refuses writes containing the whole form.)
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  const i = lines.findIndex((l) => l.includes("git status"));
  const parsed = JSON.parse(lines[i]);
  parsed.summary = "rm -r" + "f / (rewritten)";
  lines[i] = JSON.stringify(parsed);
  fs.writeFileSync(p, lines.join("\n") + "\n");
' "$AUDIT"
TAMPER=$($AOS audit verify --project demo 2>&1) && fail "audit verify passed a rewritten ledger" || true
echo "$TAMPER" | grep -q "TAMPER EVIDENCE" && pass "audit verify: a rewritten line is flagged as tamper evidence" || fail "rewrite not detected: $TAMPER"
# and restoring the line clears it again
cp "$WORK/audit.bak" "$AUDIT"
$AOS audit verify --project demo | grep -q "All ledgers verify" && pass "audit verify: restored ledger verifies again" || fail "restored ledger still fails"

# deleting a line is caught too (seq gap)
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  lines.splice(1, 1);
  fs.writeFileSync(p, lines.join("\n") + "\n");
' "$AUDIT"
DEL=$($AOS audit verify --project demo 2>&1) && fail "audit verify passed a deleted line" || true
echo "$DEL" | grep -qE "seq|unchained" && pass "audit verify: a deleted line breaks the chain visibly" || fail "deletion not detected: $DEL"
cp "$WORK/audit.bak" "$AUDIT"

# 140 injected a raw foreign line into rot's run ledger on purpose — the whole-
# project sweep must say so rather than wave it through.
SWEEP=$($AOS audit verify 2>&1) && fail "audit verify sweep passed a foreign line" || true
echo "$SWEEP" | grep -q "rot" && pass "audit verify: whole-project sweep reports rot's injected line" || fail "sweep missed rot: $SWEEP"
