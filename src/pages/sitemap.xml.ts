import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { projectRows } from '../lib/rows.ts';

// Hand-written: the home page, the case studies in site order, and the three
// utility pages. A project another page covers is listed through that page. The 404 page, the
// endpoints and the text files stay out.
export const GET: APIRoute = async ({ site }) => {
  const studies = projectRows(await getCollection('projects'))
    .map((project) => project.page)
    .filter((page) => page.startsWith('/work/'));
  const paths = ['/', ...studies, '/uses', '/api', '/how-this-site-works'];
  const urls = paths.map((path) => `  <url><loc>${new URL(path, site)}</loc></url>`).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
};
