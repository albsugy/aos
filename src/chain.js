import crypto from 'node:crypto';
import fs from 'node:fs';
import { appendLineRotated, withLock } from './paths.js';

// The tamper-evident audit chain.
//
// Every line appended to an audit ledger carries `chain: {seq, hash}`, where
// hash = sha256(prevHash + '\n' + payload) over the line's own payload (the
// entry without the chain field). Editing or deleting any line after the
// fact breaks the link at that point; `aos audit verify` walks the ledger
// and reports the first line that no longer adds up.
//
// What this proves: the ledger is byte-for-byte as it was written. What it
// does not prove: who wrote it — a process with write access can still append
// new lines (the chain forgives appends, as an append-only log must). The
// threat covered is post-hoc editing of what already happened, which is the
// audit trail's actual failure mode.
//
// Lines written before this feature have no chain field. They are counted as
// `legacy`, not failures — the chain starts at the first chained line and
// everything after it must hold together. An unchained line AFTER the chain
// started is reported: it is either tampering or a downgraded AOS, and both
// are worth seeing.

export const GENESIS = 'aos-genesis-v1';
const TAIL_BYTES = 8192;

// Append one chained line to a ledger file. Read-prev → build → append under
// the advisory lock so two concurrent appends can't fork the chain; if the
// lock times out we append anyway (the project's stated trade: availability
// over strict serialization — a forked link is detectable by `aos audit
// verify`, a dropped audit line is not recoverable at all).
//
// When the current file has no chain state but a rotated generation exists,
// continue from the ROTATED file's state: rotation renames current → rotated
// and then appends, and a crash between the two leaves exactly that shape.
// Starting a fresh chain there would fork the ledger at seq 0 forever.
export function appendChainedTo(file, rotated, entry) {
  withLock(file, () => {
    const prev = chainStateFromFile(file) || chainStateFromFile(rotated);
    const { line } = buildChainedLine(prev, entry);
    appendLineRotated(file, line, rotated);
  });
}

export function chainHash(prevHash, payloadLine) {
  return crypto.createHash('sha256').update(prevHash + '\n' + payloadLine, 'utf8').digest('hex');
}

// The payload half of a line: the parsed entry minus its chain field. Key
// order is preserved by JSON round-trip, so re-stringifying reproduces the
// exact bytes the writer hashed — this is what makes verification possible
// without storing payloads twice.
function payloadOf(parsed) {
  const { chain, ...rest } = parsed;
  return rest;
}

// Build the next chained line for a ledger whose last chained state is
// {seq, hash} (null when the ledger is empty or fully legacy).
export function buildChainedLine(prev, entry) {
  const payloadLine = JSON.stringify(entry);
  const seq = prev ? prev.seq + 1 : 0;
  const hash = chainHash(prev ? prev.hash : GENESIS, payloadLine);
  return {
    line: JSON.stringify({ ...entry, chain: { seq, hash } }),
    state: { seq, hash },
  };
}

// The last complete line of a file, read from the tail only — appendAudit
// runs on every tool call, so the read must stay O(1) against a 10MB ledger.
// Returns null when the file is absent or has no usable last line.
export function lastLineOf(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    if (size === 0) return null;
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.trim());
    // When the tail read started mid-file, the first fragment may be a
    // partial line — only trust it if it is the only one (it ends the file,
    // and a trailing fragment that ends at EOF is complete).
    if (lines.length > 1 && len < size) lines.shift();
    const last = lines[lines.length - 1];
    return last || null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

// The chain state to continue from: the last line's {seq, hash} when it is
// chained, else null (start a fresh chain at seq 0 — a crash-truncated last
// line or a legacy ledger both land here, and appending must never fail).
export function chainStateFromFile(file) {
  const last = lastLineOf(file);
  if (!last) return null;
  try {
    const parsed = JSON.parse(last);
    if (parsed && typeof parsed === 'object' && parsed.chain && Number.isInteger(parsed.chain.seq) && typeof parsed.chain.hash === 'string') {
      return { seq: parsed.chain.seq, hash: parsed.chain.hash };
    }
  } catch {
    // malformed tail — treat as no chain state
  }
  return null;
}

// Verify one ledger, given its files in chronological order (rotated
// generation first, current last). Returns
// { file, lines, chained, legacy, ok, problems: [{line, issue}] }.
//
// `problems` is capped (first 5) — one tampered ledger reports its break,
// not a screen of every consequence downstream of it.
export function verifyLedger(files) {
  const report = { files: [], lines: 0, chained: 0, legacy: 0, ok: true, problems: [] };
  let prev = null; // {seq, hash} — null until the first chained line
  let lineNo = 0;

  const problem = (issue) => {
    report.ok = false;
    if (report.problems.length < 5) report.problems.push({ line: lineNo, issue });
  };

  for (const file of files) {
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // absent generation — nothing to verify
    }
    report.files.push(file);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      lineNo++;
      report.lines++;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A malformed line after the chain started is evidence (truncation or
        // tampering); before it, legacy writes were looser — count and move on.
        if (prev) problem(`line ${lineNo}: not valid JSON`);
        else report.legacy++;
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || !parsed.chain) {
        if (prev) problem(`line ${lineNo}: unchained entry after the chain started (line ${prev.seq + 1} was chained)`);
        else report.legacy++;
        continue;
      }
      const seq = parsed.chain.seq;
      const hash = parsed.chain.hash;
      if (!Number.isInteger(seq) || typeof hash !== 'string') {
        problem(`line ${lineNo}: chain field malformed (seq/hash)`);
        continue;
      }
      const expectSeq = prev ? prev.seq + 1 : 0;
      if (seq !== expectSeq) {
        problem(`line ${lineNo}: chain seq ${seq} does not follow ${prev ? prev.seq : '(none)'} — lines were inserted, deleted, or reordered`);
        // Continue from the declared state so one bad link doesn't cascade.
        prev = { seq, hash };
        report.chained++;
        continue;
      }
      const actual = chainHash(prev ? prev.hash : GENESIS, JSON.stringify(payloadOf(parsed)));
      if (actual !== hash) {
        problem(`line ${lineNo}: hash mismatch — this entry was modified after it was written`);
        prev = { seq, hash };
        report.chained++;
        continue;
      }
      prev = { seq, hash };
      report.chained++;
    }
  }
  return report;
}
