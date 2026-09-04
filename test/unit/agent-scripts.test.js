import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, before, after } from 'node:test';

// The pi extension and the opencode plugin are TEMPLATES: installers bake
// `__AOS_CMD__` into a JSON argv array. A broken bake ships a script the
// agent cannot load — which happened once (double-quoted path became a
// division chain). These tests bake with an adversarial install path and
// prove the result parses and spawns correctly.

let repo;
before(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-bake-'));
  process.env.AOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-bake-home-'));
});
after(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.AOS_HOME, { recursive: true, force: true });
  delete process.env.AOS_HOME;
});

const { piInstaller } = await import('../../src/installers/pi.js');
const { opencodeInstaller } = await import('../../src/installers/opencode.js');
const esbuild = await import('esbuild');

test('baked agent scripts parse (adversarial install path: spaces + quotes)', async () => {
  // Pretend aos was launched from a path with a space and a quote — the bake
  // must survive it without shell quoting, as an argv array.
  const hostile = path.join(repo, 'ao s "quoted"');
  fs.writeFileSync(hostile, '#!/usr/bin/env node\n');
  fs.chmodSync(hostile, 0o755);
  const originalArgv1 = process.argv[1];
  process.argv[1] = hostile;
  try {
    piInstaller.wireHooks(repo);
    opencodeInstaller.wireHooks(repo);
  } finally {
    process.argv[1] = originalArgv1;
  }

  for (const file of [piInstaller.configPath(repo), opencodeInstaller.configPath(repo)]) {
    const body = fs.readFileSync(file, 'utf8');
    assert.ok(!body.includes('__AOS_CMD__'), `${file}: template placeholder survived the bake`);
    // the baked constant is a valid JSON argv array invoking our hostile path
    const m = /const AOS_CMD = (\[.*?\]);/.exec(body);
    assert.ok(m, `${file}: AOS_CMD not baked as an argv array`);
    const argv = JSON.parse(m[1]);
    assert.equal(argv[argv.length - 1], hostile);
    // and the whole script is syntactically valid TypeScript/JS
    await esbuild.transform(body, { loader: 'ts' });
  }
});

test('a non-executable launcher bakes to [node, launcher]', async () => {
  const plain = path.join(repo, 'aos-script.js');
  fs.writeFileSync(plain, '');
  const originalArgv1 = process.argv[1];
  process.argv[1] = plain;
  try {
    piInstaller.wireHooks(repo);
  } finally {
    process.argv[1] = originalArgv1;
  }
  const body = fs.readFileSync(piInstaller.configPath(repo), 'utf8');
  const argv = JSON.parse(/const AOS_CMD = (\[.*?\]);/.exec(body)[1]);
  assert.equal(argv[0], process.execPath);
  assert.equal(argv[1], plain);
  await esbuild.transform(body, { loader: 'ts' });
});

test('verify() flags an unbaked template and passes a real one', async () => {
  const v1 = piInstaller.verify(repo);
  assert.equal(v1.ok, true);
  fs.writeFileSync(piInstaller.configPath(repo), 'const AOS_CMD = __AOS_CMD__;\n');
  assert.equal(piInstaller.verify(repo).ok, false);
});
