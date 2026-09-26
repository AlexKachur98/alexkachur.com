import { getEntry } from 'astro:content';

// A page from src/content/pages; a missing file or an empty title stops the build.
export async function pageEntry(id: string) {
  const page = await getEntry('pages', id);
  if (!page?.data.title) throw new Error(`src/content/pages/${id}.md is missing, or has no title`);
  return page;
}
