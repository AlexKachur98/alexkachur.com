import { next, rewrite } from '@vercel/functions';

export const config = { matcher: '/', runtime: 'nodejs' };

export default function middleware(request: Request) {
  const agent = (request.headers.get('user-agent') ?? '').toLowerCase();
  if (/^(curl|wget|httpie)\//.test(agent)) {
    return rewrite(new URL('/resume.txt', request.url));
  }
  return next();
}
