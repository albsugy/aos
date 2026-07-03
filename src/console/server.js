import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fullState } from '../status.js';
import { runDir, runMeta } from '../run.js';
import { readIfExists } from '../paths.js';

const UI_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui.html');

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// IDs come from URL params and are used in filesystem paths — reject anything
// that could traverse (slashes, dot-dot) before it reaches path.join.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/;
function safeId(id) {
  return typeof id === 'string' && SAFE_ID.test(id) && !id.includes('..') ? id : null;
}

// The server binds to 127.0.0.1, but a malicious website can still reach it
// via DNS rebinding — its hostname resolving to 127.0.0.1 while the browser
// sends that hostname in Host. Only serve requests addressed to localhost.
function localHost(req) {
  const host = String(req.headers.host || '').split(':')[0];
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

function runDetail(projectId, runId) {
  const meta = runMeta(projectId, runId);
  if (!meta) return null;
  const dir = runDir(projectId, runId);
  const auditRaw = readIfExists(path.join(dir, 'audit.jsonl')) || '';
  const audit = auditRaw
    .split('\n')
    .filter(Boolean)
    .slice(-60)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return {
    meta,
    audit,
    ticket: readIfExists(path.join(dir, 'ticket.md')),
    plan: readIfExists(path.join(dir, 'plan.md')),
    outcome: readIfExists(path.join(dir, 'outcome.md')),
    verification: readIfExists(path.join(dir, 'verification.md')),
  };
}

export function serveConsole(port = 4560) {
  const server = http.createServer((req, res) => {
    if (!localHost(req)) return json(res, 403, { error: 'forbidden host' });
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    try {
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fs.readFileSync(UI_PATH));
      } else if (url.pathname === '/api/state') {
        json(res, 200, fullState());
      } else if (url.pathname === '/api/run') {
        const project = safeId(url.searchParams.get('project'));
        const run = safeId(url.searchParams.get('run'));
        if (!project || !run) return json(res, 400, { error: 'invalid project or run id' });
        const detail = runDetail(project, run);
        if (!detail) return json(res, 404, { error: 'run not found' });
        json(res, 200, detail);
      } else {
        json(res, 404, { error: 'not found' });
      }
    } catch (e) {
      json(res, 500, { error: String(e.message || e) });
    }
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`Port ${port} is already in use — try: aos console --port ${port + 1}`);
      process.exit(1);
    }
    console.error(`Console failed to start: ${e.message}`);
    process.exit(1);
  });
  // Local-only by design: the console is a read-only window for the operator.
  server.listen(port, '127.0.0.1', () => {
    console.log(`AOS console → http://127.0.0.1:${port}`);
  });
  return server;
}
