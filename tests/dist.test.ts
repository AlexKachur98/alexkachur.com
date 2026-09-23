import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
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

// Each built page with the path it is served at: uses/index.html is /uses, 404.html is /404.
const pages = files
  .filter((path) => path.endsWith('.html'))
  .map((path) => {
    const file = relative(root, path).replaceAll('\\', '/');
    return { url: `/${file.replace(/(^|\/)index\.html$/, '').replace(/\.html$/, '')}`, html: readFileSync(path, 'utf8') };
  });

// The opening tag of anything a keyboard can reach, in document order. A link needs an href, and
// tabindex="-1", disabled, hidden and type="hidden" take an element out of the order.
const focusableTag = /<(?:a\b[^>]*\shref=|(?:button|input|select|textarea|summary|iframe)\b|[a-z][a-z0-9-]*\b[^>]*\stabindex=")[^>]*>/g;
const unfocusable = /\stabindex="-|\s(?:disabled|hidden)(?=[\s=>/])|\stype="hidden"/;

function firstFocusable(html: string): string | undefined {
  return [...html.slice(html.indexOf('<body')).matchAll(focusableTag)].map(([tag]) => tag).find((tag) => !unfocusable.test(tag));
}

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

  // A section whose only content is a note to me is left out until it has copy; a heading with
  // nothing after it means one slipped through.
  it('renders no section heading with nothing after it', () => {
    const bare = files
      .filter((path) => path.endsWith('.html'))
      .flatMap((path) => [...readFileSync(path, 'utf8').matchAll(/<h2\b[^>]*>((?:(?!<\/?h2\b)[\s\S])*)<\/h2>\s*<\/section>/g)].map(([, title]) => `${path}: ${title}`));
    expect(bare).toEqual([]);
  });

  it('makes the skip link the first stop on every page, with one main for it to land on', () => {
    for (const { url, html } of pages) {
      const first = firstFocusable(html);
      expect(first, url).toMatch(/\sclass="skip-link"/);
      expect(first, url).toMatch(/\shref="#main"/);
      expect(html, url).toMatch(/<a\b[^>]*\sclass="skip-link"[^>]*>Skip to content<\/a>/);
      expect(html.match(/\sid="main"/g), url).toHaveLength(1);
      expect(html, url).toMatch(/<main\b[^>]*\sid="main"/);
    }
  });

  // The home page opens with the name in its hero instead.
  it('gives every page but the home page a site header with one link home', () => {
    const home = pages.find(({ url }) => url === '/');
    expect(home).toBeDefined();
    const sections = [...home!.html.matchAll(/<section\b[^>]*\sid="([^"]+)"/g)].map(([, id]) => id);
    expect(sections).toEqual(expect.arrayContaining(['work', 'about', 'contact']));
    for (const { url, html } of pages) {
      const navs = [...html.matchAll(/<nav\b[^>]*\saria-label="Site"[^>]*>([\s\S]*?)<\/nav>/g)];
      expect(navs, url).toHaveLength(url === '/' ? 0 : 1);
      if (url === '/') continue;
      expect(navs[0]![1]!.match(/<a\b[^>]*\shref="\/"[^>]*>/g), url).toHaveLength(1);
      const links = [...navs[0]![1]!.matchAll(/<a\b[^>]*\shref="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(([, href, text]) => `${text} ${href}`);
      expect(links, url).toEqual(['Alex Kachur /', 'Work /#work', 'About /#about', 'Contact /#contact']);
    }
  });

  it('starts the footer with Home and marks the link to the page it is on', () => {
    const own: Record<string, string> = { '/': 'Home', '/uses': 'Uses', '/api': 'API', '/how-this-site-works': 'How this site works' };
    expect(pages.map(({ url }) => url)).toEqual(expect.arrayContaining(Object.keys(own)));
    for (const { url, html } of pages) {
      const footer = html.match(/<nav\b[^>]*\saria-label="Footer"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
      const links = [...footer.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)].map(([, attributes, text]) => ({ text, current: /\saria-current="page"/.test(attributes!) }));
      expect(links[0]?.text, url).toBe('Home');
      expect(links.filter(({ current }) => current).map(({ text }) => text), url).toEqual(own[url] ? [own[url]] : []);
      expect(html.match(/\saria-current=/g)?.length ?? 0, url).toBe(own[url] ? 1 : 0);
    }
  });

  it('links back to the work list from every case study pager, between Previous and Next', () => {
    const studies = pages.filter(({ url }) => url.startsWith('/work/'));
    expect(studies).toHaveLength(readdirSync('src/content/projects').filter((file) => file.endsWith('.md')).length);
    for (const { url, html } of studies) {
      const pager = html.match(/<nav\b[^>]*\saria-label="Case studies"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
      expect(pager, url).toMatch(/<a\b[^>]*\shref="\/#work"[^>]*>All work<\/a>/);
      const order = [...pager.matchAll(/<a\b([^>]*)>/g)].map(([, attributes]) =>
        /\srel="prev"/.test(attributes!) ? 'prev' : /\srel="next"/.test(attributes!) ? 'next' : /\shref="\/#work"/.test(attributes!) ? 'all' : attributes,
      );
      expect(order.length, url).toBeGreaterThan(1);
      expect(order, url).toEqual(['prev', 'all', 'next'].filter((step) => order.includes(step)));
    }
  });

  it('names every navigation region, each one differently', () => {
    for (const { url, html } of pages) {
      const labels = [...html.matchAll(/<nav\b[^>]*>/g)].map(([tag]) => tag.match(/\saria-label="([^"]+)"/)?.[1]);
      expect(labels.length, url).toBeGreaterThan(0);
      expect(labels.every(Boolean), url).toBe(true);
      expect(new Set(labels).size, url).toBe(labels.length);
    }
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
