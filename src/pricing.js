import path from 'node:path';
import YAML from 'yaml';
import { aosHome, readIfExists } from './paths.js';

// USD per million tokens, matched against model ids first-match-wins (specific
// rules before family globs). Cache derivations follow Anthropic's published
// multipliers: reads 0.1x the input rate, 5-minute cache writes 1.25x,
// 1-hour writes 2x — overridable per rule.
//
// These are estimates at API list prices: subscription (Max/Pro) usage isn't
// billed per token, and Bedrock/Vertex differ. Users can override or extend
// the table at ~/.aos/pricing.yaml (same shape; user rules take precedence).
const DEFAULT_PRICING = [
  { match: 'claude-fable-*', input: 10, output: 50 },
  { match: 'claude-mythos-*', input: 10, output: 50 },
  // Opus 4.1 and older kept the legacy $15/$75; 4.5+ moved to $5/$25.
  { match: 'claude-opus-4-1*', input: 15, output: 75 },
  { match: 'claude-opus-4-2*', input: 15, output: 75 },
  { match: 'claude-opus-4-0*', input: 15, output: 75 },
  { match: 'claude-opus-*', input: 5, output: 25 },
  { match: 'claude-sonnet-*', input: 3, output: 15 },
  { match: 'claude-haiku-4*', input: 1, output: 5 },
  { match: 'claude-haiku-*', input: 0.25, output: 1.25 },
  { match: 'claude-3-5-haiku*', input: 0.8, output: 4 },
];

function globToRegExp(glob) {
  return new RegExp(
    '^' + String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$',
    'i'
  );
}

export function loadPricing() {
  const raw = readIfExists(path.join(aosHome(), 'pricing.yaml'));
  if (!raw) return DEFAULT_PRICING;
  try {
    const user = YAML.parse(raw);
    if (!Array.isArray(user)) return DEFAULT_PRICING;
    // User rules first: they win over the bundled defaults.
    return [...user.filter((r) => r && r.match), ...DEFAULT_PRICING];
  } catch {
    return DEFAULT_PRICING;
  }
}

function rateFor(modelId, pricing) {
  for (const rule of pricing) {
    let re;
    try {
      re = globToRegExp(rule.match);
    } catch {
      continue;
    }
    if (re.test(modelId)) {
      return {
        input: rule.input || 0,
        output: rule.output || 0,
        cache_read: rule.cache_read ?? (rule.input || 0) * 0.1,
        cache_write_5m: rule.cache_write_5m ?? (rule.input || 0) * 1.25,
        cache_write_1h: rule.cache_write_1h ?? (rule.input || 0) * 2,
      };
    }
  }
  return null;
}

// usage buckets: { modelId: { input, output, cache_read, cache_write_5m, cache_write_1h } }
// Returns { usd, unpriced } — usd is null when nothing could be priced;
// unpriced counts tokens whose model has no pricing rule (never guessed).
export function costOf(modelBuckets) {
  if (!modelBuckets || typeof modelBuckets !== 'object') return { usd: null, unpriced: 0 };
  const pricing = loadPricing();
  let usd = null;
  let unpriced = 0;
  for (const [modelId, u] of Object.entries(modelBuckets)) {
    const rate = rateFor(modelId, pricing);
    const tokens =
      (u.input || 0) + (u.output || 0) + (u.cache_read || 0) + (u.cache_write_5m || 0) + (u.cache_write_1h || 0);
    if (!rate) {
      unpriced += tokens;
      continue;
    }
    usd =
      (usd || 0) +
      ((u.input || 0) * rate.input +
        (u.output || 0) * rate.output +
        (u.cache_read || 0) * rate.cache_read +
        (u.cache_write_5m || 0) * rate.cache_write_5m +
        (u.cache_write_1h || 0) * rate.cache_write_1h) /
        1_000_000;
  }
  return { usd, unpriced };
}

export function fmtUsd(usd) {
  if (usd === null || usd === undefined) return null;
  if (usd > 0 && usd < 0.01) return '<$0.01';
  if (usd >= 100) return `$${Math.round(usd)}`;
  return `$${usd.toFixed(2)}`;
}
