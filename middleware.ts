import { next, rewrite } from '@vercel/functions';

export const config = { matcher: '/', runtime: 'nodejs' };

export default function middleware(request: Request) {
  const agent = (request.headers.get('user-agent') ?? '').toLowerCase();
  // PowerShell's web commands, including the curl alias Windows PowerShell 5.1 gives them, send a
  // browser-like agent that ends in WindowsPowerShell/5.1 or PowerShell/7.
  if (/^(curl|wget|httpie)\//.test(agent) || agent.includes('powershell/')) {
    return rewrite(new URL('/resume.txt', request.url));
  }
  return next();
}
