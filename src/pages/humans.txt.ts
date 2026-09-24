import type { APIRoute } from 'astro';
import buildInfo from '../generated/build-info.json';
import { siteFacts } from '../lib/facts.ts';
import { select } from '../lib/query.ts';

export const GET: APIRoute = async ({ site }) => {
  const facts = await siteFacts();
  // The stack is this site's own project's technologies, as a visitor's query would list them.
  const stack = await select(
    "SELECT t.name FROM projects p JOIN project_technologies pt ON pt.project_id = p.id JOIN technologies t ON t.id = pt.technology_id WHERE p.slug = 'this-site' ORDER BY lower(t.name), t.name",
  );
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
