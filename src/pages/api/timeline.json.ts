import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { json } from '../../lib/json.ts';
import { timelineRows } from '../../lib/rows.ts';

export const GET: APIRoute = async () => json(timelineRows(await getCollection('timeline')));
