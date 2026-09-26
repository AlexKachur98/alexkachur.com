import type { APIRoute } from 'astro';
import buildInfo from '../generated/build-info.json';
import { siteFacts } from '../lib/facts.ts';
import { select } from '../lib/query.ts';
import { stackQuery } from '../lib/rows.ts';

export const GET: APIRoute = async ({ site }) => {
  const facts = await siteFacts();
  // The stack is this site's own project's technologies.
  const [[id]] = (await select("SELECT id FROM projects WHERE slug = 'this-site'")).rows;
  const stack = await select(stackQuery(Number(id)));
  const text = `/* TEAM */
Developer: ${facts.name}
Location: ${facts.location}
Contact: ${facts.email}
Site: ${new URL(site!).host}

/* SITE */
Last update: ${buildInfo.builtAt.slice(0, 10)}
Stack: ${stack.rows.map(([name]) => name).join(', ')}
Fonts: Barlow, JetBrains Mono
`;
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
};
