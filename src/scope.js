import path from 'node:path';
import { readIfExists } from './paths.js';
import { runDir } from './run.js';

// Scope gating: the plan says which files it expects to touch, and writes
// outside that get an ask.
//
// The one gate that knows what the work is *supposed* to be — everything else
// asks "is this command dangerous", this asks "is this the change you
// described", which is the drift plan approval alone cannot catch.
//
// Self-activating: a plan.md with no Files section gates nothing, so declaring
// the section is the opt-in and no existing project changes behaviour. Always
// `ask` — being outside the plan is not proof of a mistake, so the honest
// response is to surface the drift, not block it.

// Headings that introduce a file list. Kept generous: the plan is prose an
// agent wrote, and a gate that fires on only one exact spelling mostly does
// not fire.
const SCOPE_HEADING = /^#{1,6}\s*(files?|scope|files?\s+to\s+(touch|change|modify)|expected\s+files?|touched\s+files?)\b/i;
const ANY_HEADING = /^#{1,6}\s/;

// Trailing commentary an agent naturally writes after a path:
//   - `src/gate.js` — extend the check to Bash redirects
//   - src/gate.js (new)
const COMMENTARY = /\s+(—|–|-{1,2}|\(|:)\s*.*$/;

// A token that could plausibly be a repo path. Rejects prose ("Add a new
// helper") by requiring no spaces and at least one path-ish character, and
// rejects URLs outright.
const PATH_LIKE = /^[\w@.][\w@.\-/*[\]{}!]*$/;

// Phrasings that mean "not this file". Matched against the label half of a
// `label: path` line, where a naive parse would otherwise grant the path.
const NEGATION = /\b(no|not|never|avoid|except|exclude|excluding|untouched|unchanged|don'?t|doesn'?t|without)\b/i;
// `someone@example.com` is path-shaped enough for PATH_LIKE (scoped npm
// packages legitimately contain @), so reject the email form explicitly.
const EMAIL = /^[^@/]+@[^@/]+\.[A-Za-z]{2,}$/;

function cleanEntry(raw) {
  let s = String(raw).trim();
  s = s.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, ''); // list markers
  s = s.replace(/^\[[ xX]\]\s*/, ''); // task checkboxes
  const code = /`([^`]+)`/.exec(s); // a backticked path wins over the prose around it
  if (code) s = code[1];
  else s = s.replace(COMMENTARY, '');
  s = s.trim().replace(/^["']|["'],?$/g, '').replace(/[.,;]$/, '');
  // `Add tests: test/smoke.sh` — a short label in front of one path. Narrow on
  // purpose: a generic "take the last word" fallback reads "Do not touch
  // config/production.yaml" as DECLARING that file, switching the gate off for
  // exactly what the plan excluded. A scope gate that grants what the prose
  // forbids is worse than none, so require label + colon + a single token, and
  // refuse exclusions outright.
  if (/\s/.test(s)) {
    const labelled = /^([\w .()/-]{1,40}):\s*(\S+)$/.exec(s);
    if (!labelled || NEGATION.test(labelled[1])) return null;
    s = labelled[2].replace(/[.,;]$/, '');
  }
  if (EMAIL.test(s)) return null;
  if (!s || s.length > 200) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return null; // URL
  if (!PATH_LIKE.test(s)) return null;
  if (!/[/.*]/.test(s)) return null; // a bare word is a topic, not a path
  return s.replace(/^\.\//, '');
}

// A plan declaring hundreds of paths isn't declaring scope, and inScope walks
// the list on every write — cap it so a pathological plan.md can't make the
// gate the slow part of a session.
const MAX_ENTRIES = 500;

// Every path-ish entry under a Files/Scope heading in plan.md.
export function parseScope(planText) {
  const entries = new Set();
  let inSection = false;
  for (const line of String(planText || '').split('\n')) {
    if (ANY_HEADING.test(line)) {
      inSection = SCOPE_HEADING.test(line);
      continue;
    }
    if (!inSection || !line.trim()) continue;
    const entry = cleanEntry(line);
    if (entry) entries.add(entry);
    if (entries.size >= MAX_ENTRIES) break;
  }
  return [...entries];
}

export function runScope(projectId, runId) {
  const plan = readIfExists(path.join(runDir(projectId, runId), 'plan.md'));
  return plan ? parseScope(plan) : [];
}

// Case-sensitive on purpose: exact and directory matching below are, and a
// glob matching more loosely than they do would quietly widen the scope.
//
// `/**/` means "zero or more directories", so `src/**/*.test.js` has to match
// `src/a.test.js` as well as `src/a/b.test.js`. Expanding `**` to `.*` only
// matches the nested form, and the flat one is the half people hit first.
function globToRegExp(glob) {
  const s = String(glob);
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '*' && s[i + 1] === '*') {
      if (s[i + 2] === '/' && out === '') {
        out += '(?:.*/)?'; // leading `**/` — must also match a root-level file
        i += 2;
      } else if (s[i + 2] === '/' && out.endsWith('/')) {
        out = out.slice(0, -1) + '(?:/.*)?/'; // `/**/` — zero or more directories
        i += 2;
      } else {
        out += '.*';
        i += 1;
      }
    } else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

// Does `rel` (a repo-relative, forward-slashed path) fall inside the plan?
//
// Three ways to match, because all three are things people write in a plan:
//   src/gate.js     exact file
//   src/            a directory, covering everything under it
//   src/**/*.test.js glob
export function inScope(rel, entries) {
  const target = String(rel).replace(/\\/g, '/').replace(/^\.\//, '');
  for (const raw of entries) {
    const entry = String(raw).replace(/\\/g, '/');
    if (entry === target) return true;
    const dir = entry.replace(/\/+$/, '');
    if (dir && (target === dir || target.startsWith(dir + '/'))) return true;
    if (/[*?[\]]/.test(entry)) {
      try {
        if (globToRegExp(entry).test(target)) return true;
      } catch {
        // a broken glob must never take the gate down
      }
    }
  }
  return false;
}
