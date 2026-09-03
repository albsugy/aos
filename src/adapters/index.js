import { claudeAdapter } from './claude.js';
import { codexAdapter } from './codex.js';
import { cursorAdapter } from './cursor.js';

// The adapter registry. Adding an agent = writing one adapter here and one
// entry in the agents catalog (src/agents.js). Nothing else in AOS learns
// provider names except where evidence is recorded (audit `provider` field).

export const ADAPTERS = {
  claude: claudeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
};

export function getAdapter(id) {
  return ADAPTERS[id] || null;
}
