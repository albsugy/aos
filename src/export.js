import path from 'node:path';
import { syncContextFile, LEGACY_MARKER } from './context-sync.js';

// `aos export` — the original single-file form of context sync. Kept as an
// alias for muscle memory and scripts; it writes AGENTS.md with the same
// renderer as `aos context sync` and the same refusal to touch hand-written
// files. Files carrying the legacy marker upgrade in place.
export function exportAgentsMd(projectId, projectName, repoRoot) {
  const result = syncContextFile(projectId, projectName, repoRoot, 'AGENTS.md');
  if (!result.ok) throw new Error(result.error);
  return path.join(repoRoot, 'AGENTS.md');
}

export { LEGACY_MARKER };
