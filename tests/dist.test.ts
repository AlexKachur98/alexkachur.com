import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { answerExample, chips, examples, storageQuery } from '../src/data/examples.ts';
import { validateSql } from '../src/lib/ask/validate-sql.ts';
import { INSIGHTS } from '../src/lib/loaded-scripts.ts';
import { blockText, inlineText } from '../src/lib/page-text.ts';
import { pageFiles, recordedPromptTokens, siteNumbers } from '../scripts/build-db.ts';

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

// Each built page with the path it is served at: uses/index.html is /uses, 404.html is /404. The
// Search Console verification file at the root is a token, not a page.
const pages = files
  .filter((path) => path.endsWith('.html') && !/google[0-9a-f]+[.]html$/.test(path))
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

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
const decode = (value: string): string => value.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => entities[name]!);

// The title, meta and link tags in a page's head, their values decoded.
function head(html: string) {
  const source = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
  const attribute = (tag: string, name: string): string | undefined => {
    const value = tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
    return value === undefined ? undefined : decode(value);
  };
  const metas = [...source.matchAll(/<meta\b[^>]*>/g)].map(([tag]) => ({ key: attribute(tag, 'name') ?? attribute(tag, 'property') ?? '', content: attribute(tag, 'content') }));
  return {
    titles: [...source.matchAll(/<title>([^<]*)<\/title>/g)].map(([, title]) => decode(title!)),
    metaKeys: metas.map(({ key }) => key),
    meta: (key: string) => metas.filter((meta) => meta.key === key).map(({ content }) => content),
    links: [...source.matchAll(/<link\b[^>]*>/g)].map(([tag]) => ({ rel: attribute(tag, 'rel'), href: attribute(tag, 'href') ?? '', sizes: attribute(tag, 'sizes'), type: attribute(tag, 'type') })),
  };
}

