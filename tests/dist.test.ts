import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { answerExample, chips } from '../src/data/examples.ts';
import { validateSql } from '../src/lib/ask/validate-sql.ts';

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

  // The list the Ask box's privacy note links to.
  it('lists what is stored for a question under its own heading on /api', () => {
    const api = pages.find(({ url }) => url === '/api')!.html;
    const list = api.match(/<h3\b[^>]*\sid="what-is-stored"[^>]*>What is stored<\/h3>(?:\s*<p\b[^>]*>[^<]*<\/p>)?\s*<ul\b[^>]*>([\s\S]*?)<\/ul>/)?.[1] ?? '';
    expect(list.match(/<li\b/g)).toHaveLength(6);
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
  // not run.
  it('loads every script from a file', () => {
    for (const { url, html } of pages) {
      const inline = [...html.matchAll(/<script\b([^>]*)>/g)].filter(([, attributes]) => !/\ssrc=/.test(attributes!)).map(([tag]) => tag);
      expect(inline, url).toEqual([]);
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
  const openGraph = ['og:title', 'og:description', 'og:url', 'og:type', 'og:site_name', 'og:locale'];

  // Link previews print og:site_name or the domain beside og:title, so og:title leaves the name
  // out; the title in the tab and in search results keeps it.
  it('gives every page but the 404 one title, description and canonical, and the Open Graph set', () => {
    expect(indexable).toHaveLength(pages.length - 1);
    for (const { url, html } of indexable) {
      const { titles, meta, links } = head(html);
      const canonical = links.filter(({ rel }) => rel === 'canonical').map(({ href }) => href);
      expect(titles, url).toHaveLength(1);
      expect(meta('description'), url).toHaveLength(1);
      expect(canonical, url).toHaveLength(1);
      for (const key of openGraph) expect(meta(key), `${url} ${key}`).toHaveLength(1);
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
    // The limit must end the list where a tie ends: the first row it leaves out ranks lower than
    // the last one shown.
    const limit = example.sql.match(/\sLIMIT (\d+);$/);
    expect(limit).not.toBeNull();
    const ranking = db.exec(example.sql.replace(/\sLIMIT \d+;$/, ';'))[0]!.values;
    const shownCount = Number(limit![1]);
    if (ranking.length > shownCount) expect(ranking[shownCount]![1]).not.toBe(ranking[shownCount - 1]![1]);
    const statement = db.prepare(example.sql);
    const rows: unknown[][] = [];
    while (statement.step()) rows.push(statement.get());
    const columns = statement.getColumnNames();
    statement.free();
    db.close();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(50);

    const head = block.match(/<p\b[^>]*\sid="ask-example-answer-head"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
    const parts = [...head.matchAll(/<span\b[^>]*>([^<]*)<\/span>/g)].map(([, part]) => part!.trim());
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
});
