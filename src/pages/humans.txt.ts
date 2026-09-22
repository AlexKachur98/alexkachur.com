import type { APIRoute } from 'astro';
import buildInfo from '../generated/build-info.json';

const text = `/* TEAM */
Developer: Alex Kachur
Location: Toronto, Canada
Contact: alexkachur98@gmail.com
Site: alexkachur.com

/* SITE */
Last update: ${buildInfo.builtAt.slice(0, 10)}
Stack: Astro, TypeScript, CSS, sql.js, Vercel, Anthropic API, Upstash Redis
Fonts: Barlow, JetBrains Mono
`;

export const GET: APIRoute = () => new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
