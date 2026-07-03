import fs from 'node:fs';
import path from 'node:path';
import { aosHome, projectDir, registryPath, readJson } from './paths.js';
import { loadRegistry, findProjectByCwd } from './registry.js';
import { loadPolicy } from './policy.js';

function check(label, fn) {
  try {
    const result = fn();
    if (result === false) return { label, ok: false, detail: '' };
    return { label, ok: true, detail: typeof result === 'string' ? result : '' };
  } catch (e) {
    return { label, ok: false, detail: e.message };
  }
}

export function runDoctor({ appRoot, version }) {
  const checks = [];

  checks.push(
    check('node version >= 18', () => {
      const major = Number(process.versions.node.split('.')[0]);
      if (major < 18) throw new Error(`found ${process.versions.node}`);
      return `v${process.versions.node}`;
    })
  );

  checks.push(check('aos app', () => `${version} at ${appRoot}`));

  checks.push(
    check('yaml dependency', () => {
      if (!fs.existsSync(path.join(appRoot, 'node_modules', 'yaml'))) {
        throw new Error('missing — run: aos update (or npm ci in the app dir)');
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
      check('hooks wired in this repo', () => {
        const repo = (project.repos || []).find(
          (r) => process.cwd() === r || process.cwd().startsWith(r + path.sep)
        );
        const settings = readJson(path.join(repo || process.cwd(), '.claude', 'settings.json'), null);
        if (!settings?.hooks) throw new Error('.claude/settings.json has no hooks — re-run aos init');
        const events = ['PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd'];
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
        return 'all four events, current format';
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
