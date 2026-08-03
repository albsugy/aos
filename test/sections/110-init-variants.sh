# shellcheck shell=bash
# init --hooks-only, CLI robustness, context budgeting, and ecosystem-aware seeding.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

# --- init --hooks-only: the layer that works without invoking anything ---
HO_REPO="$WORK/hooks-only-repo"; mkdir -p "$HO_REPO"; (cd "$HO_REPO" && git init -q -b main)
(cd "$HO_REPO" && $AOS init --name hooksonly --hooks-only >/dev/null)
[ -d "$HO_REPO/.claude/skills" ] && fail "--hooks-only installed skills" || pass "init --hooks-only: no skills installed"
grep -q "hook pre-tool" "$HO_REPO/.claude/settings.json" && pass "init --hooks-only: hooks still wired" || fail "--hooks-only skipped hooks"
[ -f "$AOS_HOME/projects/hooksonly/policy.yaml" ] && pass "init --hooks-only: policy scaffolded (it IS the gate)" || fail "--hooks-only skipped policy"
[ -f "$AOS_HOME/projects/hooksonly/context/pack.md" ] && pass "init --hooks-only: context pack scaffolded (it IS the memory)" || fail "--hooks-only skipped pack"
(cd "$HO_REPO" && $AOS init --name hooksonly >/dev/null)
[ -d "$HO_REPO/.claude/skills" ] && pass "init: a later full init adds the pipeline skills" || fail "upgrade from hooks-only failed"

# --- CLI robustness: a value-less flag must not reach path.join as `true` ---
for SUB in "run session" "run review" "run state done"; do
  # shellcheck disable=SC2086  # SUB is a deliberate two-word subcommand
  OUT_BAREFLAG=$( (cd "$REPO" && $AOS $SUB --run </dev/null) 2>&1 || true )
  echo "$OUT_BAREFLAG" | grep -q "must be of type string" && fail "aos $SUB --run crashed on a bare flag"
done
pass "cli: --run with no value degrades instead of throwing a type error"
$AOS doctor >/dev/null 2>&1 || true   # doctor must never throw either
pass "cli: doctor survives a fully-populated home"

# --- context: template nudge, learnings overflow, budgeted pack ---
CTX_REPO="$WORK/ctx-repo"; mkdir -p "$CTX_REPO"
( cd "$CTX_REPO" && git init -q -b main && $AOS init --name ctxdemo >/dev/null )
CTXP="$AOS_HOME/projects/ctxdemo"
[ -f "$CTX_REPO/.claude/skills/aos-onboard/SKILL.md" ] && pass "init: aos-onboard skill installed" || fail "onboard skill missing"
( cd "$CTX_REPO" && $AOS context ) | grep -q "aos-onboard" && pass "context: template pack → onboard nudge" || fail "onboard nudge missing"
printf '# Context pack\n\nA real description of the project.\n' > "$CTXP/context/pack.md"
( cd "$CTX_REPO" && $AOS context ) | grep -q "aos-onboard" && fail "filled pack still nudges onboard" || pass "context: filled pack → no onboard nudge"
for i in $(seq 1 40); do echo "- learning $i" >> "$CTXP/learnings.md"; done
( cd "$CTX_REPO" && $AOS context ) | grep -q "auto-load" && pass "context: learnings overflow warned" || fail "overflow not warned"
node -e 'console.log("# Context pack\n\n" + "x".repeat(12000))' > "$CTXP/context/pack.md"
CTXBIG=$( cd "$CTX_REPO" && $AOS context )
echo "$CTXBIG" | grep -q "## Learnings" && pass "context: huge pack can't amputate learnings" || fail "learnings amputated by big pack"
echo "$CTXBIG" | grep -q "read context/pack.md" && pass "context: oversized pack truncated with pointer" || fail "pack not truncated"

# --- init: non-JS ecosystems seed required test contracts ---
GO_REPO="$WORK/go-repo"; mkdir -p "$GO_REPO"; printf 'module example.com/x\n' > "$GO_REPO/go.mod"
( cd "$GO_REPO" && git init -q -b main && $AOS init --name gox >/dev/null )
grep -q "command: go test" "$AOS_HOME/projects/gox/policy.yaml" && pass "init: go repo seeds go test contract" || fail "go contract missing"
PY_REPO="$WORK/py-repo"; mkdir -p "$PY_REPO"; printf '[project]\nname = "pyx"\n' > "$PY_REPO/pyproject.toml"
( cd "$PY_REPO" && git init -q -b main && $AOS init --name pyx >/dev/null )
grep -q "command: pytest" "$AOS_HOME/projects/pyx/policy.yaml" && pass "init: python repo seeds pytest contract" || fail "pytest contract missing"
MK_REPO="$WORK/mk-repo"; mkdir -p "$MK_REPO"; printf 'test:\n\ttrue\n' > "$MK_REPO/Makefile"
( cd "$MK_REPO" && git init -q -b main && $AOS init --name mkx >/dev/null )
grep -q "command: make test" "$AOS_HOME/projects/mkx/policy.yaml" && pass "init: Makefile test target seeds contract" || fail "make contract missing"

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
BARE_OUT=$( cd "$BARE_REPO" && git init -q -b main && $AOS init --name bare )
grep -q "one paragraph: purpose" "$AOS_HOME/projects/bare/context/pack.md" && pass "init: no signal → blank template" || fail "blank fallback missing"
echo "$BARE_OUT" | grep -q "Verification is EMPTY" && pass "init: warns loudly when verification is empty" || fail "empty verification not warned"

