// Unit tests for the project registry: how a cwd resolves to a project, and
// what happens when registry.yaml is damaged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.AOS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aos-registry-'));

const { addProject, findProjectByCwd, getProject, loadRegistry } =
  await import('../../src/registry.js');
const { registryPath } = await import('../../src/paths.js');

const repo = (name) => {
  const p = path.join(process.env.AOS_HOME, 'repos', name);
  fs.mkdirSync(p, { recursive: true });
  return fs.realpathSync(p);
};

test('addProject registers a repo and is idempotent', () => {
  const r = repo('alpha');
  addProject({ id: 'alpha', name: 'Alpha', repo: r });
  addProject({ id: 'alpha', name: 'Alpha', repo: r });
  const project = getProject('alpha');
  assert.equal(project.name, 'Alpha');
  assert.deepEqual(project.repos, [r], 'the same repo is not added twice');
});

test('a project can span several repos', () => {
  const a = repo('multi-a');
  const b = repo('multi-b');
  addProject({ id: 'multi', repo: a });
  addProject({ id: 'multi', repo: b });
  assert.deepEqual(getProject('multi').repos.sort(), [a, b].sort());
});

test('findProjectByCwd resolves from a subdirectory', () => {
  const r = repo('beta');
  addProject({ id: 'beta', repo: r });
  const deep = path.join(r, 'src', 'nested');
  fs.mkdirSync(deep, { recursive: true });
  assert.equal(findProjectByCwd(deep)?.id, 'beta');
});

test('findProjectByCwd: the most specific repo wins', () => {
  // A repo checked out inside another must resolve to itself, not its parent.
  const outer = repo('outer');
  const inner = path.join(outer, 'packages', 'inner');
  fs.mkdirSync(inner, { recursive: true });
  addProject({ id: 'outer', repo: outer });
  addProject({ id: 'inner', repo: inner });
  assert.equal(findProjectByCwd(inner)?.id, 'inner');
  assert.equal(findProjectByCwd(path.join(inner, 'src'))?.id, 'inner');
  assert.equal(findProjectByCwd(path.join(outer, 'src'))?.id, 'outer');
});

test('findProjectByCwd: a sibling with a shared prefix is not a match', () => {
  const r = repo('gamma');
  addProject({ id: 'gamma', repo: r });
  assert.equal(findProjectByCwd(r + '-other'), null, 'path matching is by segment, not string prefix');
});

test('an unregistered cwd resolves to nothing', () => {
  assert.equal(findProjectByCwd(os.tmpdir()), null);
  assert.equal(getProject('never-registered'), null);
});

test('a corrupt registry degrades for readers and blocks writers', () => {
  const saved = fs.readFileSync(registryPath(), 'utf8');
  fs.writeFileSync(registryPath(), 'projects: [oops\n  not: yaml');

  assert.deepEqual(loadRegistry().projects, [], 'readers see an empty registry rather than crashing');
  assert.throws(
    () => addProject({ id: 'new', repo: repo('delta') }),
    /corrupt/,
    'writers must refuse rather than overwrite what they cannot parse'
  );
  assert.equal(fs.readFileSync(registryPath(), 'utf8').includes('oops'), true, 'the file is untouched');

  fs.writeFileSync(registryPath(), saved);
  assert.ok(getProject('alpha'), 'and the good registry still reads afterwards');
});

test('a registry with the wrong shape reads as empty', () => {
  const saved = fs.readFileSync(registryPath(), 'utf8');
  fs.writeFileSync(registryPath(), 'projects: not-a-list\n');
  assert.deepEqual(loadRegistry().projects, []);
  fs.writeFileSync(registryPath(), saved);
});
