import fs from 'node:fs';

// Best-effort token accounting from agent session transcripts.
//
// Claude Code transcripts are JSONL of `{message: {usage, model}}` entries —
// that is the format we can parse today. Other providers' transcripts are
// recorded with zero usage rather than guessed at: a wrong parser would
// produce numbers that look authoritative and are wrong, which is worse than
// an honest zero (capability `tokens` in each adapter says which is which).
export function sumTranscriptUsage(transcriptPath) {
  const usage = { input: 0, output: 0, cache_read: 0, models: {} };
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const u = entry?.message?.usage;
        if (!u) continue;
        usage.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        usage.output += u.output_tokens || 0;
        usage.cache_read += u.cache_read_input_tokens || 0;
        const model = entry?.message?.model;
        if (!model) continue;
        const b = (usage.models[model] = usage.models[model] || {
          input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0,
        });
        b.input += u.input_tokens || 0;
        b.output += u.output_tokens || 0;
        b.cache_read += u.cache_read_input_tokens || 0;
        const cc = u.cache_creation;
        if (cc && (cc.ephemeral_5m_input_tokens != null || cc.ephemeral_1h_input_tokens != null)) {
          b.cache_write_5m += cc.ephemeral_5m_input_tokens || 0;
          b.cache_write_1h += cc.ephemeral_1h_input_tokens || 0;
        } else {
          b.cache_write_5m += u.cache_creation_input_tokens || 0; // no TTL breakdown — assume 5m
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // transcript unavailable — return zeros
  }
  return usage;
}
