import type { APIRoute } from 'astro';
import buildInfo from '../../generated/build-info.json';
import { readConfig } from '../../lib/ask/config.ts';
import { env } from '../../lib/ask/env.ts';
import { handleStats } from '../../lib/ask/stats.ts';
import { storeFor } from '../../lib/ask/store.ts';

export const prerender = false;

export const GET: APIRoute = () => {
  const config = readConfig(env);
  return handleStats({ config, store: storeFor(config, import.meta.env.DEV), build: buildInfo });
};
