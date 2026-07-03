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
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
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
