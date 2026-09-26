import type { APIRoute, GetStaticPaths } from 'astro';
import { json } from '../../../lib/json.ts';
import { projectDetail, tableObjects } from '../../../lib/query.ts';

// One file per project: its row as the database holds it, numbers filled in, plus the names of its
// technologies.
export const getStaticPaths = (async () => {
  const projects = await tableObjects('projects');
  return Promise.all(projects.map(async (project) => ({ params: { slug: String(project.slug) }, props: await projectDetail(project) })));
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) => json(props);
