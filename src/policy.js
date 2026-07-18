import path from 'node:path';
import YAML from 'yaml';
import { aosHome, projectDir, readIfExists } from './paths.js';

export const DEFAULT_POLICY = {
  version: 1,
  plan_gate: 'auto',
  tiers: {
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
        pattern: '\\baos(\\.mjs)?\\s+run\\s+state\\s+(done|shipped)\\b',
        action: 'review-close',
        reason: 'Closing a review (done/shipped) is reserved for the human — the approval prompt is the sign-off',
      },
    ],
    // Extra write-protected paths (globs matched against absolute and
    // repo-relative paths), e.g. { pattern: '.env*', decision: 'ask' }.
    protected_paths: [],
  },
  verification: {
    adversarial_review: true,
    contracts: [],
  },
};

export function policyPath(projectId) {
  return path.join(projectDir(projectId), 'policy.yaml');
}

export function loadPolicy(projectId) {
  const raw = readIfExists(policyPath(projectId));
  if (!raw) return DEFAULT_POLICY;
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
const WRAPPER_BINS = /^(sudo|command|env|nohup|time|xargs)$/i;

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

function segmentTokens(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  while (tokens.length && (WRAPPER_BINS.test(tokens[0]) || COMMAND_PREFIX.test(tokens[0]))) tokens.shift();
  return tokens;
}

function dangerousRm(command) {
  for (const segment of commandSegments(command)) {
    const tokens = segmentTokens(segment);
    if (!tokens.length || tokens[0].split('/').pop() !== 'rm') continue;
    let recursive = false;
    const targets = [];
    for (const t of tokens.slice(1)) {
      if (t === '--recursive' || t === '--no-preserve-root') recursive = true;
      else if (/^-[A-Za-z]+$/.test(t)) {
        if (/r/i.test(t)) recursive = true;
      } else if (!t.startsWith('--')) {
        targets.push(t.replace(/^["']|["']$/g, ''));
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
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (GIT_VALUE_OPTS.has(t)) {
      i++; // skip the option's value
    } else if (!t.startsWith('-')) {
      return { sub: t.replace(/^["']|["']$/g, ''), rest: tokens.slice(i + 1) };
    }
  }
  return { sub: null, rest: [] };
}

// Evasive git-push forms the regex tiers miss (`git -C . push`,
// `git --no-pager push -f`). Built-in like dangerousRm: this is accident
// protection, the same intent as the default policy's push rules.
function gitPushCheck(command) {
  for (const segment of commandSegments(command)) {
    const tokens = segmentTokens(segment);
    if (!tokens.length || tokens[0].split('/').pop() !== 'git') continue;
    const { sub, rest } = gitSubcommand(tokens);
    if (sub !== 'push') continue;
    const force = rest.some((raw) => {
      const t = raw.replace(/^["']|["']$/g, ''); // quoted flags ('-f') still force
      return t === '--force' || (/^-[A-Za-z]+$/.test(t) && t.includes('f')) || t.startsWith('+');
    });
    return { force };
  }
  return null;
}

// Returns { decision: 'allow' | 'ask' | 'deny', reason, action }
export function evaluateCommand(policy, command) {
  const cmd = String(command || '');
  const rm = dangerousRm(cmd);
  if (rm) return { decision: 'deny', action: 'forbidden', reason: rm.reason };
  // Forbidden (deny-level) regexes run against quote-stripped text so that a
  // command merely *mentioning* a forbidden string ("echo 'git push --force'")
  // isn't hard-blocked. The real invocations are caught structurally above and
  // below; anything hiding in quotes (bash -c "git push …") still lands in the
  // gated tier, which scans the raw string — a human sees it either way.
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

export function commandWritesFiles(command) {
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
    const bin = tokens[0].split('/').pop().toLowerCase();
    if (WRITE_BINS.has(bin)) return true;
    if ((bin === 'sed' || bin === 'perl' || bin === 'awk') && inPlaceFlag(tokens)) return true;
    if (bin === 'sort' && tokens.some((t) => t === '-o' || t.startsWith('--output'))) return true;
    if (bin === 'curl' && tokens.some((t) => /^-[A-Za-z]*[oO]/.test(t) || t.startsWith('--output') || t.startsWith('--remote-name'))) return true;
    // Extract and create both write; both flag styles (`-xzf` / old-style `xzf`).
    if (bin === 'tar' && tokens[1] && (/^-?[A-Za-z]*[xc][A-Za-z]*$/.test(tokens[1]) || tokens.includes('--extract'))) return true;
    if (bin === 'git' && ['apply', 'am'].includes(gitSubcommand(tokens).sub)) return true;
    if (INTERPRETER_BINS.test(bin) && WRITE_HINTS.test(cmd)) return true;
  }
  return false;
}

// The Bash counterpart of evaluateFileWrite's built-in self-protection: a
// shell command that writes AND names a protected target (hook wiring, git
// hooks, AOS policy/audit state) gets the same "ask" the file tools would.
export function evaluateBashProtected(command, { home } = {}) {
  const cmd = String(command || '');
  // git config core.hooksPath re-points hooks at an arbitrary directory — same
  // effect as writing .git/hooks/, with no file write for the heuristic to see.
  if (/\bgit\b[^|;&]*\bconfig\b[^|;&]*hooksPath/i.test(cmd)) {
    return {
      decision: 'ask',
      action: 'protected-path',
      reason: 'Re-pointing core.hooksPath plants hooks that run on future git commands — requires human approval',
    };
  }
  if (!commandWritesFiles(cmd)) return null;
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
]);

function globToRegExp(glob) {
  const source = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, ' ')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/ /g, '.*');
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
