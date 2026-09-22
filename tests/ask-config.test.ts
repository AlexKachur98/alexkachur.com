import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CAP, MODEL, parseCap, readConfig } from '../src/lib/ask/config.ts';

function env(vars: Record<string, string | undefined> = {}) {
  return (name: string) => vars[name];
}

const upstash = { UPSTASH_REDIS_REST_URL: 'https://upstash.example', UPSTASH_REDIS_REST_TOKEN: 'upstash-token' };
const kv = { KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 'kv-token' };

describe('readConfig', () => {
  it('falls back to development, the pinned model and the default cap when nothing is set', () => {
    expect(MODEL.id).toBe('claude-haiku-4-5');
    expect(DEFAULT_CAP).toBe(2000);
    expect(readConfig(env())).toEqual({
      env: 'development',
      model: 'claude-haiku-4-5',
      maxTokens: 512,
      cap: 2000,
      apiKey: undefined,
      redis: null,
    });
  });

  it('takes the model override, the deployment environment and the key from the variables', () => {
    const config = readConfig(env({ ANTHROPIC_MODEL: 'model-from-env', VERCEL_ENV: 'preview', ANTHROPIC_API_KEY: 'sk-ant-test' }));
    expect(config.model).toBe('model-from-env');
    expect(config.env).toBe('preview');
    expect(config.apiKey).toBe('sk-ant-test');
    expect(config.maxTokens).toBe(512);
  });

  it('accepts either Redis pair and prefers the Upstash names when both are set', () => {
    expect(readConfig(env(upstash)).redis).toEqual({ url: 'https://upstash.example', token: 'upstash-token' });
    expect(readConfig(env(kv)).redis).toEqual({ url: 'https://kv.example', token: 'kv-token' });
    expect(readConfig(env({ ...upstash, ...kv })).redis).toEqual({ url: 'https://upstash.example', token: 'upstash-token' });
  });

  it('does not treat a url without a token as a pair', () => {
    expect(readConfig(env({ UPSTASH_REDIS_REST_URL: 'https://upstash.example' })).redis).toBeNull();
    expect(readConfig(env({ KV_REST_API_URL: 'https://kv.example' })).redis).toBeNull();
    expect(readConfig(env({ UPSTASH_REDIS_REST_TOKEN: 'upstash-token' })).redis).toBeNull();
    expect(readConfig(env({ UPSTASH_REDIS_REST_URL: 'https://upstash.example', ...kv })).redis).toEqual({
      url: 'https://kv.example',
      token: 'kv-token',
    });
  });

  it('treats a blank API key as missing', () => {
    expect(readConfig(env({ ANTHROPIC_API_KEY: '   ' })).apiKey).toBeUndefined();
    expect(readConfig(env({ ANTHROPIC_API_KEY: '' })).apiKey).toBeUndefined();
    expect(readConfig(env({ ANTHROPIC_API_KEY: ' sk-ant-test ' })).apiKey).toBe('sk-ant-test');
  });

  it('asks the getter for exactly the eight variable names', () => {
    const asked = new Set<string>();
    readConfig((name) => {
      asked.add(name);
      return undefined;
    });
    expect([...asked].sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL',
      'ASK_MONTHLY_CAP',
      'KV_REST_API_TOKEN',
      'KV_REST_API_URL',
      'UPSTASH_REDIS_REST_TOKEN',
      'UPSTASH_REDIS_REST_URL',
      'VERCEL_ENV',
    ]);
  });

  it('never reads process.env behind the getter', () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'model-from-process');
    vi.stubEnv('ANTHROPIC_API_KEY', 'key-from-process');
    try {
      const config = readConfig(env());
      expect(config.model).toBe('claude-haiku-4-5');
      expect(config.apiKey).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('parseCap', () => {
  // 0 is the kill switch, a real value and not a missing one.
  it.each([
    ['0', 0],
    ['50', 50],
    [' 7 ', 7],
    ['2000', 2000],
  ])('reads %j as %i', (raw, cap) => {
    expect(parseCap(raw)).toBe(cap);
  });

  it.each(['', '   ', 'abc', '-1', '12.5', '1e3', '+5', undefined])('falls back to the default for %j', (raw) => {
    expect(parseCap(raw)).toBe(2000);
  });
});
