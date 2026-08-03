# shellcheck shell=bash
# The Bash gate's adversarial surface: wrappers, working-tree guards, applet aliasing, write detection, self-protection.
#
# Sourced by test/smoke.sh in order — sections share the demo-project state
# built by the ones before them. Helpers: test/lib.sh.
# shellcheck disable=SC2015  # `check && pass || fail` is the assertion idiom
# shellcheck disable=SC2154  # AOS/REPO/AOS_HOME and friends come from the driver

# --- hardened Bash gates (defaults merge in even with a partial policy.yaml) ---
IN_RMFR='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"sudo rm -fr /"},"session_id":"s1"}'
IN_RMSTAR='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"rm -rf /*"},"session_id":"s1"}'
IN_FWL='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"git push --force-with-lease origin main"},"session_id":"s1"}'
IN_DOCDEPLOY='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"cat docs/deploy.md"},"session_id":"s1"}'
IN_RUNDEPLOY='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"./deploy prod"},"session_id":"s1"}'
hook_out "$IN_RMFR"   | grep -q '"permissionDecision":"deny"' && pass "gate: rm -fr / → deny (flag permutation)" || fail "rm -fr bypass"
hook_out "$IN_RMSTAR" | grep -q '"permissionDecision":"deny"' && pass "gate: rm -rf /* → deny (glob target)" || fail "rm -rf /* bypass"
hook_out "$IN_FWL"    | grep -q '"permissionDecision":"ask"'  && pass "gate: force-with-lease → ask, not deny" || fail "force-with-lease verdict"
[ -z "$(hook_out "$IN_DOCDEPLOY")" ] && pass "gate: cat docs/deploy.md → allow (no false positive)" || fail "deploy false positive"
hook_out "$IN_RUNDEPLOY" | grep -q '"permissionDecision":"ask"' && pass "gate: ./deploy → ask" || fail "deploy invocation not gated"

# evasive git-push forms: global options between git and the subcommand.
# (FORCE_FLAG indirection keeps this script itself clean under the script-content scan.)
FORCE_FLAG="--""force"
IN_GITC='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"git -C . push origin main"},"session_id":"s1"}'
IN_GITCF='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"git -C . push '$FORCE_FLAG' origin main"},"session_id":"s1"}'
IN_STASH='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"git stash push"},"session_id":"s1"}'
hook_out "$IN_GITC"  | grep -q '"permissionDecision":"ask"'  && pass "gate: git -C . push → ask (evasive form)" || fail "git -C push bypass"
hook_out "$IN_GITCF" | grep -q '"permissionDecision":"deny"' && pass "gate: git -C . push -force → deny" || fail "git -C forced push bypass"
[ -z "$(hook_out "$IN_STASH")" ] && pass "gate: git stash push → allow (no false positive)" || fail "git stash push gated"

# Bash writes to protected targets get the same ask the file tools would
IN_BASHSET='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"echo {} > .claude/settings.json"},"session_id":"s1"}'
IN_BASHHOOKS='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"cp x .git/hooks/pre-commit"},"session_id":"s1"}'
IN_BASHPOLICY='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"echo x > '$AOS_HOME'/projects/demo/policy.yaml"},"session_id":"s1"}'
IN_BASHSCRATCH='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"echo hello > scratch.txt"},"session_id":"s1"}'
hook_out "$IN_BASHSET"    | grep -q '"permissionDecision":"ask"' && pass "gate: bash write to .claude/settings.json → ask" || fail "bash settings write bypass"
hook_out "$IN_BASHHOOKS"  | grep -q '"permissionDecision":"ask"' && pass "gate: bash write to .git/hooks → ask" || fail "bash git-hook write bypass"
hook_out "$IN_BASHPOLICY" | grep -q '"permissionDecision":"ask"' && pass "gate: bash write to policy.yaml → ask" || fail "bash policy write bypass"
[ -z "$(hook_out "$IN_BASHSCRATCH")" ] && pass "gate: ordinary bash write → allow (no plan gate active)" || fail "ordinary bash write gated"
IN_HOOKSPATH='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"git config core.hooksPath /tmp/hooks"},"session_id":"s1"}'
# shellcheck disable=SC2016  # the $(...) must reach the gate literally, not expand here
IN_SUBRM='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"echo $(rm -rf /)"},"session_id":"s1"}'
IN_QUOTED_FORCE='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"echo \"git push '$FORCE_FLAG'\""},"session_id":"s1"}'
hook_out "$IN_HOOKSPATH" | grep -q '"permissionDecision":"ask"'  && pass "gate: git config core.hooksPath → ask (hook rewiring)" || fail "hooksPath rewire not gated"
hook_out "$IN_SUBRM"     | grep -q '"permissionDecision":"deny"' && pass "gate: recursive root delete in command substitution → deny" || fail "subshell rm bypass"
hook_out "$IN_QUOTED_FORCE" | grep -q '"permissionDecision":"ask"' && pass "gate: forbidden string inside quotes → ask, not deny" || fail "quoted mention still hard-denied"

