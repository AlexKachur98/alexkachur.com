import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The build output test: no HTML comment and no TODO marker anywhere, every link into the two
// immutable folders versioned, and nothing else made immutable by vercel.json. npm test builds
// first (pretest), so the tree is the current one. The static tree is dist/ until an on-demand
// endpoint exists and dist/client from then on.
const root = ['dist/client', 'dist'].find((dir) => existsSync(join(dir, 'index.html')));
if (!root) throw new Error('no build output: run npm run build first');

const textTypes = new Set(['.html', '.js', '.css', '.json', '.txt', '.xml', '.sql', '.svg', '.map']);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function vendored(path: string): boolean {
  return path.replaceAll('\\', '/').includes('/vendor/');
}

const files = walk(root).filter((path) => textTypes.has(extname(path)));

// A URL in an attribute, a string or a url(): the quote, equals sign or bracket before it keeps
// the plain path shown as link text out of the match.
const dataUrl = /(?<=["'=(])\/(?:data|vendor)\/[^"'\s)<>]*/g;
// A content hash in the query string, or a folder named after the package version.
const versioned = /\?v=[0-9a-f]{8}$|^\/vendor\/[^/]+-\d+\.\d+\.\d+\//;

interface VercelConfig {
  headers: { source: string; headers: { key: string; value: string }[] }[];
}

describe(`built output in ${root}`, () => {
  it('has pages to check', () => {
    expect(files.filter((path) => path.endsWith('.html')).length).toBeGreaterThan(5);
  });

  it('writes the OpenAPI document as a static file', () => {
    const document = JSON.parse(readFileSync(join(root, 'api', 'openapi.json'), 'utf8')) as { openapi: string; paths: Record<string, unknown> };
    expect(document.openapi).toBe('3.1.0');
    expect(Object.keys(document.paths)).toContain('/api/projects.json');
  });

  it('contains no HTML comment and no TODO marker in any text file', () => {
    const offenders = files
      .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
      .filter(({ path, text }) => text.includes('<!--') || (!vendored(path) && text.includes('TODO:')))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('links /data/ and /vendor/ only through versioned URLs', () => {
    const found: string[] = [];
    const unversioned: string[] = [];
    for (const path of files.filter((file) => !vendored(file))) {
      for (const [url] of readFileSync(path, 'utf8').matchAll(dataUrl)) {
        found.push(url);
        if (!versioned.test(url)) unversioned.push(`${path}: ${url}`);
      }
    }
    expect(found.length).toBeGreaterThan(0);
    expect(unversioned).toEqual([]);
  });

  it('makes only /_astro/, /vendor/ and /data/ immutable in vercel.json', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as VercelConfig;
    const immutable = config.headers
      .filter((rule) => rule.headers.some((header) => header.key === 'Cache-Control' && header.value.includes('immutable')))
      .map((rule) => rule.source)
      .sort();
    expect(immutable).toEqual(['/_astro/(.*)', '/data/(.*)', '/vendor/(.*)']);
  });
});
