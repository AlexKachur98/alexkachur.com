import type { APIRoute } from 'astro';
import { openDatabase } from '../../lib/ask/db.ts';
import { json } from '../../lib/json.ts';
import { queryOf, resumeData, resumeJson } from '../../lib/resume.ts';

// The resume in the JSON Resume format, from the database the site is built from.
export const GET: APIRoute = async ({ site }) => json(resumeJson(resumeData(queryOf(await openDatabase())), site!.origin));