# --- working-tree guard: the destructive-git accident that actually happens ---
# None of these names the file it overwrites, so neither the regex tiers nor
# the write heuristic saw them before. All are `ask`, never deny.
bash_in() { echo '{"cwd":"'"$REPO"'","tool_name":"Bash","tool_input":{"command":"'"$1"'"},"session_id":"s1"}'; }
# `git checkout X` is a branch switch or a destructive path restore depending on
# what X IS, so the guard asks the working tree rather than guessing from the
# name. Give it a tree to ask about.
mkdir -p "$REPO/src" && : > "$REPO/src/app.js" && : > "$REPO/Makefile"
for CMD in "git reset --hard" "git clean -fdx" "git checkout -- ." "git checkout ." \
           "git restore src/" "git switch --discard-changes main" "git branch -D feat" \
           "git stash drop" "npm test && git checkout -- ." "git -C . reset --hard" \
           "git rm -r src/" "git rm -f x" "git worktree remove --force wt" \
           "git submodule deinit -f mod" "sudo git -C /repo clean -fdx" "FOO=1 env git clean -f" \
           "git checkout src/app.js" "git checkout HEAD src/app.js" "git branch -Df feat" \
           "git stash -q drop" "sudo -E git reset --hard" "sudo -u root git clean -fd" \
           "sudo -i git clean -fdx" "env -u FOO git reset --hard" "time -p git clean -f" \
           "xargs -n 1 git checkout --" "nohup git reset --merge" \
           "git checkout Makefile" "git checkout HEAD src/app.js 2>&1" "git checkout src"; do
  hook_out "$(bash_in "$CMD")" | grep -q '"permissionDecision":"ask"' \
    || fail "worktree guard missed: $CMD"
done
pass "gate: destructive git → ask (reset/clean/checkout/restore/switch/branch/stash)"
# Non-destructive neighbours must stay silent or the guard is unusable
for CMD in "git checkout main" "git checkout -b feature" "git restore --staged file.js" \
           "git reset --soft HEAD~1" "git stash" "git status" "git diff HEAD" \
           "git rm file.txt" "git rm --cached -r x" "git worktree remove wt" \
           "cat notes-about-git-reset--hard.md" "git checkout feature/login" "git checkout v1.0.0" \
           "git checkout -b feature main" "git checkout @{-1}" \
           "git checkout main 2>&1" "git checkout main >/dev/null" "git checkout -q main >/dev/null 2>&1"; do
  [ -z "$(hook_out "$(bash_in "$CMD")")" ] || fail "worktree guard false positive: $CMD"
done
pass "gate: safe git → allow (branch switch, --staged restore, soft reset, plain stash)"
# Name shape cannot decide branch-vs-path — a branch may be called fix/typo.md
# and a directory may be called src. Existence in the working tree decides.
for CMD in "git checkout fix/typo.md" "git checkout release/2.0.1" "git checkout deleted-file.js"; do
  [ -z "$(hook_out "$(bash_in "$CMD")")" ] || fail "branch-shaped ref gated as a path: $CMD"
done
pass "gate: a ref that names nothing on disk is a ref, whatever it looks like"
# The guard is opt-out, and the opt-out actually works
cp "$AOS_HOME/projects/demo/policy.yaml" "$WORK/policy-backup.yaml"
printf 'version: 1\ntiers:\n  protect_worktree: false\n' > "$AOS_HOME/projects/demo/policy.yaml"
[ -z "$(hook_out "$(bash_in "git reset --hard")")" ] \
  && pass "gate: protect_worktree false disables the guard" || fail "protect_worktree opt-out ignored"
cp "$WORK/policy-backup.yaml" "$AOS_HOME/projects/demo/policy.yaml"
# Destructive git counts as a write, so it can't sidestep the protected paths
hook_out "$(bash_in "git checkout -- .claude/settings.json")" | grep -q '"permissionDecision":"ask"' \
  && pass "gate: git checkout of .claude/settings.json → ask (write path)" || fail "git checkout hook-disarm bypass"

