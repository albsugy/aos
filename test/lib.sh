# shellcheck shell=bash
# Assertion vocabulary and the helpers used by more than one section.
# Sourced by test/smoke.sh before any section runs; section-local helpers stay
# in their own section file.

pass() { echo "✅ $1"; }
fail() { echo "❌ $1"; exit 1; }

active_run_dir() {
  local project="${1:-demo}"
  echo "$AOS_HOME/projects/$project/runs/$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/$project/state.json")"
}

# `aos run finish` is gated on the adversarial review. Sections that aren't
# testing that gate satisfy it the way a real skeptic would — a hunt that
# found nothing. The gate itself is tested in 060-review-gate.sh.
review_active() {
  printf '%s' '{"reviewer":"skeptic subagent","scope":["src/demo.js","acceptance criteria"],"findings":[]}' \
    > "$(active_run_dir "${1:-demo}")/review.json"
}

# The PreToolUse gate's verdict for one tool call, as the runtime would see it:
# empty output means allow (the hook stays silent), JSON means ask or deny.
hook_out() {
  printf '%s' "$1" | $AOS hook pre-tool
}
