import type { APIRoute, GetStaticPaths } from 'astro';
import { json } from '../../../lib/json.ts';
import { select } from '../../../lib/query.ts';

// One file per project: its row as the database holds it, numbers filled in, plus the names of its
// technologies.
export const getStaticPaths = (async () => {
  const projects = await select('SELECT * FROM projects ORDER BY id');
  return Promise.all(
    projects.rows.map(async (row) => {
      const project = Object.fromEntries(projects.columns.map((name, index) => [name, row[index]]));
      const stack = await select(
        `SELECT t.name FROM project_technologies pt JOIN technologies t ON t.id = pt.technology_id WHERE pt.project_id = ${Number(project.id)} ORDER BY t.id`,
      );
      return { params: { slug: String(project.slug) }, props: { ...project, technologies: stack.rows.map(([name]) => name) } };
    }),
  );
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) => json(props);
