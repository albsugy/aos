import fs from 'node:fs';
import path from 'node:path';

// Best-effort repo introspection for `aos init`. Everything here is wrapped so
// a weird repo can never break init — callers fall back to the blank templates.

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function exists(root, rel) {
  try {
    return fs.existsSync(path.join(root, rel));
  } catch {
    return false;
  }
}

// A `npm test` placeholder from `npm init` fails on purpose — don't seed it as
// a contract (it would make every run's verification red for no reason).
function isPlaceholderScript(cmd) {
  return /no test specified/i.test(String(cmd || ''));
}

function detectPackageManager(root) {
  if (exists(root, 'pnpm-lock.yaml')) return 'pnpm';
  if (exists(root, 'yarn.lock')) return 'yarn';
  // bun.lock is the text lockfile (Bun >= 1.2 default); bun.lockb the legacy binary one.
  if (exists(root, 'bun.lock') || exists(root, 'bun.lockb')) return 'bun';
  if (exists(root, 'package-lock.json')) return 'npm';
  return 'npm';
}

// `bun test` invokes Bun's native test runner and IGNORES scripts.test — only
// `bun run test` executes the package.json script. Every other pm treats
// `<pm> test` as the script.
function scriptCmd(pm, name) {
  if (name === 'test' && pm !== 'bun') return `${pm} test`;
  return `${pm} run ${name}`;
}

const FRAMEWORK_HINTS = [
  ['next', 'Next.js'],
  ['react', 'React'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['@angular/core', 'Angular'],
  ['express', 'Express'],
  ['fastify', 'Fastify'],
  ['@nestjs/core', 'NestJS'],
  ['koa', 'Koa'],
  ['vite', 'Vite'],
  ['esbuild', 'esbuild'],
];

// Turn package.json scripts into verification contracts. `test` is required
// (a failed test should block a run reaching awaiting-review); lint/typecheck
// are advisory by default so a project isn't forced to be warning-clean.
function contractsFromScripts(scripts, pm) {
  const out = [];
  if (scripts.test && !isPlaceholderScript(scripts.test)) {
    out.push({ name: 'tests', command: scriptCmd(pm, 'test'), required: true });
  }
  for (const key of ['typecheck', 'type-check', 'tsc']) {
    if (scripts[key]) {
      out.push({ name: 'typecheck', command: scriptCmd(pm, key), required: false });
      break;
    }
  }
  if (scripts.lint) out.push({ name: 'lint', command: scriptCmd(pm, 'lint'), required: false });
  return out;
}

// Non-Node ecosystems get a required test contract too — a Python/Go/Rust
// repo that verifies nothing out of the box breaks the "real verification"
// promise. Required-test only, no advisory linters: tool availability varies
// too much outside package.json scripts to seed commands that may not exist.
function nonNodeContracts(root) {
  const test = (command) => [{ name: 'tests', command, required: true }];
  if (exists(root, 'go.mod')) return test('go test ./...');
  if (exists(root, 'Cargo.toml')) return test('cargo test');
  if (
    exists(root, 'pytest.ini') ||
    exists(root, 'setup.py') ||
    exists(root, 'pyproject.toml') ||
    exists(root, 'requirements.txt')
  ) {
    return test('pytest');
  }
  if (exists(root, 'Gemfile') && exists(root, 'spec')) return test('bundle exec rspec');
  if (exists(root, 'pom.xml')) return test('mvn -q test');
  if (exists(root, 'build.gradle') || exists(root, 'build.gradle.kts')) {
    return test(exists(root, 'gradlew') ? './gradlew test' : 'gradle test');
  }
  for (const [file, runner] of [
    ['Makefile', 'make test'],
    ['justfile', 'just test'],
    ['Justfile', 'just test'],
  ]) {
    try {
      const raw = fs.readFileSync(path.join(root, file), 'utf8');
      if (/^test\s*:/m.test(raw)) return test(runner);
    } catch {
      // no such file
    }
  }
  return [];
}

function topLevelDirs(root) {
  const skip = new Set([
    'node_modules', 'dist', 'build', '.git', '.github', '.claude',
    'coverage', '.next', '.cache', 'vendor', 'target', '__pycache__',
  ]);
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !skip.has(e.name))
      .map((e) => e.name)
      .slice(0, 8);
  } catch {
    return [];
  }
}