// A PNG's width, height, bit depth and colour type, from its header chunk.
function pngHeader(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0)).toBe(0x89504e47);
  expect(String.fromCharCode(...bytes.subarray(12, 16))).toBe('IHDR');
  return { width: view.getUint32(16), height: view.getUint32(20), depth: bytes[24], colour: bytes[25] };
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

  // A project has a case study under /work/ unless another page covers it; then its old address
  // redirects there for good, with no page of its own in the build.
  it('links back to the work list from every case study pager, between Previous and Next', async () => {
    const wasm = readFileSync('node_modules/sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
    const db = new SQL.Database(readFileSync(join(root, 'data', 'portfolio.sqlite')));
    const projects = (db.exec('SELECT slug, page FROM projects ORDER BY id')[0]!.values as string[][]).map(([slug, page]) => ({ slug: slug!, page: page! }));
    db.close();
    const studies = pages.filter(({ url }) => url.startsWith('/work/'));
    expect(studies.map(({ url }) => url).sort()).toEqual(projects.map(({ page }) => page).filter((page) => page.startsWith('/work/')).sort());
    expect(studies.length).toBeLessThan(projects.length);
    const { routes } = JSON.parse(readFileSync('.vercel/output/config.json', 'utf8')) as { routes: { src: string; status?: number; headers?: Record<string, string> }[] };
    for (const { slug, page } of projects.filter((project) => !project.page.startsWith('/work/'))) {
      expect(pages.some(({ url }) => url === `/work/${slug}`), slug).toBe(false);
      expect(routes.find((route) => route.src === `^/work/${slug}$`), slug).toMatchObject({ status: 301, headers: { Location: page } });
      expect(pages.some(({ url }) => url === page), slug).toBe(true);
    }
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

  // A link to a spot on a page lands on nothing when the id is missing; the page opens at its top.
  it('points every same-site fragment link at an id on the page it names', () => {
    const ids = new Map(pages.map(({ url, html }) => [url, new Set([...html.matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id))]));
    const links: string[] = [];
    const broken: string[] = [];
    for (const { url, html } of pages) {
      for (const [, href] of html.matchAll(/<a\b[^>]*\shref="([^"]*#[^"]*)"/g)) {
        const target = new URL(href!, `https://site.test${url}`);
        if (target.host !== 'site.test') continue;
        links.push(href!);
        if (!ids.get(target.pathname)?.has(decodeURIComponent(target.hash.slice(1)))) broken.push(`${url}: ${href}`);
      }
    }
    expect(links).toEqual(expect.arrayContaining(['#main', '/#work']));
    expect(broken).toEqual([]);
  });

  // The table the storage chip's line links to: the query, then exactly the rows it returns from
  // the built database.
  it('shows what is stored on /api as the storage table under the query that reads it', async () => {
    const api = pages.find(({ url }) => url === '/api')!.html;
    const block = api.match(/<h3\b[^>]*\sid="what-is-stored"[^>]*>What is stored<\/h3>\s*<pre\b[^>]*><code\b[^>]*>([^<]*)<\/code><\/pre>\s*<div\b([^>]*)>\s*<table\b[^>]*>([\s\S]*?)<\/table>/);
    expect(block).not.toBeNull();
    const [, query, region, table] = block!;
    const text = (html: string) => decode(html.replace(/<[^>]*>/g, '')).trim();
    expect(decode(query!)).toBe(storageQuery);
    expect(region).toMatch(/role="region"/);
    expect(region).toMatch(/aria-labelledby="what-is-stored"/);
    expect(region).toMatch(/tabindex="0"/);
    const wasm = readFileSync('node_modules/sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
    const db = new SQL.Database(readFileSync(join(root, 'data', 'portfolio.sqlite')));
    const result = db.exec(storageQuery)[0]!;
    db.close();
    expect([...table!.matchAll(/<th\b[^>]*scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map(([, cell]) => text(cell!))).toEqual(result.columns);
    const rows = [...table!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)]
      .map(([, row]) => [...row!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => text(cell!)))
      .filter((row) => row.length > 0);
    expect(rows).toEqual(result.values.map((row) => row.map(String)));
  });

  // Sending a question is offered by a block that starts hidden; the page shows it only after a typed
  // question the site could not answer, and nothing is sent until its button is clicked.
  it('carries the send offer hidden in every Ask box, with its consent line and thanks', () => {
    const text = (html: string) => decode(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    for (const url of ['/', '/404']) {
      const html = pages.find((page) => page.url === url)!.html;
      const block = html.match(/<div\b([^>]*)data-ask-send-block([^>]*)>([\s\S]*?)<\/div>/);
      expect(block, url).not.toBeNull();
      expect(`${block![1]}${block![2]}`, url).toMatch(/\bhidden\b/);
      const button = block![3]!.match(/<button\b([^>]*)>([\s\S]*?)<\/button>/);
      expect(text(button![2]!), url).toBe('Send this question to Alex');
      expect(button![1], url).toMatch(/aria-describedby="ask-send-note"/);
      const note = block![3]!.match(/<p\b[^>]*id="ask-send-note"[^>]*>([\s\S]*?)<\/p>/);
      expect(text(note![1]!), url).toBe("Only if you choose: the question is kept for 90 days so I can add what's missing. Nothing else is sent.");
      const sent = html.match(/<p\b([^>]*)data-ask-sent([^>]*)>([\s\S]*?)<\/p>/);
      expect(`${sent![1]}${sent![2]}`, url).toMatch(/\bhidden\b/);
      expect(`${sent![1]}${sent![2]}`, url).toMatch(/tabindex="-1"/);
      expect(text(sent![3]!), url).toBe('Sent. Thanks.');
    }
    const api = pages.find(({ url }) => url === '/api')!.html;
    expect(api).toMatch(/<section\b[^>]*id="api-questions"/);
    expect(text(api)).toContain('Each answer also carries a token: to send that question to Alex, pass it to /api/questions within 10 minutes.');
    expect(text(api)).toContain('It is kept for 90 days, and no endpoint ever returns it.');
  });

  // The Ask box on the home page and the 404: four chips, the privacy note with no link, and the
  // storage example's line, hidden until that example runs, linking to the table above.
  it('shows the four chips, the privacy note and the storage line in every Ask box', () => {
    const text = (html: string) => decode(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    for (const url of ['/', '/404']) {
      const html = pages.find((page) => page.url === url)!.html;
      const form = html.match(/<form\b[^>]*data-ask-form[^>]*>([\s\S]*?)<\/form>/)?.[1] ?? '';
      const labels = [...form.matchAll(/<button\b[^>]*class="button chip"[^>]*>([\s\S]*?)<\/button>/g)].map(([, label]) => text(label!));
      expect(labels, url).toEqual(chips.map((chip) => chip.label));
      const privacy = form.match(/<p\b[^>]*class="ask-privacy"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
      expect(privacy, url).not.toMatch(/<a\b/);
      expect(text(privacy), url).toBe('Your question goes to an AI service to become SQL. This site never logs it.');
      const index = examples.findIndex((example) => example.more);
      const more = examples[index]!.more!;
      const line = html.match(new RegExp(`<p\\b[^>]*data-ask-more="${index}"[^>]*>([\\s\\S]*?)</p>`));
      expect(line, url).not.toBeNull();
      expect(line![0], url).toMatch(/\shidden\b/);
      expect(line![1], url).toMatch(new RegExp(`<a\\b[^>]*href="${more.href}"[^>]*>${more.link}</a>`));
      expect(text(line![1]!), url).toBe(`${more.link}${more.rest}`);
      expect(html.match(new RegExp(`data-more="${index}"`, 'g'))!.length, url).toBeGreaterThanOrEqual(1);
    }
  });

  // The page scrolls the live answer's head into sight, so that head carries the hook and the
  // build-time example's does not.
  it("marks the live answer's head, and only it, in every Ask box", () => {
    for (const url of ['/', '/404']) {
      const html = pages.find((page) => page.url === url)!.html;
      const heads = [...html.matchAll(/<p\b([^>]*\sdata-ask-head\b[^>]*)>([\s\S]*?)<\/p>/g)];
      expect(heads, url).toHaveLength(1);
      expect(heads[0]![1], url).toMatch(/\sclass="console-head"/);
      expect(heads[0]![2], url).toMatch(/\sid="ask-question"/);
    }
  });

  // The words saying the results box scrolls start hidden and follow the status region rather than
  // sit in it, so they are never announced and never join the results' name. Both results boxes
  // keep the role, name and tab stop a box that scrolls needs.
  it('carries the scroll words hidden after the status, and keeps both results boxes focusable regions', () => {
    const text = (html: string) => decode(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    for (const url of ['/', '/404']) {
      const html = pages.find((page) => page.url === url)!.html;
      expect(html.match(/data-ask-scroll-cue/g), url).toHaveLength(1);
      const cue = html.match(/<span\b[^>]*\sid="ask-status"[^>]*><\/span>\s*<span\b([^>]*\sdata-ask-scroll-cue\b[^>]*)>([\s\S]*?)<\/span>\s*<span\b[^>]*\sclass="console-cursor"/);
      expect(cue, url).not.toBeNull();
      expect(cue![1], url).toMatch(/\shidden\b/);
      expect(text(cue![2]!), url).toBe('· scrollable');
      const live = html.match(/<div\b[^>]*\sdata-ask-results\b[^>]*>/)?.[0] ?? '';
      expect(live, url).toMatch(/\srole="region"/);
      expect(live, url).toMatch(/\saria-labelledby="ask-question ask-status"/);
    }
    const home = pages.find(({ url }) => url === '/')!.html;
    const example = home.match(/<div\b[^>]*\sclass="ask-example-answer"[^>]*>[\s\S]*?(<div\b[^>]*\sclass="console-results"[^>]*>)/)?.[1] ?? '';
    expect(example).toMatch(/\srole="region"/);
    expect(example).toMatch(/\saria-labelledby="ask-example-answer-head"/);
    expect(example).toMatch(/\stabindex="0"/);
  });

  // The resume is a document, not a page, so it alone opens a new tab and says so in words a screen
  // reader reads; every other link keeps the Back button working.
  it('opens the resume, and only the resume, in a new tab, with a warning for screen readers', () => {
    let resumeLinks = 0;
    for (const { url, html } of pages) {
      for (const [, attributes, inner] of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
        const href = attributes!.match(/\shref="([^"]*)"/)?.[1];
        const target = attributes!.match(/\starget="([^"]*)"/)?.[1];
        const link = href === undefined ? undefined : new URL(href, `https://alexkachur.com${url}`);
        const resume = link?.host === 'alexkachur.com' && ['/Alex-Kachur-Resume.pdf', '/resume'].includes(link.pathname);
        if (!resume) {
          expect(target, `${url}: ${href}`).toBeUndefined();
          continue;
        }
        resumeLinks++;
        expect(target, url).toBe('_blank');
        expect(attributes!.match(/\srel="([^"]*)"/)?.[1]?.split(/\s+/), url).toContain('noopener');
        expect(inner, url).toMatch(/<span\b[^>]*\sclass="visually-hidden"[^>]*>\s*\(PDF, opens in a new tab\)<\/span>/);
        expect(inner!.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim(), url).toBe('Resume (PDF, opens in a new tab)');
      }
      expect([...html.matchAll(/<(?!a\b)[a-z][a-z0-9-]*\b[^>]*\starget=/g)].map(([tag]) => tag), url).toEqual([]);
    }
    expect(resumeLinks).toBeGreaterThan(0);
    const scripts = files.filter((path) => path.endsWith('.js') && !vendored(path));
    expect(scripts.length).toBeGreaterThan(0);
    expect(scripts.filter((path) => readFileSync(path, 'utf8').includes('_blank'))).toEqual([]);
  });

  // The CSP's script-src allows files from the site only, so a script written into the page would
  // not run. The home page's structured data is the one exception: a JSON data block, which the
  // browser never runs.
  it('loads every script from a file', () => {
    for (const { url, html } of pages) {
      const inline = [...html.matchAll(/<script\b([^>]*)>/g)].filter(([, attributes]) => !/\ssrc=/.test(attributes!)).map(([tag]) => tag);
      expect(inline, url).toEqual(url === '/' ? ['<script type="application/ld+json">'] : []);
    }
  });

  // The CSP's style-src has no inline allowance either.
  it('sets no style attribute on any page', () => {
    for (const { url, html } of pages) expect(html.match(/<[^>]*\sstyle=/g), url).toBeNull();
  });

  // The one script every page loads before interaction besides /theme.js and the analytics.
  it('keeps the bootstrap under 2 KB gzipped', () => {
    const bootstrap = files.filter((path) => /Base\.astro_astro_type_script_index_0_lang\.[\w-]+\.js$/.test(path));
    expect(bootstrap).toHaveLength(1);
    expect(gzipSync(readFileSync(bootstrap[0]!)).length).toBeLessThan(2048);
  });

  it('ends every page with the Vercel Analytics element and its module', () => {
    for (const { url, html } of pages) {
      const module = html.match(/<vercel-analytics\b[^>]*><\/vercel-analytics><script type="module" src="([^"]+)"><\/script><\/body>/)?.[1];
      expect(module, url).toBeDefined();
      expect(readFileSync(join(root, module!), 'utf8'), url).toContain('/_vercel/insights/script.js');
    }
  });

  it('lists every page but the 404 in the sitemap', () => {
    const sitemap = readFileSync(join(root, 'sitemap.xml'), 'utf8');
    const listed = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => new URL(loc!).pathname).sort();
    expect(listed).toEqual(pages.map(({ url }) => url).filter((url) => url !== '/404').sort());
  });

  const indexable = pages.filter(({ url }) => url !== '/404');
  const openGraph = ['og:title', 'og:description', 'og:url', 'og:type', 'og:site_name', 'og:locale', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt'];

  // Link previews print og:site_name or the domain beside og:title, so og:title leaves the name
  // out; the title in the tab and in search results keeps it.
  it('gives every page but the 404 one title, description and canonical, and the Open Graph set', () => {
    expect(indexable).toHaveLength(pages.length - 1);
    for (const { url, html } of indexable) {
      const { titles, metaKeys, meta, links } = head(html);
      const canonical = links.filter(({ rel }) => rel === 'canonical').map(({ href }) => href);
      expect(titles, url).toHaveLength(1);
      expect(meta('description'), url).toHaveLength(1);
      expect(canonical, url).toHaveLength(1);
      for (const key of openGraph) expect(meta(key), `${url} ${key}`).toHaveLength(1);
      expect(metaKeys.filter((key) => key.startsWith('twitter:')), url).toEqual(['twitter:card']);
      expect(meta('twitter:card'), url).toEqual(['summary_large_image']);
      expect(meta('og:url'), url).toEqual(canonical);
      expect(meta('og:description'), url).toEqual(meta('description'));
      expect([meta('og:type')[0], meta('og:site_name')[0], meta('og:locale')[0]], url).toEqual(['website', 'Alex Kachur', 'en_CA']);
      const ogTitle = meta('og:title')[0]!;
      expect(ogTitle, url).not.toContain('Alex Kachur');
      expect(titles[0], url).toBe(url === '/' ? 'Alex Kachur · Full-stack & AI developer' : `${ogTitle} · Alex Kachur`);
    }
    expect(head(pages.find(({ url }) => url === '/')!.html).meta('og:title')).toEqual(['Full-stack & AI developer']);
  });

  it('keeps the 404 out of search results and link previews', () => {
    const { metaKeys, meta, links } = head(pages.find(({ url }) => url === '/404')!.html);
    expect(meta('robots')).toEqual(['noindex']);
    expect(links.filter(({ rel }) => rel === 'canonical')).toEqual([]);
    expect(metaKeys.filter((key) => key.startsWith('og:') || key.startsWith('twitter:'))).toEqual([]);
  });

  // A case study previews its first screenshot, with that screenshot's alt text; every other page,
  // and a case study with no screenshot yet, previews the site's card.
  it('points every preview at a 1200 by 630 image in the build, on the canonical host', async () => {
    let screenshots = 0;
    for (const { url, html } of indexable) {
      const { meta, links } = head(html);
      const image = new URL(meta('og:image')[0]!);
      expect(image.origin, url).toBe('https://alexkachur.com');
      expect(image.origin, url).toBe(new URL(links.find(({ rel }) => rel === 'canonical')!.href).origin);
      const file = readFileSync(join(root, image.pathname));
      const { width, height, format } = await sharp(file).metadata();
      expect([width, height, meta('og:image:width')[0], meta('og:image:height')[0]], url).toEqual([1200, 630, '1200', '630']);
      expect(file.length, url).toBeLessThan(300 * 1024);

      const shot = url.startsWith('/work/') ? html.slice(html.indexOf('<main')).match(/<img\b[^>]*\ssrc="\/_astro\/([^"]+)"[^>]*\salt="([^"]*)"/) : null;
      if (shot) {
        screenshots++;
        const original = shot[1]!.slice(0, shot[1]!.lastIndexOf('_'));
        expect(image.pathname, url).toMatch(new RegExp(`^/_astro/${original.replace(/[.-]/g, '\\$&')}_`));
        expect(meta('og:image:alt'), url).toEqual([decode(shot[2]!)]);
      } else {
        expect(image.pathname, url).toMatch(/^\/_astro\/link-preview\.[\w-]+\.png$/);
        expect(format, url).toBe('png');
        expect(meta('og:image:alt'), url).toEqual(['Alex Kachur, Full-stack & AI developer']);
      }
    }
    expect(screenshots).toBeGreaterThan(0);
  });

  it('links the favicon set from every page, each file the size its link says', async () => {
    for (const { url, html } of pages) {
      const icons = head(html).links.filter(({ rel }) => rel === 'icon' || rel === 'apple-touch-icon');
      expect(icons.map(({ rel, href, sizes, type }) => `${rel} ${href.replace(/\.[\w-]+\.(svg|png)$/, '.$1')} ${sizes ?? ''} ${type ?? ''}`), url).toEqual([
        'icon /favicon.ico 32x32 64x64 ',
        'icon /_astro/icon.svg  image/svg+xml',
        'apple-touch-icon /_astro/apple-touch-icon.png  ',
      ]);
    }
    const [, svg, touch] = head(pages[0]!.html).links.filter(({ rel }) => rel === 'icon' || rel === 'apple-touch-icon');

    // An ICO header, a directory entry per frame, and the PNG each entry points at.
    const ico = readFileSync(join(root, 'favicon.ico'));
    const view = new DataView(ico.buffer, ico.byteOffset, ico.byteLength);
    expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([0, 1, 2]);
    [32, 64].forEach((size, index) => {
      const entry = 6 + 16 * index;
      expect([ico[entry], ico[entry + 1]]).toEqual([size, size]);
      const offset = view.getUint32(entry + 12, true);
      const embedded = pngHeader(ico.subarray(offset, offset + view.getUint32(entry + 8, true)));
      expect([embedded.width, embedded.height, embedded.depth]).toEqual([size, size, 8]);
      expect([2, 6]).toContain(embedded.colour);
    });

    const icon = readFileSync(join(root, svg!.href), 'utf8');
    expect(icon).toMatch(/^<svg\b[^>]*\sviewBox="0 0 32 32"/);
    expect(icon).not.toMatch(/<text\b/);
    // iOS paints a transparent pixel black, so the touch icon has no alpha channel.
    const { width, height, colour } = pngHeader(readFileSync(join(root, touch!.href)));
    expect([width, height, colour]).toEqual([180, 180, 2]);
  });

  it('describes the home page, and only the home page, with structured data', () => {
    for (const { url, html } of pages) {
      const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(([, json]) => json!);
      expect(blocks, url).toHaveLength(url === '/' ? 1 : 0);
      if (url !== '/') continue;
      const { '@context': context, '@graph': graph } = JSON.parse(blocks[0]!) as { '@context': string; '@graph': Record<string, unknown>[] };
      expect(context).toBe('https://schema.org');
      expect(graph.find((node) => node['@type'] === 'WebSite')).toMatchObject({ name: head(html).meta('og:site_name')[0], url: 'https://alexkachur.com/' });
      const person = graph.find((node) => node['@type'] === 'ProfilePage')?.mainEntity as Record<string, unknown>;
      expect(person).toMatchObject({ '@type': 'Person', name: 'Alex Kachur', url: 'https://alexkachur.com/', jobTitle: 'Full-stack & AI developer' });
      expect(Object.keys(person)).not.toEqual(expect.arrayContaining(['image']));
      const profiles = ['GitHub', 'LinkedIn'].map((label) => html.match(new RegExp(`<a href="([^"]+)"[^>]*>${label}</a>`))?.[1]);
      expect(person.sameAs).toEqual(profiles);
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

  // The example beside the Ask box is answered at build time, so its SQL must be one the site's
  // own validator accepts, and the page must show exactly the rows the built database gives.
  it('shows the example answer with SQL the validator accepts and the rows the built database gives', async () => {
    const home = pages.find(({ url }) => url === '/')!.html;
    const block = home.match(/<div\b[^>]*\sclass="ask-example-answer"[^>]*>([\s\S]*?)<\/table>/)?.[1] ?? '';
    expect(block).not.toBe('');
    const text = (html: string) => decode(html.replace(/<[^>]*>/g, '')).trim();
    const example = answerExample;
    expect(chips.map(({ label }) => label)).not.toContain(example.label);

    const wasm = readFileSync('node_modules/sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
    const db = new SQL.Database(readFileSync(join(root, 'data', 'portfolio.sqlite')));
    expect(validateSql(example.sql, db)).toMatchObject({ ok: true });
    // One row per skill area that has a core skill, each listing exactly that area's core skills.
    const core = db.exec('SELECT skill_area, name FROM technologies WHERE core = 1')[0]!.values as string[][];
    const areas = new Map<string, string[]>();
    for (const [area, name] of core) areas.set(area!, [...(areas.get(area!) ?? []), name!]);
    const grouped = [...areas]
      .map(([area, names]) => [area, names.sort((a, b) => a.localeCompare(b, 'en')).join(', ')])
      .sort(([a], [b]) => a!.toLowerCase().localeCompare(b!.toLowerCase(), 'en'));
    expect(db.exec(example.sql)[0]!.values).toEqual(grouped);
    expect(grouped).toHaveLength(5);
    const statement = db.prepare(example.sql);
    const rows: unknown[][] = [];
    while (statement.step()) rows.push(statement.get());
    const columns = statement.getColumnNames();
    statement.free();
    db.close();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(50);

    const head = block.match(/<p\b[^>]*\sid="ask-example-answer-head"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
    const parts = [...head.matchAll(/<span\b[^>]*>([^<]*)<\/span>/g)].map(([, part]) => decode(part!).trim());
    expect(parts).toEqual(['Example', '·', example.label, rows.length === 1 ? '1 row' : `${rows.length} rows`]);
    const sql = block.match(/<pre\b[^>]*\sclass="ask-sql"[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? '';
    expect(text(sql)).toBe(example.sql);
    const edit = block.match(/<button\b[^>]*\sdata-ask-edit\b[^>]*>/)?.[0] ?? '';
    expect(text(edit.match(/\sdata-sql="([^"]*)"/)?.[1] ?? '')).toBe(example.sql);
    expect(sql).toMatch(/<span class="sql-keyword"[^>]*>SELECT<\/span>/);
    expect([...block.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map(([, cell]) => text(cell!))).toEqual(columns);
    const shown = [...block.matchAll(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/g)]
      .flatMap(([, body]) => [...body!.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)])
      .map(([, row]) => [...row!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map(([, cell]) => text(cell!)));
    expect(shown).toEqual(rows.map((row) => row.map((value) => (value === null ? 'NULL' : String(value)))));
  });

  it('makes only /_astro/, /vendor/ and /data/ immutable in vercel.json', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as VercelConfig;
    const immutable = config.headers
      .filter((rule) => rule.headers.some((header) => header.key === 'Cache-Control' && header.value.includes('immutable')))
      .map((rule) => rule.source)
      .sort();
    expect(immutable).toEqual(['/_astro/(.*)', '/data/(.*)', '/vendor/(.*)']);
  });

  // The sections table holds each page's text as the page shows it: every section of every case
  // study but Screenshots, which is the page's own; the About and Now text on the home page; the
  // 404's heading and lead; and the lead and sections of /how-this-site-works. What only a page
  // can add, the flow diagram inside What I built and the blocks marked data-page-only, is left
  // out of the comparison.
  it('shows on every page exactly the text its rows in the sections table hold', async () => {
    const wasm = readFileSync('node_modules/sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
    const db = new SQL.Database(readFileSync(join(root, 'data', 'portfolio.sqlite')));
    const rows = new Map<string, { heading: string; body: string }[]>();
    for (const [page, heading, body] of db.exec('SELECT page, heading, body FROM sections ORDER BY page, position')[0]!.values as string[][]) {
      rows.set(page!, [...(rows.get(page!) ?? []), { heading: heading!, body: body! }]);
    }
    const html = (url: string) => pages.find((page) => page.url === url)!.html;
    const pageOnly = /<(figure|pre|p|ul|div)\b[^>]*\sdata-page-only\b[^>]*>[\s\S]*?<\/\1>/g;
    const sections = (source: string) =>
      [...source.matchAll(/<section class="section"[^>]*\sid="([^"]*)"[^>]*>\s*<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*?)<\/section>/g)].map(
        ([, id, heading, body]) => ({ id: id!, heading: inlineText(heading!), body: body!.replace(pageOnly, '') }),
      );
    const leadOf = (source: string) => ({
      heading: inlineText(source.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)![1]!),
      body: blockText(source.match(/<div class="lead"[^>]*>([\s\S]*?)<\/div>/)![1]!),
    });
    const shown = new Map<string, { heading: string; body: string }[]>();
    for (const page of pages.filter(({ url }) => url.startsWith('/work/'))) {
      shown.set(
        page.url,
        sections(page.html)
          .filter((section) => section.id !== 'screenshots')
          .map((section) => ({ heading: section.heading, body: blockText(section.body) })),
      );
    }
    const home = sections(html('/'));
    const about = html('/').match(/<div class="about-text"[^>]*>([\s\S]*?)<\/div>/)![1]!;
    shown.set('/#about', [{ heading: home.find((section) => section.id === 'about')!.heading, body: blockText(about) }]);
    const now = home.find((section) => section.id === 'now')!;
    shown.set('/#now', [{ heading: now.heading, body: blockText(now.body) }]);
    shown.set('/404', [leadOf(html('/404'))]);
    const works = html('/how-this-site-works');
    shown.set('/how-this-site-works', [leadOf(works), ...sections(works).map((section) => ({ heading: section.heading, body: blockText(section.body) }))]);
    expect(works.match(pageOnly)?.length ?? 0).toBeGreaterThanOrEqual(4);

    expect([...shown.keys()].sort()).toEqual([...rows.keys()].sort());
    for (const [page, expected] of rows) expect(shown.get(page), page).toEqual(expected);
    // Every markdown page is in the table.
    const markdown = readdirSync('src/content/pages').filter((name) => name.endsWith('.md')).map((name) => `pages/${name}`);
    expect(markdown.sort()).toEqual(Object.keys(pageFiles).sort());
  });

  // A home page row shows its first screenshot, or the drawing its file names, each under the
  // same overlay link, with no caption; the drawing is named by the row's sentence and only the
  // first screenshot loads eagerly.
  it('shows on each Selected work row its screenshot or its drawing, uncaptioned, under one link', async () => {
    const wasm = readFileSync('node_modules/sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
    const db = new SQL.Database(readFileSync(join(root, 'data', 'portfolio.sqlite')));
    const projects = (db.exec('SELECT p.page, p.row_image, p.row_image_alt, (SELECT alt FROM project_images i WHERE i.project_id = p.id AND i.position = 1) AS shot FROM projects p ORDER BY p.id')[0]!.values as (string | null)[][]).map(([page, image, alt, shot]) => ({ page: page!, image: image!, alt, shot }));
    db.close();
    const home = pages.find(({ url }) => url === '/')!.html;
    const rows = [...home.matchAll(/<li class="work-row[^"]*"[^>]*>([\s\S]*?)<\/li>\s*(?=<li class="work-row|<\/ol>)/g)].map(([, row]) => row!);
    expect(rows).toHaveLength(projects.length);
    let eager = 0;
    let drawn = 0;
    for (const [index, row] of rows.entries()) {
      const project = projects[index]!;
      expect(row, project.page).not.toMatch(/<figcaption/);
      const links = [...row.matchAll(/<a\b([^>]*)>/g)].map(([, attributes]) => attributes!);
      expect(links.filter((attributes) => attributes.includes(`href="${project.page}"`)), project.page).toHaveLength(2);
      expect(links.some((attributes) => /tabindex="-1"/.test(attributes) && /aria-hidden="true"/.test(attributes)), project.page).toBe(true);
      if (project.image === 'screenshot') {
        const img = row.match(/<img\b[^>]*>/)?.[0] ?? '';
        expect(decode(img.match(/\salt="([^"]*)"/)?.[1] ?? ''), project.page).toBe(project.shot);
        expect(row, project.page).not.toMatch(/<svg/);
        if (/loading="eager"/.test(img)) eager++;
      } else {
        drawn++;
        expect(row, project.page).not.toMatch(/<img/);
        const titles = [...row.matchAll(/<title[^>]*>([\s\S]*?)<\/title>/g)].map(([, title]) => decode(title!));
        expect(titles.length, project.page).toBeGreaterThan(0);
        for (const title of titles) expect(title, project.page).toBe(project.alt);
        expect(row.match(/<svg\b[^>]*\srole="img"/g)?.length, project.page).toBe(titles.length);
        expect(row.match(/<desc\b/g)?.length, project.page).toBe(titles.length);
      }
    }
    expect(eager).toBe(1);
    expect(drawn).toBe(2);
  });

  // Each case study's screenshots carry the alt text and caption of its project_images rows,
  // numbers filled in, so a visitor's query and the page cannot disagree.
  it('captions every case-study screenshot as its project_images row does', async () => {
    const wasm = readFileSync('node_modules/sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
    const db = new SQL.Database(readFileSync(join(root, 'data', 'portfolio.sqlite')));
    const rows = db.exec('SELECT p.slug, i.alt, i.caption FROM project_images i JOIN projects p ON p.id = i.project_id ORDER BY p.id, i.position')[0]!.values as (string | null)[][];
    db.close();
    const text = (html: string) => decode(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
    let captioned = 0;
    for (const page of pages.filter(({ url }) => url.startsWith('/work/'))) {
      const slug = page.url.slice('/work/'.length);
      const expected = rows.filter(([s]) => s === slug).map(([, alt, caption]) => ({ alt, caption }));
      const shots = page.html.match(/<section class="section"[^>]*\sid="screenshots"[^>]*>([\s\S]*?)<\/section>/)?.[1] ?? '';
      const figures = [...shots.matchAll(/<figure\b[^>]*>([\s\S]*?)<\/figure>/g)].map(([, figure]) => ({
        alt: decode(figure!.match(/<img\b[^>]*\salt="([^"]*)"/)![1]!),
        caption: figure!.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/) ? text(figure!.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/)![1]!) : null,
      }));
      expect(figures, page.url).toEqual(expected);
      captioned += figures.filter(({ caption }) => caption !== null).length;
    }
    expect(captioned).toBeGreaterThan(0);
  });

  // The sizes /how-this-site-works gives for the scripts a page loads before interaction are the
  // built files' own, gzipped as the bootstrap budget above measures them, and the beacon's is
  // the one measured from the live site.
  it('lists the four scripts every page loads first with the sizes of the files in the build', () => {
    const works = pages.find(({ url }) => url === '/how-this-site-works')!.html;
    const list = works.match(/<section class="section"[^>]*\sid="performance"[^>]*>[\s\S]*?<ul\b[^>]*\sdata-page-only\b[^>]*>([\s\S]*?)<\/ul>/)?.[1] ?? '';
    const lines = [...list.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/g)].map(([, line]) => decode(line!.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim());
    const size = (line: string) => Number(line.match(/, ([\d,]+) bytes/)![1]!.replaceAll(',', ''));
    const assets = readdirSync(join(root, '_astro')).filter((name) => name.endsWith('.js'));
    const bootstrap = assets.find((name) => /^Base\.astro_astro_type_script_index_0_lang\./.test(name))!;
    const analytics = assets.find((name) => readFileSync(join(root, '_astro', name), 'utf8').includes(INSIGHTS.name))!;
    const gzipped = (path: string) => gzipSync(readFileSync(path)).length;
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^\/theme\.js, /);
    expect(size(lines[0]!)).toBe(gzipped(join(root, 'theme.js')));
    expect(size(lines[1]!)).toBe(gzipped(join(root, '_astro', bootstrap)));
    expect(size(lines[2]!)).toBe(gzipped(join(root, '_astro', analytics)));
    expect(lines[3]).toContain(INSIGHTS.name);
    expect(size(lines[3]!)).toBe(INSIGHTS.bytes);
    expect(lines[3]).toContain(INSIGHTS.measured);
  });

  it('lists on /uses every row of the uses table in order, under its section, with the day it was last updated', async () => {
    const wasm = readFileSync('node_modules/sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
    const db = new SQL.Database(readFileSync(join(root, 'data', 'portfolio.sqlite')));
    const rows = db.exec('SELECT section, item, details FROM uses ORDER BY position')[0]!.values as string[][];
    const expected = rows.map(([section, item, details]) => [section, details!.startsWith(item!) ? details : `${item}: ${details}`]);
    const uses = pages.find((page) => page.url === '/uses')!.html;
    const shown = [...uses.matchAll(/<section class="section"[^>]*>\s*<h2[^>]*>([^<]*)<\/h2>([\s\S]*?)<\/section>/g)].flatMap(([, section, body]) =>
      [...body!.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].map(([, line]) => [section, decode(line!)]),
    );
    expect(shown).toEqual(expected);
    const updated = db.exec("SELECT value FROM facts WHERE key = 'uses_updated'")[0]!.values[0]![0];
    expect(uses).toContain(`Last updated: ${updated}`);
  });

  // The numbers a resume bullet, a caption or a page names are filled in by build-db; none may
  // reach a page, a file or an endpoint as its placeholder.
  it('holds no unfilled number placeholder anywhere', async () => {
    const wasm = readFileSync('node_modules/sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
    const db = new SQL.Database(readFileSync(join(root, 'data', 'portfolio.sqlite')));
    const sections = (db.exec('SELECT page, body FROM sections')[0]!.values as string[][]).map(([page, body]) => ({ page: page!, body: body! }));
    const placeholder = new RegExp(`\\{(?:${Object.keys(siteNumbers(sections, recordedPromptTokens())).join('|')})\\}`);
    for (const path of files.filter((file) => !vendored(file))) expect(readFileSync(path, 'utf8'), path).not.toMatch(placeholder);
    expect(readFileSync(join(root, 'resume.txt'), 'utf8')).not.toMatch(placeholder);
  });

  it('serves every table but project_technologies at /api/{table}.json, row for row as the database holds it', async () => {
    const wasm = readFileSync('node_modules/sql.js/dist/sql-wasm.wasm');
    const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
    const db = new SQL.Database(readFileSync(join(root, 'data', 'portfolio.sqlite')));
    const names = (db.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")[0]!.values as string[][]).map(([name]) => name!);
    const served = readdirSync(join(root, 'api')).filter((name) => name.endsWith('.json') && !['schema.json', 'openapi.json', 'resume.json'].includes(name));
    expect(served.sort()).toEqual(names.filter((name) => name !== 'project_technologies').map((name) => `${name}.json`).sort());
    for (const name of names.filter((table) => table !== 'project_technologies')) {
      const result = db.exec(`SELECT * FROM ${name} ORDER BY rowid`)[0]!;
      const rows = result.values.map((row) => Object.fromEntries(result.columns.map((column, index) => [column, row[index]])));
      expect(JSON.parse(readFileSync(join(root, 'api', `${name}.json`), 'utf8')), name).toEqual(rows);
    }
  });
});
