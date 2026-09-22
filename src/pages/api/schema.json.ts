import type { APIRoute } from 'astro';
import schema from '../../generated/schema.json';
import { json } from '../../lib/json.ts';

export const GET: APIRoute = () => json(schema);
