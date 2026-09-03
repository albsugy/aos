import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { aosHome, projectDir, readIfExists } from './paths.js';

export const DEFAULT_POLICY = {
  version: 1,
  plan_gate: 'auto',
  // Learnings capture: SessionEnd debt marker + Stop-hook extraction nudge.
  // `false` turns both off; the `run finish` warning stays (it's advice, not a gate).
  learnings_capture: true,
  // Review capture: the Stop hook asks a session whose run is at
  // awaiting-review to present it and propose the close, so the sign-off
  // happens in-session instead of waiting on a dashboard visit.
  review_capture: true,
  // Scope gate: when a run's plan.md declares a Files section, writes outside
  // it ask. Self-activating — no declaration, no gating — so `false` is only
  // needed to switch it off for a project that does declare scope.
  scope_gate: true,
  // Dry run: record every gate decision to the audit and let the tool through
  // anyway, so a policy can be tuned against a real workflow before it starts
  // enforcing. `aos doctor` fails while this is on — a forgotten dry_run is a
  // project that believes it is guarded and is not.
  dry_run: false,
  tiers: {
    // Built-in structural guard over git subcommands that destroy uncommitted
    // work (see destructiveGit). Gated at `ask`; false disables it.
    protect_worktree: true,
    forbidden: [
      // --force-with-lease falls through to the gated `git push` rule instead.
      // (?<=[\s'"]) also catches quoted flags; -\w*f catches combined ones (-uf).
      {
        pattern: 'push\\s+[^|;&]*(--force(?!-with-lease)\\b|(?<=[\\s\'"])-\\w*f\\b)',
        reason: 'Force-push is forbidden by policy (--force-with-lease is gated instead)',
      },
      {
        pattern: 'push\\s+[^|;&]*\\s\\+\\S',
        reason: 'Force-push via +refspec is forbidden by policy',
      },
      { pattern: 'rm\\s+-rf\\s+(/|~)(\\s|$)', reason: 'Recursive delete of root/home is forbidden by policy' },
    ],
    gated: [
      { pattern: '\\bgit\\s+push\\b', action: 'git-push' },
      { pattern: '\\bgh\\s+pr\\s+merge\\b', action: 'merge' },
      // Anchored to an invocation position so `cat docs/deploy.md` stays clean.
      { pattern: '(^|[;&|]\\s*)(sudo\\s+)?(\\S*/)?deploy\\b', action: 'deploy' },
      { pattern: '\\b(npm|pnpm|yarn|make)\\s+(run\\s+)?deploy\\b', action: 'deploy' },
      // Plan approval is the human's call: an agent running it hits this gate,
      // and the permission prompt *is* the approval. (aos\.mjs also covers
      // `node dist/aos.mjs run approve` in dev checkouts.)
      {
        pattern: '\\baos(\\.mjs)?\\s+run\\s+approve\\b',
        action: 'plan-approve',
        reason: 'Plan approval is reserved for the human — approve only after reviewing plan.md',
      },
      // Same pattern for closing a review: an agent may review the run and
      // PROPOSE done/shipped, but the permission prompt is the human sign-off.
      {
        pattern: '\\baos(\\.mjs)?\\s+run\\s+(state|finish)\\b[^|;&]*\\b(done|shipped)\\b',
        action: 'review-close',
        reason: 'Closing a review (done/shipped) is reserved for the human — the approval prompt is the sign-off',
      },
      // Unregistering a project turns its gates off, so the removal command is
      // itself gated: an agent hitting it gets asked, and approving the prompt
      // is the human sign-off for the --purge variant (see signoff.js).
      {
        pattern: '\\baos(\\.mjs)?\\s+remove\\b',
        action: 'project-remove',
        reason: 'Removing a project turns its gates off — approve only if that is really you',
      },
    ],
    // Extra write-protected paths (globs matched against absolute and
    // repo-relative paths), e.g. { pattern: '.env*', decision: 'ask' }.
    protected_paths: [],
  },
  verification: {
    adversarial_review: true,
    // Executable findings (opt-in): when true, a high-severity finding must
    // carry a `reproduce` command, `aos run review` executes it, and the
    // review gate refuses (state "unproven") until every required execution
    // in executions.json matches its expectation — `open` findings must fail
    // their command (the bug demonstrated), `fixed` findings must pass it
    // (the fix demonstrated). Off by default: it raises the bar on review.json
    // beyond what existing projects have written.
    executable_findings: false,
    contracts: [],
  },
};

