// What the endpoints read from the environment, read per request through a getter, so nothing is
// inlined at build time and a missing variable gives the config branch instead of an error at
// module load.

export const MODEL = { id: 'claude-haiku-4-5', maxTokens: 512, timeoutMs: 15_000 } as const;

// The on-demand function's time limit on Vercel, set in astro.config.mjs.
export const FUNCTION_SECONDS = 30;

export const DEFAULT_CAP = 2000;

export type EnvGetter = (name: string) => string | undefined;

export interface AskConfig {
  env: string;
  model: string;
  maxTokens: number;
  cap: number;
  apiKey: string | undefined;
  // Keys the hash of each address; without it /api/ask and /api/questions answer 503 config.
  limitSecret: string | undefined;
  redis: { url: string; token: string } | null;
}

function value(raw: string | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

// A whole number of model calls per month; 0 turns the endpoint off. Anything else is the default.
export function parseCap(raw: string | undefined): number {
  const text = value(raw);
  return text !== undefined && /^\d+$/.test(text) ? Number(text) : DEFAULT_CAP;
}

function pair(url: string | undefined, token: string | undefined): { url: string; token: string } | null {
  const u = value(url);
  const t = value(token);
  return u && t ? { url: u, token: t } : null;
}

export function readConfig(get: EnvGetter): AskConfig {
  return {
    env: value(get('VERCEL_ENV')) ?? 'development',
    model: value(get('ANTHROPIC_MODEL')) ?? MODEL.id,
    maxTokens: MODEL.maxTokens,
    cap: parseCap(get('ASK_MONTHLY_CAP')),
    apiKey: value(get('ANTHROPIC_API_KEY')),
    limitSecret: value(get('ASK_RATE_LIMIT_SECRET')),
    // The Marketplace integration injects one of two name pairs; either is accepted, Upstash's first.
    redis: pair(get('UPSTASH_REDIS_REST_URL'), get('UPSTASH_REDIS_REST_TOKEN')) ?? pair(get('KV_REST_API_URL'), get('KV_REST_API_TOKEN')),
  };
}