# --- write detection: GNU-prefixed and busybox applets are the same programs ---
# `gsed -i` is the macOS/Homebrew spelling; treating it as a non-writer made it
# a bypass for every check built on commandWritesFiles. Probed through the
# protected-path gate, which only fires on commands that write.
for CMD in "gsed -i s/a/b/ .claude/settings.json" "busybox sed -i s/a/b/ .claude/settings.json" \
           "gcp evil .claude/settings.json"; do
  hook_out "$(bash_in "$CMD")" | grep -q '"permissionDecision":"ask"' || fail "alias write missed: $CMD"
done
pass "writes: gsed/busybox sed/gcp reach the protected-path gate"
# ...without folding tools that merely start with g into their stripped names
for CMD in "grep -i settings .claude/settings.json" "gh pr view 1"; do
  [ -z "$(hook_out "$(bash_in "$CMD")")" ] || fail "alias false positive: $CMD"
done
pass "writes: grep/gh not mistaken for GNU-prefixed writers"

# wrapper/eval bypasses: the wrapper is transparent, so the wrapped command
# must get the bare command's verdict. nice/timeout/doas/stdbuf/setsid each
# used to read as an unknown program and sail past every structural check.
for CMD in "nice rm -r -f ~" "nice -n 10 rm -rf /" "timeout 30 rm -rf /" "timeout -k 5 30 rm -rf /" \
           "doas rm -rf /" "doas -u root rm -rf /"; do
  hook_out "$(bash_in "$CMD")" | grep -q '"permissionDecision":"deny"' || fail "wrapper rm bypass: $CMD"
done
pass "gate: nice/timeout/doas-wrapped rm -rf → deny (bare command's verdict)"
for CMD in "stdbuf -o0 git clean -fdx" "stdbuf -o 0 git reset --hard" \
           "setsid git reset --hard" "setsid -w git clean -fd" "doas -u root git reset --hard"; do
  hook_out "$(bash_in "$CMD")" | grep -q '"permissionDecision":"ask"' || fail "wrapper git bypass: $CMD"
done
hook_out "$(bash_in "timeout 10 git push $FORCE_FLAG")" | grep -q '"permissionDecision":"deny"' \
  || fail "timeout-wrapped force-push not denied"
hook_out "$(bash_in "timeout 10 git push origin main")" | grep -q '"permissionDecision":"ask"' \
  || fail "timeout-wrapped push not gated"
pass "gate: timeout/stdbuf/setsid-wrapped git → gated like the bare form"
# harmless wrapped commands must stay silent or the wrapper table is unusable
for CMD in "nice ls" "timeout 30 ls" "setsid ls" "doas ls" "stdbuf -o0 ls"; do
  [ -z "$(hook_out "$(bash_in "$CMD")")" ] || fail "wrapper false positive: $CMD"
