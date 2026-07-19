import fs from 'node:fs';
import path from 'node:path';
import { projectDir } from './paths.js';

function* walkFiles(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(p);
    else if (/\.(md|jsonl|yaml)$/.test(entry.name)) yield p;
  }
}

export function findInProject(projectId, query, maxHits = 40) {
  const root = projectDir(projectId);
  const needle = query.toLowerCase();
  const hits = [];
  for (const file of walkFiles(root)) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(needle)) {
        hits.push({ file: path.relative(root, file), line: i + 1, text: lines[i].trim().slice(0, 200) });
        if (hits.length >= maxHits) return hits;
      }
    }
  }
  return hits;
}

export function printFind(projectId, query) {
  const hits = findInProject(projectId, query);
  if (!hits.length) {
    console.log(`No matches for "${query}" in project ${projectId}.`);
    return;
  }
  console.log(`Matches for "${query}" (project root: ${projectDir(projectId)}):\n`);
  for (const h of hits) console.log(`${h.file}:${h.line}  ${h.text}`);
}

// Cross-project search: the memory query a fleet/primary agent needs —
// "have we solved this anywhere before?" — swept over every project's files.
export function printFindAll(projects, query, maxHits = 60) {
  let total = 0;
  for (const p of projects) {
    const hits = findInProject(p.id, query, Math.max(1, maxHits - total));
    if (!hits.length) continue;
    console.log(`■ ${p.id}`);
    for (const h of hits) console.log(`  ${h.file}:${h.line}  ${h.text}`);
    total += hits.length;
    if (total >= maxHits) {
      console.log(`\n(capped at ${maxHits} hits — narrow the query or use --project)`);
      return;
    }
  }
  if (!total) console.log(`No matches for "${query}" in any project.`);
}
