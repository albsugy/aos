# shellcheck shell=bash
# Supply-chain and robustness invariants: no network, no NUL bytes, clean entry point, doctor, fail-open.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

# --- supply-chain guard: the compiled CLI accesses the network in no way at all ---
# All outbound access lives in install.sh (registry resolve + sha-512 verify); the CLI
# self-updates by running that local, already-verified installer. So the bundle must
# neither shell out to curl nor call fetch/reach the registry directly.
# "curl" as a *policy vocabulary token* (the write-intent heuristic knows curl -o
# writes files) is fine — what must never appear is an exec/spawn that invokes it.
grep -Eq '(exec|spawn)\w*\([^)]{0,80}curl' "$ROOT/dist/aos.mjs" && fail "compiled bundle shells out to curl (possible curl|bash supply-chain risk)" || pass "no curl execution in compiled bundle — no remote-script execution"
grep -Eq 'fetch\(|registry\.npmjs\.org' "$ROOT/dist/aos.mjs" && fail "compiled bundle accesses the network (fetch/registry) — should delegate to install.sh" || pass "no network access in compiled bundle — installer owns all outbound I/O"

# --- no literal NUL bytes in the shipped sources ---
# A raw \x00 placeholder made policy.js and ui.html read as "data" to file(1)
# and choke UTF-8 tooling; the glob and markdown-fence sentinels use escapes
# (\u0000 / private-use) now — same runtime value, byte-safe source.
node -e '
  const fs = require("fs");
  for (const f of process.argv.slice(1)) {
    if (fs.readFileSync(f).includes(0)) { console.error(f + " contains a literal NUL byte"); process.exit(1); }
  }
' "$ROOT/src/policy.js" "$ROOT/src/console/ui.html" \
  && pass "sources: no literal NUL bytes (sentinels use escapes)" || fail "literal NUL byte in sources"

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
$AOS doctor 2>/dev/null | grep -q "hook command resolves" && pass "doctor: verifies the hook command actually resolves" || fail "hook resolution not checked"

# --- fail-open: a broken hook must never break the session, but must leave a trace ---
# Every hook swallows its own errors and exits 0 (a broken gate allows rather
# than blocks). That is deliberate — and it is exactly why the trace matters:
# without it, a crashing gate is indistinguishable from a quiet one.
BROKEN_OUT=$(printf 'not json' | $AOS hook pre-tool 2>&1)
[ -z "$BROKEN_OUT" ] && pass "fail-open: crashing hook emits no decision (Claude Code proceeds)" || fail "broken hook wrote output"
printf 'not json' | $AOS hook pre-tool >/dev/null 2>&1 && pass "fail-open: crashing hook still exits 0" || fail "broken hook exited non-zero"
for H in post-tool session-start session-end stop; do
  printf 'not json' | $AOS hook "$H" >/dev/null 2>&1 || fail "hook $H exited non-zero on malformed input"
done
pass "fail-open: every hook entry point survives malformed input"
grep -q '"hook":"pre-tool"' "$AOS_HOME/hook-errors.log" && pass "fail-open: the swallowed failure is logged" || fail "hook failure not logged"
# (captured, not piped: doctor exits 1 here and the suite runs under pipefail)
DOC_ERRS=$($AOS doctor 2>/dev/null || true)
echo "$DOC_ERRS" | grep -q "hook failure(s) logged" && pass "doctor: surfaces silently-failed hooks" || fail "doctor missed hook-errors.log"
$AOS doctor >/dev/null 2>&1 && fail "doctor exited 0 with logged hook failures" || pass "doctor: logged hook failures → exit 1"
rm -f "$AOS_HOME/hook-errors.log"

# --- silently-absent gate: the hook command no longer resolves ---
# The launcher ends in `|| true` so a moved or uninstalled aos can never break a
# session — which is precisely what makes it dangerous: every gate turns off and
# nothing looks wrong. Both halves are tested: the shell contract holds, and
# doctor detects the condition.
# shellcheck disable=SC2016  # $HOME must stay literal — the shell in the hook expands it
GONE_CMD='"$HOME/nonexistent-aos-launcher/aos" hook pre-tool 2>/dev/null || aos hook pre-tool 2>/dev/null || true'
GONE_OUT=$(env PATH=/nonexistent-bin /bin/bash -c "$GONE_CMD" </dev/null 2>&1)
[ -z "$GONE_OUT" ] && pass "missing binary: hook chain stays silent" || fail "missing-aos hook emitted output"
env PATH=/nonexistent-bin /bin/bash -c "$GONE_CMD" </dev/null >/dev/null 2>&1 \
  && pass "missing binary: hook chain exits 0 (session unbroken, gates OFF)" || fail "missing-aos hook broke the session"
# doctor is the only thing standing between that and an invisible loss of gating
GONE_REPO="$WORK/gone-repo"; mkdir -p "$GONE_REPO"
( cd "$GONE_REPO" && git init -q -b main && $AOS init --name goneproj >/dev/null )
# shellcheck disable=SC2016  # the $HOME inside the rewritten hook command is literal
node -e '
  const fs = require("fs"); const p = process.argv[1];
  const s = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const ev of Object.keys(s.hooks)) {
    for (const entry of s.hooks[ev]) {
      for (const h of entry.hooks || []) {
        h.command = h.command.replace(/^"[^"]+"/, "\"$HOME/nonexistent-aos-launcher/aos\"");
      }
    }
  }
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
' "$GONE_REPO/.claude/settings.json"
# a PATH with node but deliberately no aos — the `|| aos` fallback must not resolve either
NODE_ONLY="$WORK/node-only-bin"; mkdir -p "$NODE_ONLY"
ln -sf "$(command -v node)" "$NODE_ONLY/node"
GONE_DOC=$( cd "$GONE_REPO" && PATH="$NODE_ONLY" $AOS doctor 2>&1 || true )
echo "$GONE_DOC" | grep -q "SILENTLY OFF" && pass "doctor: detects wired-but-unresolvable hooks" || fail "unresolvable hook command not detected"
( cd "$GONE_REPO" && PATH="$NODE_ONLY" $AOS doctor >/dev/null 2>&1 ) && fail "doctor exited 0 with dead hook commands" || pass "doctor: dead hook command → exit 1"