export function policyPath(projectId) {
  return path.join(projectDir(projectId), 'policy.yaml');
}

export function loadPolicy(projectId) {
  const raw = readIfExists(policyPath(projectId));
  if (!raw) return DEFAULT_POLICY;
  return loadPolicyText(raw);
}

// Parse policy text into a full policy object. Broken YAML falls back to the
// defaults — same contract as loadPolicy, shared with `aos policy test`, which
// reads a candidate file the project never installed.
export function loadPolicyText(raw) {
  try {
    const parsed = YAML.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_POLICY;
    return {
      ...DEFAULT_POLICY,
      ...parsed,
      tiers: { ...DEFAULT_POLICY.tiers, ...(parsed.tiers || {}) },
      verification: { ...DEFAULT_POLICY.verification, ...(parsed.verification || {}) },
    };
  } catch {
    return DEFAULT_POLICY;
  }
}

// A candidate policy from an explicit file — `aos policy test --file`. The
// file must exist and parse; silently falling back to defaults here would
// replay against a policy the user never wrote.
export function loadPolicyFile(file) {
  const raw = readIfExists(file);
  if (raw === null) throw new Error(`No such policy file: ${file}`);
  const parsed = YAML.parse(raw); // throws on broken YAML — that is the point
  if (!parsed || typeof parsed !== 'object') throw new Error(`${file}: not a policy document`);
  return {
    ...DEFAULT_POLICY,
    ...parsed,
    tiers: { ...DEFAULT_POLICY.tiers, ...(parsed.tiers || {}) },
    verification: { ...DEFAULT_POLICY.verification, ...(parsed.verification || {}) },
  };
}

function matchRule(rules, command) {
  for (const rule of rules || []) {
    if (!rule || !rule.pattern) continue;
    let re;
    try {
      re = new RegExp(rule.pattern, 'i');
    } catch {
      continue; // a broken pattern must never take the gate down
    }
    if (re.test(command)) return rule;
  }
  return null;
}

// Structural check for catastrophic rm invocations. Regexes miss flag
// permutations (-fr, -Rf, split flags, sudo prefixes, /* targets); parsing
// each pipeline segment token-wise does not.
const DANGEROUS_RM_TARGETS = new Set([
  '/', '/*', '/.',
  '~', '~/', '~/*',
  '$HOME', '$HOME/', '$HOME/*', '${HOME}', '${HOME}/', '${HOME}/*',
]);
// busybox/toybox are transparent the same way sudo is: the applet name is the
// next token, so `busybox sed -i` must resolve to sed. nice/timeout/doas/
// stdbuf/setsid are transparent too — they run the command they wrap, so
// `nice rm -r -f ~` must read as rm.
const WRAPPER_BINS = /^(sudo|command|env|nohup|time|xargs|busybox|toybox|nice|timeout|doas|stdbuf|setsid)$/i;

// Tools shipped under a `g` prefix by Homebrew's GNU coreutils (gsed, gawk,
// gcp…). Only names whose stripped form is a real tool are folded, so `git`,
// `grep` and `gh` are untouched.
const GNU_ALIASES = new Set([
  'sed', 'awk', 'cp', 'mv', 'rm', 'ln', 'install', 'tar',
  'truncate', 'sort', 'head', 'tail', 'date', 'find', 'chmod', 'chown',
]);