// First real paragraph of the README, minus the title and any badge lines.
function readmeSummary(root) {
  for (const name of ['README.md', 'README', 'readme.md']) {
    const p = path.join(root, name);
    let raw;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const para = [];
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) {
        if (para.length) break;
        continue;
      }
      if (t.startsWith('#')) continue; // heading
      if (/^\[?!\[/.test(t) || /^\[!\[/.test(t)) continue; // badges
      if (t.startsWith('<!--')) continue;
      para.push(t);
    }
    const text = para.join(' ').replace(/\s+/g, ' ').trim();
    if (text) return text.length > 400 ? text.slice(0, 400) + '…' : text;
  }
  return null;
}

// Detect non-Node ecosystems so the stack section isn't Node-only.
function ecosystemSignals(root) {
  const sig = [];
  if (exists(root, 'pyproject.toml') || exists(root, 'setup.py') || exists(root, 'requirements.txt')) sig.push('Python');
  if (exists(root, 'go.mod')) sig.push('Go');
  if (exists(root, 'Cargo.toml')) sig.push('Rust');
  if (exists(root, 'Gemfile')) sig.push('Ruby');
  if (exists(root, 'pom.xml') || exists(root, 'build.gradle') || exists(root, 'build.gradle.kts')) sig.push('JVM');
  return sig;
}

function bullet(label, value) {
  return value ? `- **${label}:** ${value}` : null;
}

// Returns { pack, contracts, summary } where pack is markdown or null (no
// signal → caller uses the blank template), and summary is a short one-liner
// for the init output.
export function detectRepo(repoRoot) {
  const root = path.resolve(repoRoot);
  const pkg = readJsonSafe(path.join(root, 'package.json'));
  const pm = detectPackageManager(root);
  const isTs = exists(root, 'tsconfig.json');
  const eco = ecosystemSignals(root);
  const readme = readmeSummary(root);
  const dirs = topLevelDirs(root);

  const scripts = (pkg && pkg.scripts) || {};
  // package.json scripts win (they encode the repo's own choices). Ecosystem
  // conventions only apply when there is NO package.json at all — a Node repo
  // with a placeholder test script and a stray pyproject.toml must not get a
  // wrong required `pytest` contract.
  const contracts = pkg ? contractsFromScripts(scripts, pm) : nonNodeContracts(root);

  const hasSignal = !!(pkg || eco.length || readme || dirs.length || contracts.length);
  if (!hasSignal) return { pack: null, contracts: [], summary: null };

  // --- stack section ---
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const frameworks = FRAMEWORK_HINTS.filter(([dep]) => deps[dep]).map(([, name]) => name);
  const languages = [];
  if (pkg || isTs) languages.push(isTs ? 'TypeScript' : 'JavaScript');
  languages.push(...eco);

  const runtime = pkg?.engines?.node
    ? `Node ${pkg.engines.node}`
    : pkg
      ? 'Node'
      : null;

  const stack = [
    bullet('Runtime', runtime),
    bullet('Language', languages.join(', ') || null),
    bullet('Frameworks', frameworks.join(', ') || null),
    pkg ? bullet('Package manager', pm) : null,
    pkg?.bin ? bullet('Entry point', typeof pkg.bin === 'string' ? pkg.bin : Object.keys(pkg.bin).join(', ')) : null,
    dirs.length ? bullet('Top-level dirs', dirs.map((d) => `\`${d}/\``).join(' ')) : null,
  ].filter(Boolean);

  // --- conventions section (detected commands) ---
  const convLines = [];
  if (scripts.test && !isPlaceholderScript(scripts.test)) convLines.push(`- Tests: \`${scriptCmd(pm, 'test')}\``);
  if (scripts.lint) convLines.push(`- Lint: \`${scriptCmd(pm, 'lint')}\``);
  for (const key of ['typecheck', 'type-check', 'tsc']) {
    if (scripts[key]) {
      convLines.push(`- Typecheck: \`${scriptCmd(pm, key)}\``);
      break;
    }
  }
  if (scripts.build) convLines.push(`- Build: \`${scriptCmd(pm, 'build')}\``);
  if (!convLines.length && contracts.length) convLines.push(`- Tests: \`${contracts[0].command}\``);

  const whatIsIt = pkg?.description || readme || '(one paragraph: purpose, stage, who uses it)';

  const pack = [
    '# Context pack',
    '',
    '<!-- Auto-drafted by `aos init` from this repo. It is a starting point, not the truth —',
    '     refine it: the parts marked with parentheses/TODO are for you to fill in. -->',
    '',
    '## What this project is',
    '',
    whatIsIt,
    '',
    '## Architecture & stack',
    '',
    stack.length ? stack.join('\n') : '- (runtime, framework, database, deploy target)',
    '',
    '## Conventions',
    '',
    convLines.length ? convLines.join('\n') : '- (naming, structure, commit style — only what differs from defaults)',
    '<!-- Add naming/structure/commit conventions that differ from defaults. -->',
    '',
    '## Boundaries — never do',
    '',
    '- (e.g. never touch the billing module without a feature flag)',
    '- (e.g. never run migrations outside CI)',
    '',
    '## Gotchas',
    '',
    '- (the things that bite: flaky tests, env quirks, slow builds)',
    '',
  ].join('\n');

  const summaryParts = [languages.join('/') || null, frameworks[0] || null, pkg ? pm : null].filter(Boolean);
  const summary = summaryParts.join(', ') || 'repo files';

  return { pack, contracts, summary };
}
