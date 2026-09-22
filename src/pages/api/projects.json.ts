import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { json } from '../../lib/json.ts';
import { projectRows } from '../../lib/rows.ts';

export const GET: APIRoute = async () => json(projectRows(await getCollection('projects')));
