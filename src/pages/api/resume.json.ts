import type { APIRoute } from 'astro';
import { json } from '../../lib/json.ts';
import { resumeJsonFor } from '../../lib/query.ts';

// The resume in the JSON Resume format, from the database the site is built from.
export const GET: APIRoute = async ({ site }) => json(await resumeJsonFor(site!.origin));
