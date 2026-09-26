import { defineMiddleware } from 'astro:middleware';
import { stripHtmlComments } from './lib/strip-comments.ts';

// The page half of the comment stripping: runs at build time for every prerendered page, 404
// included, and leaves non-HTML responses alone.
export const onRequest = defineMiddleware(async (_context, next) => {
  const response = await next();
  if (!response.headers.get('content-type')?.startsWith('text/html')) return response;
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  return new Response(stripHtmlComments(await response.text()), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
});
