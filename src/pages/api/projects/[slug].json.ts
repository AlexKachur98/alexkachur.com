import type { APIRoute, GetStaticPaths } from 'astro';
import { getCollection } from 'astro:content';
import { json } from '../../../lib/json.ts';
import { projectRows, projectTechnologyRows, technologyRows } from '../../../lib/rows.ts';

// One file per project: the projects row plus the names of its technologies.
export const getStaticPaths = (async () => {
  const [projects, technologies] = await Promise.all([getCollection('projects'), getCollection('technologies')]);
  const names = new Map(technologyRows(technologies).map((row) => [row.id, row.name]));
  const links = projectTechnologyRows(projects, technologies);
  return projectRows(projects).map((project) => ({
    params: { slug: project.slug },
    props: {
      ...project,
      technologies: links.filter((link) => link.project_id === project.id).map((link) => names.get(link.technology_id)),
    },
  }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) => json(props);
