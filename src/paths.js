import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function aosHome() {
  return process.env.AOS_HOME || path.join(os.homedir(), '.aos');
}

export function projectsDir() {
  return path.join(aosHome(), 'projects');
}

export function projectDir(id) {
  return path.join(projectsDir(), id);
}

export function registryPath() {
  return path.join(aosHome(), 'registry.yaml');
}

export function configPath() {
  return path.join(aosHome(), 'config.yaml');
}

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

export function ensureHome() {
  ensureDir(projectsDir());
}

export function readIfExists(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function appendLine(p, line) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, line.endsWith('\n') ? line : line + '\n');
}

export function readJson(p, fallback = null) {
  const raw = readIfExists(p);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  // Atomic write: a crash mid-write must never leave truncated JSON behind.
  // The tmp name carries the pid so two concurrent writers can't stomp
  // each other's tmp file (last rename still wins, which is fine).
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, p);
}

// Advisory lock for read-modify-write cycles on shared JSON state (state.json,
// meta.json), so two concurrent sessions can't silently drop each other's
// update. Hooks must never hang a session, so waiting is bounded: on timeout
// we proceed unlocked — availability beats strict serialization here.
export function withLock(file, fn) {
  const lock = file + '.lock';
  ensureDir(path.dirname(lock));
  const deadline = Date.now() + 250;
  let held = false;
  while (!held && Date.now() < deadline) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      held = true;
    } catch {
      try {
        // A holder that died leaves the lock behind — reclaim after 2s.
        if (Date.now() - fs.statSync(lock).mtimeMs > 2000) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat — retry immediately
      }
      const spinUntil = Date.now() + 10;
      while (Date.now() < spinUntil); // contention is rare and sub-ms; a brief spin beats async plumbing
    }
  }
  try {
    return fn();
  } finally {
    if (held) {
      try {
        fs.unlinkSync(lock);
      } catch {
        // already reclaimed as stale — nothing to release
      }
    }
  }
}

export function tailLines(text, n) {
  const lines = text.trimEnd().split('\n');
  return lines.slice(Math.max(0, lines.length - n)).join('\n');
}

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'run';
}

export function today() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function nowIso() {
  return new Date().toISOString();
}
