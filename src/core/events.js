import crypto from 'node:crypto';
import path from 'node:path';

// ── The normalized event protocol ────────────────────────────────────────
//
// Every adapter (claude, codex, cursor, …) translates its provider's hook
// payload into ONE event shape before anything policy-shaped sees it. The
// policy engine never learns a provider tool name; the adapters never learn
// what a policy is. This is the whole boundary of "works with any agent".
//
//   {
//     schema: 1,
//     provider: 'codex',
//     event: 'tool.before' | 'tool.after' | 'session.start' |
//            'session.end' | 'stop',
//     session: '…' | null,          // provider's session id
//     cwd: '/repo',
//     transcriptPath: '…' | null,   // only providers that emit transcripts
//     permissionMode: 'default' | 'plan' | … | null,
//     tool: { kind: 'shell' | 'file' | 'other', name: 'Bash' | 'apply_patch' | … },
//     operation: { command?: string, paths?: string[], contents?: string[] },
//   }
//
// `tool.name` stays the PROVIDER's spelling (it goes to the audit trail,
// which is evidence about a specific agent); `tool.kind` is the neutral
// classifier the policy engine switches on.

export const EVENT_SCHEMA = 1;

export function shellEvent(provider, payload, name) {
  return {
    schema: EVENT_SCHEMA,
    provider,
    event: 'tool.before',
    session: payload.session || payload.session_id || null,
    cwd: payload.cwd || process.cwd(),
    transcriptPath: payload.transcript_path || null,
    permissionMode: payload.permission_mode || null,
    tool: { kind: 'shell', name },
    operation: { command: String(payload.tool_input?.command || '') },
  };
}

export function fileEvent(provider, payload, name, { paths, contents }) {
  return {
    schema: EVENT_SCHEMA,
    provider,
    event: 'tool.before',
    session: payload.session || payload.session_id || null,
    cwd: payload.cwd || process.cwd(),
    transcriptPath: payload.transcript_path || null,
    permissionMode: payload.permission_mode || null,
    tool: { kind: 'file', name },
    operation: { paths, contents },
  };
}

export function lifecycleEvent(provider, payload, event) {
  return {
    schema: EVENT_SCHEMA,
    provider,
    event,
    session: payload.session || payload.session_id || null,
    cwd: payload.cwd || process.cwd(),
    transcriptPath: payload.transcript_path || null,
    permissionMode: payload.permission_mode || null,
    tool: null,
    operation: {},
  };
}

// ── Codex apply_patch parsing ────────────────────────────────────────────
//
// Codex edits files through a patch format rather than per-file tools:
//
//   *** Begin Patch
//   *** Add File: path/to/new.js
//   +line
//   *** Update File: path/to/existing.js
//   *** Delete File: path/to/gone.js
//   *** End Patch
//
// Parse it into per-path operations so the SAME file-write gates that see a
// Claude `Write` see a Codex patch: protected paths, script-content scanning,
// plan gate, scope gate. Paths are repo-relative and resolved by the caller.

const PATCH_HEADER = /^\*\*\*\s+(Add|Update|Delete)\s+File:\s*(.+?)\s*$/;

export function parseApplyPatch(patchText) {
  const out = []; // { op: 'add'|'update'|'delete', path, added: string[] }
  let current = null;
  for (const line of String(patchText || '').split('\n')) {
    const header = PATCH_HEADER.exec(line);
    if (header) {
      if (current) out.push(current);
      current = { op: header[1].toLowerCase(), path: header[2], added: [] };
      continue;
    }
    if (/^\*\*\*\s+(Begin|End)\s+Patch/.test(line)) continue;
    if (current && line.startsWith('+')) current.added.push(line.slice(1));
  }
  if (current) out.push(current);
  // A "delete" is a write to gate even though it carries no content.
  return out.slice(0, 100); // bound: a pathological patch must not stall the gate
}

export function codexFileOperation(command) {
  const ops = parseApplyPatch(command);
  return {
    paths: ops.map((o) => o.path),
    contents: ops.map((o) => o.added.join('\n')),
    ops,
  };
}

// ── Operation identity ───────────────────────────────────────────────────
//
// Stable fingerprint of WHAT an operation does, used to bind external
// approvals to the exact retry: shell commands hash the command text, file
// writes hash the target paths (not the content — an agent legitimately
// rewrites the same file with a small fix while retrying).
export function operationFingerprint(event) {
  const kind = event.tool?.kind;
  let identity;
  if (kind === 'shell') identity = { kind, command: event.operation.command };
  else if (kind === 'file') identity = { kind, paths: event.operation.paths || [] };
  else identity = { kind: kind || 'other' };
  return crypto.createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

// Absolute targets of a file event, resolved against the event's cwd the way
// the runtime would (relative paths in patches and writes are cwd-relative).
export function absoluteTargets(event) {
  const cwd = event.cwd || process.cwd();
  return (event.operation.paths || []).map((p) =>
    path.isAbsolute(p) ? p : path.resolve(cwd, p)
  );
}
