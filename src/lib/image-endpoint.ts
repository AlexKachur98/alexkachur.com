import type { APIRoute } from 'astro';

// Astro resizes images on request at this route. Every image here is resized when the site is
// built, so the deployed route answers 404 rather than resize to whatever a request asks for.
export const GET: APIRoute = async (context) => {
  if (!import.meta.env.DEV) return new Response(null, { status: 404 });
  const { GET: resize } = await import('astro/assets/endpoint/dev');
  return resize(context);
};