done
pass "gate: wrapped read-only commands → allow (no wrapper false positives)"
# eval's arguments ARE a command line; quote-stripping used to erase the
# evidence before any check saw it. The inner command is evaluated through the
# same path, so `eval "ls"` must not prompt either.
IN_EVALRM='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"eval \"rm -rf /\""},"session_id":"s1"}'
IN_EVALFP='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"eval \"git push '$FORCE_FLAG'\""},"session_id":"s1"}'
IN_EVALNEST='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"eval \"eval \\\"rm -rf /\\\"\""},"session_id":"s1"}'
IN_EVALLS='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"eval \"ls\""},"session_id":"s1"}'
hook_out "$IN_EVALRM"   | grep -q '"permissionDecision":"deny"' && pass "gate: eval \"rm -rf /\" → deny (inner command evaluated)" || fail "eval rm bypass"
hook_out "$IN_EVALFP"   | grep -q '"permissionDecision":"deny"' && pass "gate: eval force-push → deny" || fail "eval force-push bypass"
hook_out "$IN_EVALNEST" | grep -q '"permissionDecision":"deny"' && pass "gate: nested eval with escaped quotes → deny" || fail "nested eval bypass"
[ -z "$(hook_out "$IN_EVALLS")" ] && pass "gate: eval \"ls\" → allow (no eval false positive)" || fail "harmless eval gated"
# bash/sh/zsh/dash -c is the same hole wearing a different flag: the payload
# goes through the full gate and gets the bare command's verdict
IN_BASHC_RM='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"bash -c \"rm -rf /\""},"session_id":"s1"}'
IN_BASHLC='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"bash -lc \"git reset --hard\""},"session_id":"s1"}'
IN_ZSHC_PUSH='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"zsh -c \"git push origin main\""},"session_id":"s1"}'
IN_DASHC_LS='{"cwd":"'$REPO'","tool_name":"Bash","tool_input":{"command":"dash -c \"ls\""},"session_id":"s1"}'
hook_out "$IN_BASHC_RM"  | grep -q '"permissionDecision":"deny"' && pass "gate: bash -c \"rm -rf /\" → deny (payload through the full gate)" || fail "bash -c rm bypass"
hook_out "$(bash_in "sh -c 'git push $FORCE_FLAG'")" | grep -q '"permissionDecision":"deny"' && pass "gate: sh -c force-push → deny (bare command's verdict)" || fail "sh -c force-push bypass"
hook_out "$IN_BASHLC"    | grep -q '"permissionDecision":"ask"'  && pass "gate: bash -lc destructive git → ask (cluster flag)" || fail "bash -lc bypass"
hook_out "$IN_ZSHC_PUSH" | grep -q '"permissionDecision":"ask"'  && pass "gate: zsh -c push → ask" || fail "zsh -c push bypass"
[ -z "$(hook_out "$IN_DASHC_LS")" ] && pass "gate: dash -c \"ls\" → allow (no -c false positive)" || fail "harmless -c payload gated"
# `git -c core.hooksPath=…` is the same hook rewiring as `git config`, one
# invocation at a time — and the word "config" never appears in it
hook_out "$(bash_in "git -c core.hooksPath=/tmp/x push")" | grep -q '"permissionDecision":"ask"' \
  && pass "gate: git -c core.hooksPath → ask (per-command hook rewiring)" || fail "git -c hooksPath bypass"
[ -z "$(hook_out "$(bash_in "git -c user.email=a@b.c commit -m x")")" ] \
  && pass "gate: git -c with an ordinary key → allow" || fail "git -c false positive"

# --- file-write gates: self-protection + script laundering ---
IN_SETTINGS='{"cwd":"'$REPO'","tool_name":"Write","tool_input":{"file_path":"'$REPO'/.claude/settings.json","content":"{}"},"session_id":"s1"}'
IN_POLICY='{"cwd":"'$REPO'","tool_name":"Edit","tool_input":{"file_path":"'$AOS_HOME'/projects/demo/policy.yaml","new_string":"tiers: {}"},"session_id":"s1"}'
IN_LAUNDER='{"cwd":"'$REPO'","tool_name":"Write","tool_input":{"file_path":"'$REPO'/run.sh","content":"#!/bin/bash\ngit push --force origin main"},"session_id":"s1"}'
IN_OKWRITE='{"cwd":"'$REPO'","tool_name":"Write","tool_input":{"file_path":"'$REPO'/src/ok.js","content":"export {}"},"session_id":"s1"}'
hook_out "$IN_SETTINGS" | grep -q '"permissionDecision":"ask"'  && pass "gate: write .claude/settings.json → ask" || fail "settings write not gated"
hook_out "$IN_POLICY"   | grep -q '"permissionDecision":"ask"'  && pass "gate: write policy.yaml → ask (self-protection)" || fail "policy write not gated"
# forging a sign-off ticket is forging a human's approval to close a run
IN_TICKET='{"cwd":"'$REPO'","tool_name":"Write","tool_input":{"file_path":"'$AOS_HOME'/projects/demo/signoff.json","content":"{}"},"session_id":"s1"}'
hook_out "$IN_TICKET"   | grep -q '"permissionDecision":"ask"'  && pass "gate: write signoff.json → ask (no forged sign-off)" || fail "signoff ticket forgeable"
# self-protection must survive a wrapper's own flags — `sudo -E` used to make
# tokens[0] a flag, so nothing downstream saw sed/git at all
for CMD in "sudo -E sed -i s/a/b/ .claude/settings.json" "sudo -E git checkout -- .claude/settings.json"; do
  hook_out "$(bash_in "$CMD")" | grep -q '"permissionDecision":"ask"' || fail "wrapper-flag bypass: $CMD"
done
pass "gate: sudo -E <write to a protected path> → ask (wrapper flags skipped)"
hook_out "$IN_LAUNDER"  | grep -q '"permissionDecision":"deny"' && pass "gate: script with forbidden command → deny (no laundering)" || fail "script laundering not caught"
[ -z "$(hook_out "$IN_OKWRITE")" ] && pass "gate: normal file write → allow (silent)" || fail "normal write gated"

