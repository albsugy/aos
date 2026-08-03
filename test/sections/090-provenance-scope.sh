# shellcheck shell=bash
# Run provenance (branch, links, files touched) and the scope gate.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

# --- run provenance: branch, ticket link, PR link, files touched ---
# Reviewing a run means reading its diff. Without a branch and a PR the console
# can only describe the change, so the branch is read off .git/HEAD at start
# (no subprocess — the CLI shells out for contracts and nothing else).
PROV_REPO="$WORK/prov-repo"; mkdir -p "$PROV_REPO/src"
(cd "$PROV_REPO" && git init -q -b main && git checkout -q -b feat/limits && $AOS init --name prov >/dev/null)
(cd "$PROV_REPO" && $AOS run start --ticket "https://linear.app/acme/issue/LIN-482" --title "Harden upload" >/dev/null)
PROV_RUN=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).activeRun)' "$AOS_HOME/projects/prov/state.json")
PROV_DIR="$AOS_HOME/projects/prov/runs/$PROV_RUN"
prov_meta() { node -e 'const m=require(process.argv[1]);console.log(m[process.argv[2]])' "$PROV_DIR/meta.json" "$1"; }
[ "$(prov_meta branch)" = "feat/limits" ] && pass "provenance: branch read from .git/HEAD at run start" || fail "branch not captured ($(prov_meta branch))"
[ "$(prov_meta ticket)" = "LIN-482" ] && pass "provenance: a ticket URL still yields a readable run id" || fail "ticket id not derived"
case "$PROV_RUN" in *lin-482*) pass "provenance: run folder named from the ticket, not the URL";; *) fail "run id from URL: $PROV_RUN";; esac
[ "$(prov_meta ticket_url)" = "https://linear.app/acme/issue/LIN-482" ] && pass "provenance: the source ticket link is kept" || fail "ticket_url lost"
# a PR cannot be auto-detected (no network calls), so it is linked explicitly
(cd "$PROV_REPO" && $AOS run link --pr "https://github.com/acme/app/pull/91" >/dev/null)
[ "$(prov_meta pr_url)" = "https://github.com/acme/app/pull/91" ] && pass "provenance: PR link attached" || fail "pr_url not stored"
# a rejected link must leave NOTHING behind — validating inside the mutator
# persisted the fields that passed and then threw, with no audit line
(cd "$PROV_REPO" && $AOS run link --pr "ftp://x/y" --branch other-branch >/dev/null 2>&1) && fail "ftp URL accepted" || true
[ "$(prov_meta branch)" = "feat/limits" ] && pass "provenance: a rejected link applies nothing at all" || fail "partial link write ($(prov_meta branch))"
# a valueless flag must not report success while linking nothing
OUT_BARE=$( (cd "$PROV_REPO" && $AOS run link --pr) 2>&1 || true )
echo "$OUT_BARE" | grep -q "Nothing to link" && pass "provenance: --pr with no value is refused, not silently ignored" || fail "bare --pr reported success"
# a url that would become a click target in the console must never be stored
(cd "$PROV_REPO" && $AOS run link --pr "javascript:alert(1)" >/dev/null 2>&1) && fail "javascript: URL accepted" || pass "provenance: non-http(s) URLs refused"
[ "$(prov_meta pr_url)" = "https://github.com/acme/app/pull/91" ] && pass "provenance: a refused link leaves the old one intact" || fail "rejected url clobbered pr_url"
# files touched are reconstructed from the audit, repo-relative, excluding the
# run's own bookkeeping writes
printf '%s' '{"cwd":"'"$PROV_REPO"'","tool_name":"Bash","tool_input":{"command":"aos run start --ticket LIN-482"},"session_id":"sP"}' | $AOS hook post-tool
printf '%s' '{"cwd":"'"$PROV_REPO"'","tool_name":"Write","tool_input":{"file_path":"'"$PROV_REPO"'/src/upload.js"},"session_id":"sP"}' | $AOS hook post-tool
printf '%s' '{"cwd":"'"$PROV_REPO"'","tool_name":"Edit","tool_input":{"file_path":"'"$PROV_DIR"'/plan.md"},"session_id":"sP"}' | $AOS hook post-tool
printf '%s' '{"cwd":"'"$PROV_REPO"'","tool_name":"Bash","tool_input":{"command":"echo x > src/other.js"},"session_id":"sP"}' | $AOS hook post-tool
review_active prov
(cd "$PROV_REPO" && $AOS run finish >/dev/null)
node -e 'const m=require(process.argv[1]);process.exit(JSON.stringify(m.files)===JSON.stringify(["src/upload.js"])?0:1)' "$PROV_DIR/meta.json" \
  && pass "provenance: files touched are repo-relative and exclude run bookkeeping" || fail "files wrong: $(prov_meta files)"
