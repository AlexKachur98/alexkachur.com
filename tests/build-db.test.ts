import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildDatabase,
  buildInfo,
  ddl,
  decodeBase64Module,
  dumpSql,
  loadSqlJs,
  main,
  parseContent,
  readContentFiles,
  renderMarkdown,
  schemaJson,
  tableRows,
} from '../scripts/build-db.ts';
import type { ContentFiles } from '../scripts/build-db.ts';
import { chips, examples } from '../src/data/examples.ts';

const require = createRequire(import.meta.url);
const files = readContentFiles('src/content');
// Rendering is async and the edits below only touch frontmatter or YAML, so one render serves every parse.
const rendered = await renderMarkdown(files);
const parse = (edited: ContentFiles) => parseContent(edited, undefined, rendered);
const content = parse(files);
const sql = dumpSql(content);
const SQL = await loadSqlJs();
const bytes = buildDatabase(SQL, sql);

type Cell = string | number | null;

function query(statement: string): Record<string, Cell>[] {
  const db = new SQL.Database(bytes);
  try {
    const result = db.exec(statement)[0];
    if (!result) return [];
    return result.values.map((row) => Object.fromEntries(result.columns.map((name, i) => [name, row[i] as Cell])));
  } finally {
    db.close();
  }
}

function edited(name: string, from: string, to: string) {
  const text = files[name]!;
  if (!text.includes(from)) throw new Error(`fixture: ${from} not found in ${name}`);
  return { ...files, [name]: text.replace(from, to) };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('build-db', () => {
  it('builds byte-identical databases from the same content', () => {
    const again = buildDatabase(SQL, dumpSql(parse(readContentFiles('src/content'))));
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(true);
  });

  it('writes every row of every table', () => {
    const rows = tableRows(content);
    for (const [table, expected] of Object.entries(rows)) {
      expect(query(`SELECT COUNT(*) AS n FROM ${table}`)[0]!.n, table).toBe(expected.length);
    }
    expect(rows.projects).toHaveLength(4);
    expect(rows.technologies).toHaveLength(46);
    expect(rows.courses).toHaveLength(6);
    expect(rows.timeline).toHaveLength(8);
    expect(rows.pets).toHaveLength(2);
    expect(rows.facts).toHaveLength(14);
    expect(rows.uses).toHaveLength(14);
    expect(rows.experience).toHaveLength(4);
    expect(rows.interests).toHaveLength(47);
  });

  it('derives the DDL from the shared schemas', () => {
    const text = ddl();
    expect(text).toContain('id INTEGER PRIMARY KEY, -- Position in the site order, 1 first');
    expect(text).toContain('slug TEXT NOT NULL UNIQUE');
    expect(text).toContain("kind TEXT NOT NULL CHECK (kind IN ('client', 'team', 'course', 'personal'))");
    expect(text).toContain('year_end INTEGER, --');
    expect(text).toContain('paid INTEGER NOT NULL CHECK (paid IN (0, 1))');
    expect(text).toContain('PRIMARY KEY (project_id, technology_id)');
    expect(text).toContain('code TEXT PRIMARY KEY NOT NULL');
    expect(text).toContain("category TEXT NOT NULL CHECK (category IN ('language', 'framework', 'library', 'runtime', 'database', 'ai', 'service', 'testing', 'tooling', 'platform'))");
    expect(text).toContain('end TEXT, -- The same form as start, NULL if current');
    expect(text.match(/CREATE TABLE/g)).toHaveLength(13);
  });

  it('writes a schema.json whose hash is stable and covers the DDL, the table list and the facts', () => {
    const schema = schemaJson(content);
    const again = schemaJson(parse(readContentFiles('src/content')));
    expect(again).toEqual(schema);
    expect(schema.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(schema.hash).toBe(
      sha256(JSON.stringify({ ddl: schema.ddl, tables: schema.tables, factKeys: schema.factKeys, facts: schema.facts })),
    );
    expect(schema.factKeys).toEqual([
      'available_from',
      'email',
      'github',
      'gpa',
      'headline',
      'languages_spoken',
      'linkedin',
      'location',
      'name',
      'program',
      'role',
      'school',
      'status',
      'uses_updated',
    ]);
    expect(schema.facts.map((fact) => fact.key)).toEqual(schema.factKeys);
    // A description says what the key means, so it never repeats the value it describes.
    for (const fact of content.facts) {
      expect(fact.data.description.length, fact.id).toBeGreaterThan(0);
      expect(fact.data.description.includes(fact.data.value), fact.id).toBe(false);
    }
    expect(schema.tables.map((table) => table.name)).toEqual([
      'facts',
      'projects',
      'technologies',
      'project_technologies',
      'courses',
      'timeline',
      'pets',
      'experience',
      'interests',
      'storage',
      'uses',
      'sections',
      'page_images',
    ]);
    expect(schema.tables.every((table) => table.columns.every((col) => col.description.length > 0))).toBe(true);
    expect(schema.photoAlt).toEqual({
      '/images/pets/moura.webp': 'Close-up of Moura on the cat tree, pink nose forward',
      '/images/pets/simba.webp': 'Simba peeking out from between grey couch cushions',
    });
  });

  it('answers the example queries with the expected rows', () => {
    const [paying, llm, before, stored, shared, courses, pets, facts] = examples.map((example) => query(example.sql));
    expect(paying).toEqual([
      { name: 'Uraz Hoops', client_name: 'Uraz Hoops', year_start: 2026, live_url: 'https://urazhoops.com' },
    ]);
    expect(llm!.map((row) => row.name)).toEqual(['SplitRoof AI assistant', 'This site']);
    expect(llm!.every((row) => typeof row.llm_job === 'string' && row.llm_job.length > 0)).toBe(true);
    expect(before!.map((row) => row.title)).toEqual(['Manager', 'QA Tester']);
    expect(stored!.map((row) => Object.keys(row))[0]).toEqual(['item', 'kept_for', 'purpose']);
    expect(stored!.map((row) => row.kept_for)).toEqual(['30 days', '1 day', '2 minutes 1 second', '40 days', '90 days', '2 days', 'until you clear it']);
    expect(shared).toContainEqual({ name: 'React', projects: 2 });
    expect(courses).toHaveLength(6);
    expect(courses!.map((row) => row.code)).toContain('COMP 307');
    expect(pets!.map((row) => [row.name, row.born])).toEqual([
      ['Moura', 2014],
      ['Simba', 2024],
    ]);
    expect(facts!.map((row) => row.key).sort()).toEqual(['available_from', 'location', 'status']);
  });

  it('features exactly one project, the one first by order', () => {
    expect(query('SELECT slug FROM projects WHERE featured = 1')).toEqual(query('SELECT slug FROM projects ORDER BY id LIMIT 1'));
    expect(query('SELECT COUNT(*) AS n FROM projects WHERE featured = 1')).toEqual([{ n: 1 }]);
    expect(query('SELECT COUNT(*) AS n FROM projects WHERE featured <> 0 AND featured <> 1')).toEqual([{ n: 0 }]);
  });

  it('runs the four chips, which carry examples 1 to 4 unchanged', () => {
    expect(chips).toEqual(examples.slice(0, 4));
    const [paying, llm] = chips.map((chip) => query(chip.sql));
    expect(paying!.map((row) => row.name)).toEqual(['Uraz Hoops']);
    expect(llm!.map((row) => row.name)).toEqual(['SplitRoof AI assistant', 'This site']);
  });

  it('orders experience by start date and keeps each resume bullet on a line of its own', () => {
    const rows = query('SELECT id, title, start, end, highlights FROM experience ORDER BY id');
    expect(rows.map((row) => [row.id, row.title, row.start, row.end])).toEqual([
      [1, 'Manager', '2019-08', '2022-01'],
      [2, 'QA Tester', '2022-01', '2025-01'],
      [3, 'Peer Mentor', '2025-01', null],
      [4, 'Freelance Web Developer', '2026', null],
    ]);
    const bullets = Object.fromEntries(content.experience.map((entry) => [entry.data.title, entry.data.highlights]));
    for (const row of rows) expect(String(row.highlights).split('\n'), String(row.title)).toEqual(bullets[String(row.title)]);
  });

  it('fails hard on an experience date that is not YYYY-MM or YYYY', () => {
    expect(() => parse(edited('experience.yaml', 'start: "2019-08"', 'start: "Aug 2019"'))).toThrow(
      /experience.yaml row manager: start: Invalid string/,
    );
    expect(() => parse(edited('experience.yaml', 'end: "2022-01"', 'end: "2022-13"'))).toThrow(
      /experience.yaml row manager: end: Invalid string/,
    );
    expect(() => parse(edited('experience.yaml', 'start: "2019-08"', 'start: 2019'))).toThrow(
      /experience.yaml row manager: start: Invalid input: expected string/,
    );
  });

  it('marks exactly the seven core skills, each used by a project, and gives every technology a skill area', () => {
    expect(query('SELECT name FROM technologies WHERE core = 1 ORDER BY name').map((row) => row.name)).toEqual([
      'Anthropic API',
      'Jest',
      'Next.js',
      'Node.js',
      'React',
      'SQL',
      'TypeScript',
    ]);
    expect(
      query(
        'SELECT COUNT(*) AS n FROM technologies t WHERE core = 1 AND NOT EXISTS (SELECT 1 FROM project_technologies pt WHERE pt.technology_id = t.id)',
      ),
    ).toEqual([{ n: 0 }]);
    expect(query('SELECT COUNT(*) AS n FROM technologies WHERE skill_area IS NULL')).toEqual([{ n: 0 }]);
  });

  it('fails hard on a core skill that no project uses', () => {
    const gemini = 'name: Gemini API\n  category: ai\n  core: ';
    expect(() => parse(edited('technologies.yaml', `${gemini}0`, `${gemini}1`))).toThrow(
      /technologies.yaml: Gemini API is core but no project uses it/,
    );
  });

  it('keeps the interests in the order they are listed, with every note written out', () => {
    const rows = query('SELECT id, category, name, note FROM interests ORDER BY id');
    expect(rows[0]).toMatchObject({ id: 1, category: 'video game', name: 'Counter-Strike' });
    expect(rows.at(-1)).toMatchObject({ id: 47, category: 'wants to visit', name: 'Egypt' });
    expect(new Set(rows.map((row) => row.category)).size).toBe(16);
    const note = (name: string, category: string) => rows.find((row) => row.name === name && row.category === category)!.note;
    expect(note('Fallout: New Vegas', 'video game')).toBe(note('The Elder Scrolls V: Skyrim', 'video game'));
    expect(note('Clank!', 'board game')).toBe('Casual games with friends and family.');
    expect(note('Judo', 'sport')).toBe(note('Brazilian jiu-jitsu', 'sport'));
    expect(note('Japan', 'wants to visit')).toBe('Top of the list, and the same places I love reading about.');
    expect(note('Japan', 'history topic')).toBeNull();
  });

  it('keeps every pets photo under public', () => {
    for (const pet of content.pets) expect(existsSync(join('public', pet.data.photo_url)), pet.id).toBe(true);
  });

  it('fails hard on a YAML row without an id', () => {
    expect(() => parse(edited('technologies.yaml', '- id: react\n  name: React', '- name: React'))).toThrow(
      /technologies.yaml: row 11 has no id/,
    );
  });

  it('fails hard on a repeated id', () => {
    expect(() => parse(edited('technologies.yaml', '- id: astro\n', '- id: react\n'))).toThrow(
      /technologies.yaml: id react appears twice/,
    );
  });

  it('fails hard on a project naming an unknown technology', () => {
    expect(() => parse(edited('projects/uraz-hoops.md', 'framer-motion', 'vue'))).toThrow(
      /project uraz-hoops names unknown technology vue/,
    );
  });

  it('fails hard on a schema violation: bad enum value, wrong type, unknown key', () => {
    expect(() => parse(edited('projects/uraz-hoops.md', 'kind: client', 'kind: hobby'))).toThrow(
      /projects\/uraz-hoops.md: kind: Invalid option/,
    );
    expect(() => parse(edited('pets.yaml', 'born: 2024', 'born: "2024"'))).toThrow(
      /pets.yaml row simba: born: Invalid input: expected number/,
    );
    expect(() => parse(edited('projects/this-site.md', 'role: everything', 'rol: everything'))).toThrow(
      /projects\/this-site.md: .*Unrecognized key/,
    );
  });

  it('fails hard on a file that is empty, not a list, broken, missing or without frontmatter', () => {
    expect(() => parse({ ...files, 'facts.yaml': '' })).toThrow(/facts.yaml: expected a non-empty list/);
    expect(() => parse({ ...files, 'facts.yaml': 'id: name\nvalue: Alex\n' })).toThrow(
      /facts.yaml: expected a non-empty list/,
    );
    expect(() => parse({ ...files, 'facts.yaml': '- name\n' })).toThrow(/facts.yaml: row 1 is not a mapping/);
    expect(() => parse({ ...files, 'pets.yaml': 'name: [unclosed' })).toThrow(/pets.yaml:/);
    const { 'courses.yaml': _courses, ...missing } = files;
    expect(() => parse(missing)).toThrow(/courses.yaml is missing/);
    expect(() => parse({ ...files, 'projects/this-site.md': '## The problem\n' })).toThrow(
      /projects\/this-site.md: no frontmatter/,
    );
  });

  it('fails hard on a project file whose name is not already a slug', () => {
    const { 'projects/uraz-hoops.md': text, ...rest } = files;
    expect(() => parse({ ...rest, 'projects/Uraz Hoops.md': text! })).toThrow(
      /projects\/Uraz Hoops.md: file name is not a slug/,
    );
  });

  it('takes the commit from VERCEL_GIT_COMMIT_SHA, then GITHUB_SHA, then git', () => {
    const vercel = 'a'.repeat(40);
    const github = 'b'.repeat(40);
    expect(buildInfo({ VERCEL_GIT_COMMIT_SHA: vercel, GITHUB_SHA: github }).commit).toBe(vercel);
    expect(buildInfo({ GITHUB_SHA: github }).commit).toBe(github);
    expect(buildInfo({}).commit).toMatch(/^[0-9a-f]{7,40}$/);
  });

  it('fails hard on a screenshot or pet photo that does not exist', () => {
    expect(() => parse(edited('projects/uraz-hoops.md', 'uraz-hoops-4.jpg', 'uraz-hoops-9.jpg'))).toThrow(
      /screenshot .*uraz-hoops-9.jpg does not exist/,
    );
    expect(() => parse(edited('pets.yaml', '/images/pets/simba.webp', '/images/pets/nope.webp'))).toThrow(
      /pets.yaml row simba: \/images\/pets\/nope.webp is not under public/,
    );
  });

  it('keeps every row of uses.yaml, word for word and in its order, and the day /uses was last updated', () => {
    expect(query('SELECT position, section, item, details FROM uses')).toEqual(
      content.uses.map(({ data: { id, ...row } }, index) => ({ position: index + 1, ...row })),
    );
    expect(query('SELECT position FROM uses')).toHaveLength(14);
    expect(query("SELECT value FROM facts WHERE key = 'uses_updated'")[0]!.value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('holds the text of the other pages, then every case study in site order, one row per section shown', () => {
    const rows = query('SELECT page, position, heading, body FROM sections');
    expect(rows.slice(0, 3).map(({ page, position, heading }) => [page, position, heading])).toEqual([
      ['/#about', 1, 'About'],
      ['/#now', 1, 'Now'],
      ['/404', 1, 'Nothing at this address.'],
    ]);
    const projects = query('SELECT slug FROM projects ORDER BY id').map((row) => `/work/${row.slug}`);
    expect([...new Set(rows.slice(3).map((row) => row.page))]).toEqual(projects);
    for (const row of rows) expect(row.body, `${row.page} ${row.heading}`).not.toBe('');
  });

  it('keeps the photos of the other pages with the alt text and captions their files give', () => {
    expect(query('SELECT page, position, alt, caption FROM page_images')).toEqual(
      content.pages.flatMap((entry) =>
        (entry.data.images ?? []).map((image, index) => ({ page: entry.page, position: index + 1, alt: image.alt, caption: image.caption ?? null })),
      ),
    );
    expect(query('SELECT page FROM page_images').map((row) => row.page)).toEqual(['/#about', '/404']);
  });

  // The Now text is Alex's prose, but it repeats a fact, so the two must agree.
  it('names in the Now text the month the facts table says Alex is available from', () => {
    const available = query("SELECT value FROM facts WHERE key = 'available_from'")[0]!.value as string;
    const month = new Date(`${available}-01T00:00:00Z`).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    expect(query("SELECT body FROM sections WHERE page = '/#now'")[0]!.body).toContain(`from ${month}.`);
  });

  it('fails hard on a page file that is missing, has no frontmatter, names a missing photo or was not rendered', () => {
    const { 'pages/now.md': _now, ...missing } = files;
    expect(() => parse(missing)).toThrow(/pages\/now.md is missing/);
    expect(() => parse({ ...files, 'pages/about.md': 'No frontmatter.\n' })).toThrow(/pages\/about.md: no frontmatter/);
    expect(() => parse(edited('pages/404.md', 'simba-05.webp', 'simba-99.webp'))).toThrow(/pages\/404.md: image .*simba-99.webp does not exist/);
    expect(() => parseContent(files)).toThrow(/not rendered/);
  });

  describe('main', () => {
    // A root of its own: other test files run in parallel workers and import from the
    // repository's src/generated, so the outputs there must never be deleted or rewritten here.
    const root = mkdtempSync(join(tmpdir(), 'build-db-'));
    const at = (path: string) => join(root, path);

    beforeAll(() => {
      // The content, the screenshots it references and the pet photos it checks for.
      for (const dir of ['src/content', 'src/assets', 'public/images']) cpSync(dir, at(dir), { recursive: true });
      // A stale version and a stray file, both of which main must clear.
      mkdirSync(at('public/vendor/sql.js-0.0.0'), { recursive: true });
      writeFileSync(at('public/vendor/stray.txt'), '');
      return main(root);
    });

    afterAll(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('writes the database, the dump and a module byte-identical to the file', () => {
      const sqlite = readFileSync(at('public/data/portfolio.sqlite'));
      expect(sqlite.equals(Buffer.from(bytes))).toBe(true);
      expect(readFileSync(at('public/data/portfolio.sql'), 'utf8')).toBe(sql);
      expect(Buffer.from(decodeBase64Module(readFileSync(at('src/generated/portfolio-db.ts'), 'utf8'))).equals(sqlite)).toBe(true);
    });

    it('writes the wasm module and vendors sql.js under a folder named after the installed version', () => {
      const installed = JSON.parse(readFileSync('node_modules/sql.js/package.json', 'utf8')).version;
      const wasm = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
      expect(Buffer.from(decodeBase64Module(readFileSync(at('src/generated/sql-wasm.ts'), 'utf8'))).equals(wasm)).toBe(true);
      expect(readdirSync(at('public/vendor'))).toEqual([`sql.js-${installed}`]);
      const vendor = at(join('public', 'vendor', `sql.js-${installed}`));
      expect(readdirSync(vendor).sort()).toEqual(['sql-wasm.js', 'sql-wasm.wasm']);
      expect(readFileSync(join(vendor, 'sql-wasm.wasm')).equals(wasm)).toBe(true);
      expect(readFileSync(join(vendor, 'sql-wasm.js')).equals(readFileSync(require.resolve('sql.js/dist/sql-wasm.js')))).toBe(true);
    });

    it('writes schema.json with the same hash and build-info.json with a commit and a timestamp', () => {
      const schema = JSON.parse(readFileSync(at('src/generated/schema.json'), 'utf8'));
      expect(schema.hash).toBe(schemaJson(content).hash);
      const info = JSON.parse(readFileSync(at('src/generated/build-info.json'), 'utf8'));
      expect(info.commit).toMatch(/^[0-9a-f]{7,40}$|^local$/);
      expect(new Date(info.builtAt).toISOString()).toBe(info.builtAt);
    });

    it('runs as node scripts/build-db.ts, under type stripping, and recreates every output with the same bytes', () => {
      for (const dir of ['public/data', 'public/vendor', 'src/generated']) rmSync(at(dir), { recursive: true, force: true });
      execFileSync(process.execPath, [resolve('scripts/build-db.ts')], { cwd: root, stdio: 'pipe' });
      expect(readFileSync(at('public/data/portfolio.sqlite')).equals(Buffer.from(bytes))).toBe(true);
      expect(readFileSync(at('public/data/portfolio.sql'), 'utf8')).toBe(sql);
      expect(Buffer.from(decodeBase64Module(readFileSync(at('src/generated/portfolio-db.ts'), 'utf8'))).equals(Buffer.from(bytes))).toBe(true);
      expect(JSON.parse(readFileSync(at('src/generated/schema.json'), 'utf8')).hash).toBe(schemaJson(content).hash);
      expect(existsSync(at('src/generated/sql-wasm.ts'))).toBe(true);
      expect(existsSync(at('src/generated/build-info.json'))).toBe(true);
      expect(readdirSync(at('public/vendor'))).toHaveLength(1);
    });
  });
});
