import fs from 'node:fs';
import path from 'node:path';

// What branch is this repo on, read straight off disk.
//
// No subprocess and no network: the CLI's headline promise is that it shells
// out for nothing but your own verification contracts, and spawning `git` on
// every `run start` would quietly break that. `.git/HEAD` is a one-line file
// and has been for the entire history of git.
//
// Handles the three shapes that actually occur: a normal checkout, a detached
// HEAD, and a linked worktree (where `.git` is a FILE pointing at the real
// git dir — the case that silently returns nothing if you only stat a
// directory).
export function gitBranch(repoRoot) {
  try {
    const gitPath = path.join(repoRoot, '.git');
    const stat = fs.statSync(gitPath);
    let gitDir = gitPath;
    if (stat.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(gitPath, 'utf8'));
      if (!pointer) return null;
      gitDir = path.resolve(repoRoot, pointer[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    if (ref) return ref[1];
    // Detached HEAD is a real state a run can happen on; say so rather than
    // pretending there is no branch.
    return /^[0-9a-f]{7,40}$/i.test(head) ? `detached@${head.slice(0, 7)}` : null;
  } catch {
    return null; // not a git repo, or unreadable — a run does not need one
  }
}

// Only http(s) links are ever stored or rendered. A `javascript:` or `data:`
// URL in meta.json would become a click target in the console, so it is
// rejected at the point of capture as well as at the point of display.
export function safeUrl(value) {
  const url = String(value || '').trim();
  if (!url || url.length > 2000) return null;
  return /^https?:\/\/[^\s<>"']+$/i.test(url) ? url : null;
}

// `--ticket` accepts an id or a URL. When it is a URL, keep the link and derive
// a short id from its tail so the run folder is still named something readable
// (a run called `2026-07-26-https-linear-app-acme-issue-lin-482` helps nobody).
export function parseTicket(value) {
  const raw = String(value || '').trim();
  const url = safeUrl(raw);
  if (!url) return { id: raw || null, url: null };
  const tail = url.replace(/[/#?]+$/, '').split(/[/#?]/).filter(Boolean).pop() || 'ticket';
  // A lone or malformed `%` is legal in a URL and throws here. Losing the whole
  // `run start` to a tracker link with a percent in it is not a trade worth
  // making — fall back to the raw tail.
  let id = tail;
  try {
    id = decodeURIComponent(tail);
  } catch {
    // keep the undecoded form
  }
  return { id: id.slice(0, 60), url };
}
