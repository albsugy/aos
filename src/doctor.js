import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aosHome, projectDir, registryPath, readJson } from './paths.js';
import { loadRegistry, findProjectByCwd } from './registry.js';
import { loadPolicy } from './policy.js';

// A wired hook whose command does not resolve is the worst state AOS can be
// in: every session looks normal and every gate is off, because the launcher
// ends in `|| true` precisely so a missing aos can't break the session. So
// resolve it here the way the shell would — the embedded launcher path (with
// $HOME/~ expanded), then the PATH fallback.
export function resolveHookCommand(command, { home = os.homedir(), pathEnv = process.env.PATH || '' } = {}) {
  const cmd = String(command || '');
  const launcher = (cmd.match(/^\s*"([^"]+)"/) || cmd.match(/^\s*(\S+)/) || [])[1] || '';
  const expanded = launcher
    .replace(/^\$HOME\b/, home)
    .replace(/^\$\{HOME\}/, home)
    .replace(/^~(?=\/|$)/, home);
  if (expanded && fs.existsSync(expanded)) return { ok: true, via: expanded };
  // The `|| aos <cmd>` fallback: a bare `aos` found on PATH.
  if (/\|\|\s*aos\s/.test(cmd)) {
    for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
      const candidate = path.join(dir, 'aos');
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return { ok: true, via: candidate };
      } catch {
        // keep looking
      }
    }
  }
  return { ok: false, via: expanded || launcher };
}

function check(label, fn) {
  try {
    const result = fn();
    if (result === false) return { label, ok: false, detail: '' };
    return { label, ok: true, detail: typeof result === 'string' ? result : '' };
  } catch (e) {
    return { label, ok: false, detail: e.message };
  }
}

