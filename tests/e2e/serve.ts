// The built site for the browser tests, served as Vercel serves its static files: /path is path,
// path/index.html or path.html, and anything else is the 404 page with its status. The on-demand
// endpoints are not here; a test answers them itself.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

const root = resolve('dist/client');
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.sqlite': 'application/vnd.sqlite3',
  '.sql': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function file(path: string): string | null {
  return path.startsWith(root) && existsSync(path) && statSync(path).isFile() ? path : null;
}

createServer((request, response) => {
  const base = join(root, decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname));
  const found = file(base) ?? file(join(base, 'index.html')) ?? file(`${base}.html`);
  const path = found ?? join(root, '404.html');
  response.writeHead(found ? 200 : 404, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' });
  response.end(readFileSync(path));
}).listen(Number(process.env.PORT ?? 4322), '127.0.0.1');