[ "$(prov_meta bash_writes)" = "1" ] && pass "provenance: shell writes are counted, not guessed at" || fail "bash_writes wrong ($(prov_meta bash_writes))"
# a tracker URL with a stray percent is legal and must not take the command down
PCT_REPO="$WORK/pct-repo"; mkdir -p "$PCT_REPO"
(cd "$PCT_REPO" && git init -q -b main && $AOS init --name pct >/dev/null)
(cd "$PCT_REPO" && $AOS run start --ticket "https://jira.example.com/browse/AB-1?done=50%" >/dev/null 2>&1) \
  && pass "provenance: a malformed percent in a ticket URL does not crash run start" || fail "run start died on a percent"

# --- scope gate: the plan declares its files, drift asks ---
# Self-activating: a plan with no Files section gates nothing, so no existing
# project changes behaviour. Declaring the section is the opt-in.
SCOPE_REPO="$WORK/scope-repo"; mkdir -p "$SCOPE_REPO/src" "$SCOPE_REPO/docs"
(cd "$SCOPE_REPO" && git init -q -b main && $AOS init --name scoped >/dev/null)
(cd "$SCOPE_REPO" && $AOS run start --ticket "LIN-SC" >/dev/null)
SCOPE_RUN_DIR=$(active_run_dir scoped)
scope_write() {
  printf '%s' '{"cwd":"'"$SCOPE_REPO"'","tool_name":"Write","tool_input":{"file_path":"'"$SCOPE_REPO"'/'"$1"'","content":"x"},"session_id":"sV"}' | $AOS hook pre-tool
}
[ -z "$(scope_write src/anything.js)" ] && pass "scope: no plan.md → nothing gated" || fail "scope gated without a plan"
cat > "$SCOPE_RUN_DIR/plan.md" <<'PLAN'
# Plan
## Approach
Tighten the gate.
## Files
- `src/gate.js` — extend the check to Bash redirects
- src/policy.js
- docs/ (the tier table)
- test/**/*.sh
- Add tests: test/labelled.sh
- Do not touch config/production.yaml
- No changes to src/untouchable.js
- Add a helper for flag clusters
## Risks
None worth noting.
PLAN
[ -z "$(scope_write src/gate.js)" ] && pass "scope: declared file → allow" || fail "declared file gated"
[ -z "$(scope_write docs/tiers.md)" ] && pass "scope: file under a declared directory → allow" || fail "declared directory gated"
[ -z "$(scope_write test/deep/x.sh)" ] && pass "scope: glob match → allow" || fail "declared glob gated"
scope_write src/other.js | grep -q '"permissionDecision":"ask"' && pass "scope: undeclared file → ask" || fail "scope drift not gated"
scope_write src/other.js | grep -q "outside the scope plan.md declared" && pass "scope: reason names the plan and the declared list" || fail "scope reason unhelpful"
# a labelled path (`Add tests: test/x.sh`) is a real declaration, not prose
[ -z "$(scope_write test/labelled.sh)" ] && pass "scope: 'Label: path' lines still count as declared" || fail "labelled path dropped"
# ...but prose that FORBIDS a file must never be read as declaring it — a scope
# gate that grants what the plan excludes is worse than no scope gate at all
for CMD in config/production.yaml src/untouchable.js; do
  scope_write "$CMD" | grep -q '"permissionDecision":"ask"' || fail "negation prose granted scope: $CMD"
done
pass "scope: 'Do not touch X' does not declare X"
# the repo-relative path comes from the REPO root, not the session's cwd — a
# session started in a subdirectory used to invert the gate entirely
mkdir -p "$SCOPE_REPO/packages/web"
scope_sub() {
  printf '%s' '{"cwd":"'"$SCOPE_REPO"'/packages/web","tool_name":"Write","tool_input":{"file_path":"'"$SCOPE_REPO"'/'"$1"'","content":"x"},"session_id":"sV"}' | $AOS hook pre-tool
}
[ -z "$(scope_sub src/gate.js)" ] && pass "scope: declared file allowed from a subdirectory session" || fail "subdir session flagged a declared file"
scope_sub src/other.js | grep -q '"permissionDecision":"ask"' && pass "scope: drift still caught from a subdirectory session" || fail "subdir session missed scope drift"
# writes into the run folder and project memory stay open
printf '%s' '{"cwd":"'"$SCOPE_REPO"'","tool_name":"Write","tool_input":{"file_path":"'"$SCOPE_RUN_DIR"'/outcome.md","content":"x"},"session_id":"sV"}' | $AOS hook pre-tool \
  | grep -q 'plan-scope' && fail "run folder gated by scope" || pass "scope: the run's own files stay writable"
# and the gate is switchable
printf 'version: 1\nscope_gate: false\n' > "$AOS_HOME/projects/scoped/policy.yaml"
[ -z "$(scope_write src/other.js)" ] && pass "scope: scope_gate false disables it" || fail "scope_gate opt-out ignored"