export function runDoctor({ appRoot, version, bundled = false }) {
  const checks = [];

  checks.push(
    check('node version >= 22', () => {
      const major = Number(process.versions.node.split('.')[0]);
      if (major < 22) throw new Error(`found ${process.versions.node}`);
      return `v${process.versions.node}`;
    })
  );

  checks.push(
    check('aos app', () => {
      const mode = fs.existsSync(path.join(appRoot, '.git')) ? 'dev checkout' : 'release artifact';
      return `${version} (${bundled ? 'compiled bundle' : 'source'}, ${mode}) at ${appRoot}`;
    })
  );

  checks.push(
    check('install layout', () => {
      const missing = ['assets', 'dist'].filter((d) => !fs.existsSync(path.join(appRoot, d)));
      if (missing.length) throw new Error(`missing ${missing.join(', ')} — reinstall`);
      return 'dist + assets present';
    })
  );

  checks.push(
    check('dependencies', () => {
      if (bundled) return 'inlined in dist/aos.mjs';
      if (!fs.existsSync(path.join(appRoot, 'node_modules', 'yaml'))) {
        throw new Error('missing — run: npm ci in the app dir');
      }
      return 'installed';
    })
  );

  checks.push(
    check('AOS_HOME writable', () => {
      fs.mkdirSync(aosHome(), { recursive: true });
      const probe = path.join(aosHome(), '.doctor-probe');
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      return aosHome();
    })
  );

  checks.push(
    check('registry parses', () => {
      if (!fs.existsSync(registryPath())) return 'no registry yet (run aos init in a repo)';
      const reg = loadRegistry({ strict: true });
      return `${reg.projects.length} project(s)`;
    })
  );

  checks.push(
    check('registered repo paths exist', () => {
      const reg = loadRegistry();
      const dangling = [];
      for (const p of reg.projects) {
        for (const r of p.repos || []) if (!fs.existsSync(r)) dangling.push(`${p.id}: ${r}`);
      }
      if (dangling.length) throw new Error(`dangling — ${dangling.join('; ')}`);
      return 'all present';
    })
  );

  checks.push(
    check('hooks failing silently', () => {
      // Hooks swallow their own errors so a broken AOS can never break a
      // session — this is where those swallowed errors surface.
      const log = path.join(aosHome(), 'hook-errors.log');
      if (!fs.existsSync(log)) return 'none logged';
      const lines = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean);
      if (!lines.length) return 'none logged';
      throw new Error(`${lines.length} hook failure(s) logged — inspect, then clear: ${log}`);
    })
  );

  const project = findProjectByCwd(process.cwd());
  checks.push(
    check('current directory', () => {
      if (!project) return 'not an AOS project (aos init to register)';
      return `project "${project.id}"`;
    })
  );

  if (project) {
    checks.push(
      check('project policy parses', () => {
        loadPolicy(project.id);
        return path.join(projectDir(project.id), 'policy.yaml');
      })
    );
    checks.push(
      // Deliberately a FAILURE, not a note. dry_run leaves every gate reporting
      // and none of them enforcing, and it looks identical to a healthy install
      // from inside a session — nothing prompts, so nothing seems wrong. The
      // only safe default is for doctor to keep saying so until it's turned off.
      check('gates enforcing (not dry-run)', () => {
        if (loadPolicy(project.id).dry_run !== true) return 'yes';
        throw new Error(
          'dry_run: true in policy.yaml — gate decisions are being RECORDED, not enforced. ' +
            'Nothing is blocked and nothing prompts. Review with `aos status`, then set dry_run: false.'
        );
      })
    );
    checks.push(
      check('hooks wired in this repo', () => {
        const repo = (project.repos || []).find(
          (r) => process.cwd() === r || process.cwd().startsWith(r + path.sep)
        );
        const settings = readJson(path.join(repo || process.cwd(), '.claude', 'settings.json'), null);
        if (!settings?.hooks) throw new Error('.claude/settings.json has no hooks — re-run aos init');
        // Stop is load-bearing, not optional: it is the whole mechanism for
        // draining the review queue and capturing learnings in-session. A repo
        // missing it looks perfectly healthy while both silently never fire.
        const events = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'Stop'];
        const missing = events.filter(
          (ev) =>
            !(settings.hooks[ev] || []).some((e) =>
              (e.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('aos'))
            )
        );
        if (missing.length) throw new Error(`missing: ${missing.join(', ')} — re-run aos init`);
        const pinned = events.some((ev) =>
          (settings.hooks[ev] || []).some((e) =>
            (e.hooks || []).some(
              (h) => typeof h.command === 'string' && h.command.includes('aos') && !h.command.includes('|| true')
            )
          )
        );
        if (pinned) throw new Error('old-format hooks (pinned path) — re-run aos init to migrate');
        const fileGated = (settings.hooks.PreToolUse || []).some(
          (e) =>
            /Write/.test(e.matcher || '') &&
            (e.hooks || []).some((h) => typeof h.command === 'string' && h.command.includes('aos'))
        );
        if (!fileGated) {
          throw new Error('PreToolUse only gates Bash — re-run aos init to extend gating to file writes');
        }
        return `all ${events.length} events, current format`;
      })
    );
    checks.push(
      check('hook command resolves', () => {
        const repo = (project.repos || []).find(
          (r) => process.cwd() === r || process.cwd().startsWith(r + path.sep)
        );
        const settings = readJson(path.join(repo || process.cwd(), '.claude', 'settings.json'), null);
        const commands = Object.values(settings?.hooks || {})
          .flat()
          .flatMap((e) => e.hooks || [])
          .map((h) => h.command)
          .filter((c) => typeof c === 'string' && c.includes('aos'));
        if (!commands.length) throw new Error('no aos hook commands to resolve — re-run aos init');
        const broken = commands.filter((c) => !resolveHookCommand(c).ok);
        if (broken.length) {
          throw new Error(
            `${broken.length}/${commands.length} hook command(s) point at a missing aos — ` +
              'gates and audit are SILENTLY OFF (hooks end in `|| true`). Re-run aos init here.'
          );
        }
        return `${resolveHookCommand(commands[0]).via}`;
      })
    );
  }

  let failed = 0;
  for (const c of checks) {
    const mark = c.ok ? '✅' : '❌';
    console.log(`${mark} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
    if (!c.ok) failed++;
  }
  console.log(failed ? `\n${failed} problem(s) found.` : '\nAll clear.');
  return failed === 0;
}
