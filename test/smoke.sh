#!/usr/bin/env bash
# AOS end-to-end smoke test. Runs against an isolated AOS_HOME and a throwaway repo.
#
# This file is the driver: it builds the sandbox, then sources test/sections/*.sh
# in a fixed order. The order is load-bearing — sections share the demo project
# and its run history, so a section reads the state the ones before it left.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Override to test the compiled bundle: AOS_BIN="node $ROOT/dist/aos.mjs" bash test/smoke.sh
AOS="${AOS_BIN:-node $ROOT/bin/aos.js}"

# Bundle mode only: refuse to run against a stale dist. A green suite against
# an old bundle proves nothing about the code that was just changed, and the
# failure mode is invisible — pass marks on behavior that is no longer shipped.
if [ -n "${AOS_BIN:-}" ]; then
  STALE=$(find "$ROOT/src" "$ROOT/scripts/build.mjs" -type f -newer "$ROOT/dist/aos.mjs" -print -quit 2>/dev/null || true)
  if [ ! -f "$ROOT/dist/aos.mjs" ] || [ -n "$STALE" ]; then
    echo "❌ dist is stale ($STALE), run npm run build"
    exit 1
  fi
fi
WORK="$(mktemp -d)"
export AOS_HOME="$WORK/aos-home"
# The suite runs headless; sign-off commands (approve / state done|shipped)
# require a TTY unless this CI escape hatch is set. The refusal itself is
# tested explicitly by unsetting it for one call.
export AOS_ALLOW_HEADLESS_APPROVE=1
REPO="$WORK/demo-repo"
mkdir -p "$REPO"

# shellcheck source=test/lib.sh
. "$ROOT/test/lib.sh"

# Sections, in the order they must run. Listed explicitly rather than globbed:
# the order is part of the fixture, so adding a section is a deliberate edit
# here, not a filename accident.
SECTIONS=(
  010-init.sh
  020-verify-export.sh
  030-gates.sh
  040-plan-scope.sh
  050-tokens-cost.sh
  060-review-gate.sh
  070-learnings.sh
  080-signoff.sh
  090-provenance-scope.sh
  100-dryrun-cost.sh
  110-init-variants.sh
  120-supply-chain.sh
  130-console.sh
  140-rotation-registry.sh
  145-audit-chain.sh
  150-policy-ci.sh
  170-executable-review.sh
)

# A section file that exists but isn't listed above would be silently skipped —
# a whole subsystem going untested with a green suite. Catch it here.
for f in "$ROOT"/test/sections/*.sh; do
  name="$(basename "$f")"
  case " ${SECTIONS[*]} " in
    *" $name "*) ;;
    *) fail "test/sections/$name is not listed in smoke.sh — add it to SECTIONS" ;;
  esac
done

cd "$REPO"
git init -q -b main

for name in "${SECTIONS[@]}"; do
  [ -f "$ROOT/test/sections/$name" ] || fail "missing section: test/sections/$name"
  # shellcheck disable=SC1090  # the path is built from the list above, not user input
  . "$ROOT/test/sections/$name"
done

echo ""
echo "All smoke tests passed."
rm -rf "$WORK"