function unquote(token) {
  return String(token).replace(/^["']|["']$/g, '');
}

// The executable a token invokes, normalized: path stripped, lower-cased,
// GNU `g` prefix folded. Every structural check goes through this so a
// gsed/busybox invocation can't read as a different program than sed.
function canonicalBin(token) {
  const base = unquote(token).split('/').pop().toLowerCase();
  if (base.length > 1 && base[0] === 'g' && GNU_ALIASES.has(base.slice(1))) return base.slice(1);
  return base;
}

// Heredoc bodies are data, not commands — parsing their lines as segments
// produced false denies (a heredoc containing the *string* "rm -rf /" is not
// an rm invocation).
function stripHeredocs(command) {
  return String(command).replace(/<<-?\s*(["']?)(\w+)\1[\s\S]*?\n\2\b/g, ' ');
}

// Quoted regions are data too: `git grep "a > b"` redirects nothing and
// `node -e "console.log('git push --force')"` pushes nothing.
export function stripQuoted(command) {
  return String(command).replace(/'[^']*'/g, ' ').replace(/"[^"]*"/g, ' ');
}

// Split into simple-command segments. Subshells, command substitution, and
// backticks open a new command position — `echo $(rm -rf /)` runs rm.
export function commandSegments(command) {
  return stripHeredocs(command).split(/\|\||&&|\$\(|[;|\n()`]/);
}

// Shell keywords that precede a command in compound statements: after `do` or
// `then`, the next token is a fresh command position (`if rm -rf / ; then`).
const COMMAND_PREFIX = /^(do|then|else|elif|if|until|while)$/i;

// A leading `VAR=value` is an environment prefix, not the program:
// `PATH=/tmp:$PATH git push` still invokes git.
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// Wrapper options that consume a following value, per wrapper — the same flag
// means different things to different wrappers. `sudo -i` is a login shell and
// takes nothing; `xargs -I` takes a replacement string. Treating them alike
// swallowed the wrapped program as if it were an option's value.
const WRAPPER_VALUE_OPTS = {
  sudo: /^(-u|-g|-p|-C|-r|-t|-U|--user|--group|--prompt|--close-from|--role|--type|--other-user)$/,
  env: /^(-u|--unset|-C|--chdir|-S|--split-string)$/,
  xargs: /^(-n|-I|-L|-P|-s|-E|-a|-d|--max-args|--replace|--max-lines|--max-procs|--max-chars|--delimiter|--arg-file|--eof)$/,
  time: /^(-o|-f|--output|--format)$/,
  nice: /^(-n|--adjustment)$/,
  timeout: /^(-k|-s|--kill-after|--signal)$/,
  doas: /^(-u|-C)$/,
  // stdbuf's buffering args attach to the flag (-o0) or follow it (-o 0).
  stdbuf: /^(-i|-o|-e|--input|--output|--error)$/,
};
const NO_VALUE_OPTS = /^$/;

// Wrappers with a positional operand between the flags and the program:
// `timeout 30 cmd` puts the DURATION where the command is expected.
const WRAPPER_OPERAND_SKIP = new Set(['timeout']);

// Redirections are shell plumbing, not arguments to the program. Leaving them
// in made `git checkout main 2>&1` look like `<tree-ish> <pathspec>` — two
// operands — and falsely ask on an ordinary branch switch. A bare operator
// (`2>`, `<`) also consumes the filename token that follows it.
const REDIRECT = /^[0-9]*(&?>{1,2}|<{1,3})/;

function stripRedirections(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = REDIRECT.exec(tokens[i]);
    if (!m) {
      out.push(tokens[i]);
      continue;
    }
    // `>file` carries its own target; a bare `>` takes the next token.
    if (tokens[i].length === m[0].length) i++;
  }
  return out;
}

function segmentTokens(segment) {
  const tokens = stripRedirections(segment.trim().split(/\s+/).filter(Boolean));
  for (let shifted = true; shifted && tokens.length; ) {
    shifted = false;
    const head = tokens[0];
    if (COMMAND_PREFIX.test(head) || ENV_ASSIGNMENT.test(head)) {
      tokens.shift();
      shifted = true;
    } else if (WRAPPER_BINS.test(head)) {
      const bin = canonicalBin(head);
      const valueOpts = WRAPPER_VALUE_OPTS[bin] || NO_VALUE_OPTS;
      tokens.shift();
      // A wrapper's OWN flags sit between it and the program it runs. Not
      // skipping them left tokens[0] as a flag, so `sudo -E git reset --hard`
      // read as neither git nor anything else and sailed past every structural
      // check — including the self-protection ones.
      while (tokens.length && tokens[0].startsWith('-') && tokens[0] !== '--') {
        const opt = tokens.shift();
        if (valueOpts.test(opt) && tokens.length && !tokens[0].startsWith('-')) tokens.shift();
      }
      if (tokens[0] === '--') tokens.shift();
      if (WRAPPER_OPERAND_SKIP.has(bin) && tokens.length) tokens.shift();
      shifted = true;
    }
  }
  return tokens;
}

function dangerousRm(command) {
  for (const segment of commandSegments(command)) {
    const tokens = segmentTokens(segment);
    if (!tokens.length || canonicalBin(tokens[0]) !== 'rm') continue;
    let recursive = false;
    const targets = [];
    for (const t of tokens.slice(1)) {
      if (t === '--recursive' || t === '--no-preserve-root') recursive = true;
      else if (/^-[A-Za-z]+$/.test(t)) {
        if (/r/i.test(t)) recursive = true;
      } else if (!t.startsWith('--')) {
        targets.push(unquote(t));
      }
    }
    if (recursive && targets.some((t) => DANGEROUS_RM_TARGETS.has(t))) {
      return { reason: 'Recursive delete targeting root or home is forbidden by policy' };
    }
  }
  return null;
}

// git's global options come before the subcommand; some consume a value.
// `git -C . push` and `git --no-pager push` must resolve to subcommand "push",
// while `git stash push` must not.
const GIT_VALUE_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

function gitSubcommand(tokens) {
  let dashC = null;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (GIT_VALUE_OPTS.has(t)) {
      // -C changes the directory operands resolve against, which the checkout
      // path/ref test below needs.
      if (t === '-C' && tokens[i + 1]) dashC = unquote(tokens[i + 1]);
      i++; // skip the option's value
    } else if (!t.startsWith('-')) {
      return { sub: unquote(t), rest: tokens.slice(i + 1), dashC };
    }
  }
  return { sub: null, rest: [], dashC: null };
}

// Evasive git-push forms the regex tiers miss (`git -C . push`,
// `git --no-pager push -f`). Built-in like dangerousRm: this is accident
// protection, the same intent as the default policy's push rules.
function gitPushCheck(command) {
  for (const segment of commandSegments(command)) {
    const tokens = segmentTokens(segment);
    if (!tokens.length || canonicalBin(tokens[0]) !== 'git') continue;
    const { sub, rest } = gitSubcommand(tokens);
    if (sub !== 'push') continue;
    const force = rest.some((raw) => {
      const t = unquote(raw); // quoted flags ('-f') still force
      return t === '--force' || (/^-[A-Za-z]+$/.test(t) && t.includes('f')) || t.startsWith('+');
    });
    return { force };
  }
  return null;
}

// Git subcommands that destroy uncommitted work.
//
// This is the accident that actually happens. `rm -rf /` is a thought
// experiment; `git checkout -- .` wiping an afternoon of unstaged edits is a
// Tuesday. Neither the regex tiers nor commandWritesFiles saw any of these
// before, because none of them names the file it is about to overwrite — the
// destruction is implied by the subcommand.
//
// Tier is `ask`, never `deny`: every one of these is a command a human
// legitimately means, so the cost of a false positive is one prompt and the
// cost of a false negative is lost work. Reasons name what is destroyed and
// whether it is recoverable, because that is the question the human is
// actually answering at the prompt.
// `git checkout X` is a branch switch or a destructive path restore depending
// on what X *is*, and no amount of pattern-matching on the name settles it: a
// branch may be called `fix/typo.md` and a directory may be called `src`.
//
// So don't guess — ask the working tree, which is the same thing git does. If
// the operand names something that exists, it is a path and the checkout will
// overwrite it. A ref that does not exist on disk is a ref.
//
// Shape is only the fallback, for callers with no working directory (the
// script-content scan reads a file that will run somewhere else entirely).
// There it errs toward asking, since a missed path restore costs real work and
// a false positive costs one prompt.
const BARE_FILENAMES = new Set([
  'Makefile', 'Dockerfile', 'Jenkinsfile', 'Gemfile', 'Rakefile', 'Procfile',
  'Brewfile', 'Vagrantfile', 'README', 'LICENSE', 'CHANGELOG', 'CODEOWNERS',
  'NOTICE', 'AUTHORS', 'VERSION',
]);

function looksLikePath(operand) {
  return (
    operand === '.' ||
    operand.endsWith('/') ||
    /\.[A-Za-z][A-Za-z0-9]{0,9}$/.test(operand) ||
    BARE_FILENAMES.has(operand.split('/').pop())
  );
}

function isPathOperand(operand, cwd, dashC) {
  if (operand === '.' || operand.endsWith('/')) return true; // unambiguous
  if (!cwd) return looksLikePath(operand);
  try {
    return fs.existsSync(path.resolve(cwd, dashC || '.', operand));
  } catch {
    return looksLikePath(operand); // unreadable cwd — fall back rather than throw
  }
}

function destructiveGit(tokens, cwd) {
  const { sub, rest, dashC } = gitSubcommand(tokens);
  if (!sub) return null;
  const args = rest.map(unquote);
  const has = (...names) => args.some((a) => names.includes(a));
  // Short flags cluster: -fd, -fdx and -Rf all carry f.
  const shortFlag = (ch) => args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(ch));

  if (sub === 'reset' && (has('--hard') || has('--merge'))) {
    return 'git reset --hard discards every uncommitted change in the working tree — unrecoverable';
  }
  if (sub === 'clean' && (has('--force') || shortFlag('f'))) {
    return 'git clean -f deletes untracked files outright — they are in no commit and no stash, so this is unrecoverable';
  }
  // `git checkout` is two commands wearing one name: switch branches (safe) or
  // restore paths from a commit (destroys uncommitted changes to them). Telling
  // them apart without touching the filesystem:
  //   `--`, `-f`             explicit — always the destructive shape
  //   two+ non-flag args     `<tree-ish> <pathspec>`; that IS git's grammar
  //   one arg that looks     `.`, `src/`, or something with a file extension.
  //   like a file            A tag (`v1.0.0`) has no alphabetic extension and a
  //                          branch (`feature/login`) has no extension at all.
  // Branch-creating flags opt out: `git checkout -b new main` is two args and
  // perfectly safe.
  if (sub === 'checkout') {
    if (has('--') || has('--force') || shortFlag('f')) {
      return 'this git checkout overwrites working-tree files from a commit — uncommitted changes to them are lost';
    }
    const creating = has('-b', '-B', '-t', '--track', '--orphan', '--detach', '--guess', '--no-guess');
    const operands = args.filter((a) => !a.startsWith('-'));
    if (!creating && (operands.length >= 2 || (operands.length === 1 && isPathOperand(operands[0], cwd, dashC)))) {
      return 'this git checkout restores paths from a commit, overwriting them — uncommitted changes to them are lost';
    }
  }
  // git restore discards worktree changes by default; --staged alone only
  // unstages, which touches no file on disk.
  if (sub === 'restore') {
    const staged = has('--staged') || shortFlag('S');
    const worktree = has('--worktree') || shortFlag('W');
    if (!staged || worktree) {
      return 'git restore overwrites working-tree files from a commit — uncommitted changes to them are lost';
    }
  }
  if (sub === 'switch' && (has('--force', '--discard-changes') || shortFlag('f'))) {
    return 'git switch --force discards uncommitted changes while switching branches';
  }
  // -D, -Df, and `-d --force` are the same command; match the cluster, not the
  // exact token.
  if (
    sub === 'branch' &&
    (shortFlag('D') || ((has('--delete') || shortFlag('d')) && (has('--force') || shortFlag('f'))))
  ) {
    return 'git branch -D force-deletes a branch, including commits that exist nowhere else';
  }
  // The sub-subcommand is the first OPERAND, not args[0] — `git stash -q drop`.
  const operand = args.find((a) => !a.startsWith('-'));
  if (sub === 'stash' && ['drop', 'clear'].includes(operand)) {
    return `git stash ${operand} permanently discards stashed work`;
  }
  // `git rm` of a committed file is recoverable, so only the two unrecoverable
  // shapes are gated: -f overrides local modifications, -r takes a whole tree.
  // `--cached` only touches the index, so it never qualifies.
  if (sub === 'rm' && !has('--cached') && (has('--force') || shortFlag('f') || shortFlag('r') || has('-R'))) {
    return 'this git rm deletes working-tree files (forced or recursive) — local modifications to them are lost';
  }
  if (sub === 'worktree' && operand === 'remove' && (has('--force') || shortFlag('f'))) {
    return 'git worktree remove --force deletes a worktree that still has uncommitted changes';
  }
  if (sub === 'submodule' && operand === 'deinit' && (has('--force') || shortFlag('f'))) {
    return 'git submodule deinit --force discards uncommitted changes inside the submodule';
  }
  return null;
}

export function gitDestructiveCheck(command, cwd) {
  for (const segment of commandSegments(command)) {
    const tokens = segmentTokens(segment);
    if (!tokens.length || canonicalBin(tokens[0]) !== 'git') continue;
    const reason = destructiveGit(tokens, cwd);
    if (reason) return { reason };
  }
  return null;
}

// `eval "cmd"` RUNS cmd, and so does `bash -c "cmd"` (sh/zsh/dash alike): both
// make the shell parse a string as a fresh command line. Quote-stripping
// erases the quoted payload before the regex tiers see it, and the structural
// checks saw "eval"/"bash", not the program inside — so `eval "rm -rf /"` and
// `bash -c "rm -rf /"` were silent allows. Extract each payload and evaluate
// it through the same path.
const SHELL_C_BINS = /^(bash|sh|zsh|dash)$/;

function evalPayloads(command) {
  const out = [];
  // \" survives tokenizing as a literal backslash-quote; the shell strips it
  // before the inner parse, so strip it here too (`eval "eval \"rm…\""`).
  const clean = (tokens) => tokens.map(unquote).join(' ').replace(/\\(["'])/g, '$1');
  for (const segment of commandSegments(command)) {
    const tokens = segmentTokens(segment);
    if (tokens.length <= 1) continue;
    const bin = canonicalBin(tokens[0]);
    if (bin === 'eval') {
      out.push(clean(tokens.slice(1)));
    } else if (SHELL_C_BINS.test(bin)) {
      // The payload is what follows -c (its own flag, or the last letter of a
      // cluster: `bash -lc "cmd"`). Tokens after the payload are argv to it;
      // sweeping them in only tightens the verdict, which is the safe side.
      const i = tokens.findIndex((t) => /^-[A-Za-z]*c$/.test(t));
      if (i > 0 && i < tokens.length - 1) out.push(clean(tokens.slice(i + 1)));
    }
  }
  return out;
}

// Bounded: `eval 'eval "eval …"'` nests, and each level re-enters this
// function — the cap keeps a pathological string from recursing forever.
const EVAL_DEPTH_MAX = 3;

// Returns { decision: 'allow' | 'ask' | 'deny', reason, action }
export function evaluateCommand(policy, command, { cwd = null, _depth = 0 } = {}) {
  const cmd = String(command || '');
  if (_depth < EVAL_DEPTH_MAX) {
    for (const payload of evalPayloads(cmd)) {
      const verdict = evaluateCommand(policy, payload, { cwd, _depth: _depth + 1 });
      if (verdict.decision !== 'allow') return verdict;
    }
  }
  const rm = dangerousRm(cmd);
  if (rm) return { decision: 'deny', action: 'forbidden', reason: rm.reason };
  // Forbidden (deny-level) regexes run against quote-stripped text so that a
  // command merely *mentioning* a forbidden string ("echo 'git push --force'")
  // isn't hard-blocked. eval and bash -c payloads were already evaluated on
  // their own above; what remains quoted here is data, not a command.
  const forbidden = matchRule(policy.tiers?.forbidden, stripQuoted(cmd));
  if (forbidden) {
    return {
      decision: 'deny',
      action: forbidden.action || 'forbidden',
      reason: forbidden.reason || 'Command is forbidden by project policy',
    };
  }
  const push = gitPushCheck(cmd);
  if (push?.force) {
    return {
      decision: 'deny',
      action: 'forbidden',
      reason: 'Force-push is forbidden by policy (--force-with-lease is gated instead)',
    };
  }
  const gated = matchRule(policy.tiers?.gated, cmd);
  if (gated) {
    return {
      decision: 'ask',
      action: gated.action || 'gated',
      reason: gated.reason || `Action "${gated.action || 'gated'}" requires human approval per project policy`,
    };
  }
  if (push) {
    return {
      decision: 'ask',
      action: 'git-push',
      reason: 'Action "git-push" requires human approval per project policy',
    };
  }
  // Opt-out for repos where discarding the worktree is routine
  // (tiers.protect_worktree: false). Default on: losing uncommitted work is
  // the most common real agent accident, and the check only ever asks.
  if (policy.tiers?.protect_worktree !== false) {
    const destructive = gitDestructiveCheck(cmd, cwd);
    if (destructive) {
      return {
        decision: 'ask',
        action: 'worktree-destructive',
        reason: `${destructive.reason} — requires human approval`,
      };
    }
  }
  return { decision: 'allow', action: 'auto', reason: '' };
}

// Does this Bash command plausibly write files? Used to extend the plan gate
// and protected-path checks to the shell path — `tee`, `> file`, `sed -i`
// would otherwise bypass gates that only see the file tools. Accident-model
// heuristic: false positives cost one "ask", false negatives cost a bypass,
// so lean toward asking.
const WRITE_BINS = new Set([
  'tee', 'cp', 'mv', 'install', 'rsync', 'ln', 'mkdir', 'touch',
  'truncate', 'dd', 'patch', 'rm', 'chmod', 'chown', 'wget', 'unzip',
]);

// Interpreter one-liners are the most common bulk-edit fallback when a
// simpler write is gated — only flag them when the code plausibly writes.
const INTERPRETER_BINS = /^(python\d*|node|ruby|perl|deno|bun|php)$/;
const WRITE_HINTS =
  /writeFileSync|appendFileSync|createWriteStream|\bopen\s*\([^)]*['"](w|a|r\+)|write_text|write_bytes|to_csv|savefig|shutil\.|os\.(remove|rename|unlink|makedirs|replace)|File\.(write|open)|IO\.write|file_put_contents/;

// In-place-edit flags may be combined (-ri, -Ei, -pi), so match any short
// cluster containing i.
function inPlaceFlag(tokens) {
  return tokens.slice(1).some((t) => /^-[A-Za-z]*i/.test(t) || t.startsWith('--in-place'));
}

export function commandWritesFiles(command, { cwd = null } = {}) {
  const cmd = String(command || '');
  // Redirections, minus quoted text ("a > b" redirects nothing) and the
  // harmless forms: fd duplication (2>&1) and null sinks.
  const stripped = stripQuoted(cmd)
    .replace(/[0-9]*>&[0-9]+/g, ' ')
    .replace(/&?[0-9]*>>?\s*\/dev\/null\b/g, ' ');
  if (/>>?/.test(stripped)) return true;
  for (const segment of commandSegments(cmd)) {
    const tokens = segmentTokens(segment);
    if (!tokens.length) continue;
    const bin = canonicalBin(tokens[0]);
    if (WRITE_BINS.has(bin)) return true;
    if ((bin === 'sed' || bin === 'perl' || bin === 'awk') && inPlaceFlag(tokens)) return true;
    if (bin === 'sort' && tokens.some((t) => t === '-o' || t.startsWith('--output'))) return true;
    if (bin === 'curl' && tokens.some((t) => /^-[A-Za-z]*[oO]/.test(t) || t.startsWith('--output') || t.startsWith('--remote-name'))) return true;
    // Extract and create both write; both flag styles (`-xzf` / old-style `xzf`).
    if (bin === 'tar' && tokens[1] && (/^-?[A-Za-z]*[xc][A-Za-z]*$/.test(tokens[1]) || tokens.includes('--extract'))) return true;
    if (bin === 'git') {
      if (['apply', 'am'].includes(gitSubcommand(tokens).sub)) return true;
      // The destructive subcommands overwrite or delete working-tree files, so
      // the plan gate and the protected-path checks must see them as writes —
      // `git checkout -- .claude/settings.json` disarms the hooks just as
      // surely as editing the file does.
      if (destructiveGit(tokens, cwd)) return true;
    }
    if (INTERPRETER_BINS.test(bin) && WRITE_HINTS.test(cmd)) return true;
  }
  return false;
}

// The Bash counterpart of evaluateFileWrite's built-in self-protection: a
// shell command that writes AND names a protected target (hook wiring, git
// hooks, AOS policy/audit state) gets the same "ask" the file tools would.
export function evaluateBashProtected(command, { home, cwd = null } = {}) {
  const cmd = String(command || '');
  // git config core.hooksPath re-points hooks at an arbitrary directory — same
  // effect as writing .git/hooks/, with no file write for the heuristic to see.
  // The `-c key=val` per-command form (`git -c core.hooksPath=/tmp push`) is the
  // same rewire for one invocation — the word `config` never appears in it.
  if (/\bgit\b[^|;&]*\bconfig\b[^|;&]*hooksPath/i.test(cmd) || /\bgit\b[^|;&]*\s-c\s+\S*hooksPath/i.test(cmd)) {
    return {
      decision: 'ask',
      action: 'protected-path',
      reason: 'Re-pointing core.hooksPath plants hooks that run on future git commands — requires human approval',
    };
  }
  if (!commandWritesFiles(cmd, { cwd })) return null;
  if (/\.claude[\\/]settings(\.local)?\.json/.test(cmd)) {
    return {
      decision: 'ask',
      action: 'protected-path',
      reason: 'This command writes .claude/settings.json, which can rewire or remove the AOS hooks — requires human approval',
    };
  }
  if (/\.git[\\/]hooks[\\/]/.test(cmd)) {
    return {
      decision: 'ask',
      action: 'protected-path',
      reason: 'This command writes into .git/hooks/ — code planted there runs on future git commands — requires human approval',
    };
  }
  const aosRoot = home || aosHome();
  // /\.aos\b catches ~/.aos, $HOME/.aos, and interpreter strings like
  // HOME + "/.aos/…" — with or without a trailing slash (`cd ~/.aos && …`).
  const namesAosHome = cmd.includes(aosRoot) || /\/\.aos\b/.test(cmd);
  if (namesAosHome && [...PROTECTED_AOS_BASENAMES].some((b) => cmd.includes(b))) {
    return {
      decision: 'ask',
      action: 'protected-path',
      reason: 'This command writes AOS policy/audit state — agents editing it directly requires human approval',
    };
  }
  return null;
}

const ALLOW = { decision: 'allow', action: 'auto', reason: '' };

// AOS state files an agent must not rewrite: the policy that gates it, the
// audit that records it, and the run/session ledgers the metrics come from.
const PROTECTED_AOS_BASENAMES = new Set([
  'policy.yaml',
  'audit.jsonl',
  'meta.json',
  'state.json',
  'sessions.jsonl',
  'registry.yaml',
  // The pending sign-off ticket. Writing one forges a human's approval to close
  // a run, so it belongs here with the rest of the self-protection — the gate
  // is the only thing that should ever create it.
  'signoff.json',
  // The removals receipt ledger — it survives every purge it records and names
  // who authorized them, so an agent editing it is editing the evidence.
  'removals.jsonl',
  // Transcript-ingest watermarks: rewriting them re-ingests deltas (duplicate
  // audit lines) or suppresses them — AOS state either way.
  'ingest.json',
]);

function globToRegExp(glob) {
  const source = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${source}$`, 'i');
}

// Gate file writes the way evaluateCommand gates Bash. Three layers:
// built-in self-protection (an agent editing the hook wiring or the audit
// trail defeats the whole point), user-defined protected_paths globs, and a
// content scan of scripts so a gated command can't be laundered into a file
// and executed later.
export function evaluateFileWrite(policy, filePath, content = '', { home, repoRoot } = {}) {
  const abs = path.resolve(String(filePath));
  const base = path.basename(abs);

  if (/[\\/]\.claude[\\/]settings(\.local)?\.json$/.test(abs)) {
    return {
      decision: 'ask',
      action: 'protected-path',
      reason: 'Editing .claude/settings.json can rewire or remove the AOS hooks — requires human approval',
    };
  }
  if (abs.includes(`${path.sep}.git${path.sep}hooks${path.sep}`)) {
    return {
      decision: 'ask',
      action: 'protected-path',
      reason: 'Writing a git hook plants code that runs on future git commands — requires human approval',
    };
  }
  const aosRoot = home || aosHome();
  if (abs.startsWith(aosRoot + path.sep) && PROTECTED_AOS_BASENAMES.has(base)) {
    return {
      decision: 'ask',
      action: 'protected-path',
      reason: `${base} is AOS policy/audit state — agents editing it directly requires human approval`,
    };
  }

  const rel = repoRoot && abs.startsWith(repoRoot + path.sep) ? abs.slice(repoRoot.length + 1) : null;
  for (const rule of policy.tiers?.protected_paths || []) {
    if (!rule || !rule.pattern) continue;
    let re;
    try {
      re = globToRegExp(rule.pattern);
    } catch {
      continue; // a broken glob must never take the gate down
    }
    if (re.test(abs) || (rel !== null && re.test(rel))) {
      const decision = rule.decision === 'deny' ? 'deny' : 'ask';
      return {
        decision,
        action: rule.action || 'protected-path',
        reason: rule.reason || `Writing ${rule.pattern} requires human approval per project policy`,
      };
    }
  }

  const text = String(content || '');
  const looksLikeScript = /\.(sh|bash|zsh)$/i.test(base) || text.startsWith('#!');
  if (looksLikeScript && text) {
    const verdict = evaluateCommand(policy, text.slice(0, 100_000));
    if (verdict.decision !== 'allow') {
      return {
        decision: verdict.decision,
        action: 'script-content',
        reason: `Script contains a ${verdict.decision === 'deny' ? 'forbidden' : 'gated'} command — executing this file later would bypass the gate. ${verdict.reason}`,
      };
    }
  }

  return ALLOW;
}
