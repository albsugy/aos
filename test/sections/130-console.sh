# shellcheck shell=bash
# Console vocabulary, API, and security posture.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

# --- console: the review vocabulary must not drift from the gate ---
# The console counted `adversarial_review === 'present'`, a pre-0.11 value.
# When the gate started emitting clean/resolved/open/invalid/forced instead,
# every run finished under the new schema silently vanished from the coverage
# stat — including `forced`, the one an operator most needs to see. Nothing
# failed, the number just quietly stopped being true. So: every state the gate
# can stamp must be named somewhere in the console.
# shellcheck disable=SC2016  # the $ inside the node script must not expand here
node -e '
  const fs = require("fs");
  const ui = fs.readFileSync(process.argv[1], "utf8");
  const states = ["clean", "resolved", "open", "invalid", "absent", "forced", "not-required", "present"];
  const missing = states.filter((st) => !ui.includes(`"${st}"`) && !ui.includes(`\x27${st}\x27`));
  if (missing.length) {
    console.error("console does not handle review state(s): " + missing.join(", "));
    process.exit(1);
  }
' "$ROOT/src/console/ui.html" \
  && pass "console: handles every review state the gate can stamp" || fail "console review vocabulary drifted from review.js"

# --- console API + security ---
# extra run docs (findings.md, reviews/*.md) must be served alongside the canonical four
printf '# Findings\n\nRoot cause: flux capacitor.\n' > "$RUN_DIR/findings.md"
mkdir -p "$RUN_DIR/reviews"
printf '# Arch review\n\nLooks sound.\n' > "$RUN_DIR/reviews/arch.md"
# a review with a real finding, so the served payload is the parsed shape and
# not just an empty envelope
printf '%s' '{"reviewer":"skeptic subagent","scope":["src/demo.js"],"findings":[{"severity":"high","summary":"the gate never fires on the shell path","location":"src/demo.js:12","status":"fixed","resolution":"extended the check to redirects and tee"}]}' > "$RUN_DIR/review.json"
# a symlink planted in the run folder must NOT be served (file disclosure guard)
ln -s /etc/hosts "$RUN_DIR/leak.md"
# neither must a hardlink (same filesystem — link to AOS state)
ln "$AOS_HOME/registry.yaml" "$RUN_DIR/hardleak.md" 2>/dev/null || true
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
case "$DETAIL" in *'"findings.md"'*) pass "console API: extra run docs enumerated" ;; *) kill $CONSOLE_PID; fail "findings.md not served";; esac
case "$DETAIL" in *'flux capacitor'*) pass "console API: extra doc content served" ;; *) kill $CONSOLE_PID; fail "doc content missing";; esac
case "$DETAIL" in *'"reviews/arch.md"'*) pass "console API: reviews/ docs enumerated" ;; *) kill $CONSOLE_PID; fail "reviews doc not served";; esac
case "$DETAIL" in *'"leak.md"'*) kill $CONSOLE_PID; fail "symlinked doc was served (file disclosure)" ;; *) pass "console security: symlinked docs skipped";; esac
case "$DETAIL" in *'"hardleak.md"'*) kill $CONSOLE_PID; fail "hardlinked doc was served (file disclosure)" ;; *) pass "console security: hardlinked docs skipped";; esac
case "$DETAIL" in *'"dir_display"'*) pass "console API: home-relative display path present" ;; *) kill $CONSOLE_PID; fail "dir_display missing";; esac
# The adversarial review is the one quality claim the finish gate enforces, so
# the console must be able to show it — extraDocs only enumerates markdown, and
# review.json lived entirely outside the console until it was sent explicitly.
case "$DETAIL" in *'"review"'*) pass "console API: the run's adversarial review is served" ;; *) kill $CONSOLE_PID; fail "review not served";; esac
case "$DETAIL" in *'skeptic subagent'*) kill $CONSOLE_PID; fail "raw reviewer string leaked instead of parsed state";; *) : ;; esac
case "$DETAIL" in *'never fires on the shell path'*) pass "console API: review findings included" ;; *) kill $CONSOLE_PID; fail "review findings missing";; esac
# leverage_sample is what lets the console tell "no finished runs" apart from
# "too few to rate" — collapsing them made it report "no data" for projects
# that had finished runs.
case "$STATE" in *'"leverage_sample"'*) pass "console API: leverage sample exposed" ;; *) kill $CONSOLE_PID; fail "leverage_sample missing";; esac
PROJ=$(curl -s "http://127.0.0.1:$PORT/api/project?project=demo")
case "$PROJ" in *'"policy"'*) pass "console API: project detail";; *) kill $CONSOLE_PID; fail "console project detail";; esac
case "$PROJ" in *'"adversarial_review_mode"'*) pass "console API: review mode is the tri-state, not a boolean" ;; *) kill $CONSOLE_PID; fail "adversarial_review_mode missing";; esac
case "$PROJ" in *'"scope_gate"'*) pass "console API: the 0.11 guards are in the policy digest" ;; *) kill $CONSOLE_PID; fail "scope_gate missing from policy digest";; esac
case "$PROJ" in *'"protect_worktree"'*) : ;; *) kill $CONSOLE_PID; fail "protect_worktree missing from policy digest";; esac
# the runs table must be reachable without a mouse — an onclick <tr> is not
UI_HTML=$(curl -s "http://127.0.0.1:$PORT/")
case "$UI_HTML" in *'role="link"'*) pass "console UI: run rows expose a link role" ;; *) kill $CONSOLE_PID; fail "run rows have no role";; esac
case "$UI_HTML" in *"event.key==='Enter'"*) pass "console UI: run rows are keyboard-activated" ;; *) kill $CONSOLE_PID; fail "run rows are mouse-only";; esac
# Column order: the review cell must sit under the Review header. Inserting it
# one <td> too early shifted every value right and put review states under
# "Verify" — invisible to any assertion that only checks presence.
node -e '
  const ui = require("fs").readFileSync(process.argv[1], "utf8");
  // Scope to the row template — searching the whole file matches the
  // reviewCell() function declaration further down and always "passes".
  const row = /class="rowlink[\s\S]*?<\/tr>/.exec(ui);
  const head = /<th>Verify<\/th>\s*<th[^>]*>Review<\/th>/.test(ui);
  if (!row) { console.error("runs-table row template not found"); process.exit(1); }
  const v = row[0].indexOf("VERIFY_TIP"), r = row[0].indexOf("reviewCell(");
  if (v < 0 || r < 0) { console.error("verify/review cells not found in the row"); process.exit(1); }
  if (!head) { console.error("Review header does not follow Verify"); process.exit(1); }
  if (r < v) { console.error("review cell renders before the verify cell — every value shifts a column"); process.exit(1); }
' "$ROOT/src/console/ui.html" \
  && pass "console UI: the review column sits under its own header" || { kill $CONSOLE_PID; fail "review cell/header order mismatch"; }
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

