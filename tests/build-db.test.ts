import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
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
  schemaJson,
  tableRows,
} from '../scripts/build-db.ts';
import { chips, examples } from '../src/data/examples.ts';

const require = createRequire(import.meta.url);
const files = readContentFiles('src/content');
const content = parseContent(files);
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
    const again = buildDatabase(SQL, dumpSql(parseContent(readContentFiles('src/content'))));
    expect(Buffer.from(again).equals(Buffer.from(bytes))).toBe(true);
  });

  it('writes every row of every table', () => {
    const rows = tableRows(content);
    for (const [table, expected] of Object.entries(rows)) {
      expect(query(`SELECT COUNT(*) AS n FROM ${table}`)[0]!.n, table).toBe(expected.length);
    }
    expect(rows.projects).toHaveLength(4);
    expect(rows.technologies).toHaveLength(26);
    expect(rows.courses).toHaveLength(6);
    expect(rows.timeline).toHaveLength(8);
    expect(rows.pets).toHaveLength(2);
    expect(rows.facts).toHaveLength(8);
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
    expect(text.match(/CREATE TABLE/g)).toHaveLength(7);
  });

  it('writes a schema.json whose hash is stable and covers the DDL, the table list and the fact keys', () => {
    const schema = schemaJson(content);
    const again = schemaJson(parseContent(readContentFiles('src/content')));
    expect(again).toEqual(schema);
    expect(schema.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(schema.hash).toBe(sha256(JSON.stringify({ ddl: schema.ddl, tables: schema.tables, factKeys: schema.factKeys })));
    expect(schema.factKeys).toEqual(['available_from', 'email', 'github', 'headline', 'linkedin', 'location', 'name', 'status']);
    expect(schema.tables.map((table) => table.name)).toEqual([
      'facts',
      'projects',
      'technologies',
      'project_technologies',
      'courses',
      'timeline',
      'pets',
    ]);
    expect(schema.tables.every((table) => table.columns.every((col) => col.description.length > 0))).toBe(true);
    expect(schema.photoAlt).toEqual({
      '/images/pets/moura.webp': 'Close-up of Moura on the cat tree, pink nose forward',
      '/images/pets/simba.webp': 'Simba peeking out from between grey couch cushions',
    });
  });

  it('answers the six example queries with the expected rows', () => {
    const [paying, llm, shared, courses, pets, facts] = examples.map((example) => query(example.sql));
    expect(paying).toEqual([
      { name: 'Uraz Hoops', client_name: 'Uraz Hoops', year_start: 2026, live_url: 'https://urazhoops.com' },
    ]);
    expect(llm!.map((row) => row.name)).toEqual(['SplitRoof AI assistant', 'This site']);
    expect(llm!.every((row) => typeof row.llm_job === 'string' && row.llm_job.length > 0)).toBe(true);
    expect(shared).toContainEqual({ name: 'React', projects: 2 });
    expect(courses).toHaveLength(6);
    expect(courses!.map((row) => row.code)).toContain('COMP 307');
    expect(pets!.map((row) => [row.name, row.born])).toEqual([
      ['Moura', 2014],
      ['Simba', 2024],
    ]);
    expect(facts!.map((row) => row.key).sort()).toEqual(['available_from', 'location', 'status']);
  });

  it('runs both chips, which carry examples 1 and 2 unchanged', () => {
    expect(chips).toEqual(examples.slice(0, 2));
    const [paying, llm] = chips.map((chip) => query(chip.sql));
    expect(paying!.map((row) => row.name)).toEqual(['Uraz Hoops']);
    expect(llm!.map((row) => row.name)).toEqual(['SplitRoof AI assistant', 'This site']);
  });

  it('keeps every pets photo under public', () => {
    for (const pet of content.pets) expect(existsSync(join('public', pet.data.photo_url)), pet.id).toBe(true);
  });

  it('fails hard on a YAML row without an id', () => {
    expect(() => parseContent(edited('technologies.yaml', '- id: react\n  name: React', '- name: React'))).toThrow(
      /technologies.yaml: row 10 has no id/,
    );
  });

  it('fails hard on a repeated id', () => {
    expect(() => parseContent(edited('technologies.yaml', '- id: astro\n', '- id: react\n'))).toThrow(
      /technologies.yaml: id react appears twice/,
    );
  });

  it('fails hard on a project naming an unknown technology', () => {
    expect(() => parseContent(edited('projects/uraz-hoops.md', 'framer-motion', 'vue'))).toThrow(
      /project uraz-hoops names unknown technology vue/,
    );
  });

  it('fails hard on a schema violation: bad enum value, wrong type, unknown key', () => {
    expect(() => parseContent(edited('projects/uraz-hoops.md', 'kind: client', 'kind: hobby'))).toThrow(
      /projects\/uraz-hoops.md: kind: Invalid option/,
    );
    expect(() => parseContent(edited('pets.yaml', 'born: 2024', 'born: "2024"'))).toThrow(
      /pets.yaml row simba: born: Invalid input: expected number/,
    );
    expect(() => parseContent(edited('projects/this-site.md', 'role: everything', 'rol: everything'))).toThrow(
      /projects\/this-site.md: .*Unrecognized key/,
    );
  });

  it('fails hard on a file that is empty, not a list, broken, missing or without frontmatter', () => {
    expect(() => parseContent({ ...files, 'facts.yaml': '' })).toThrow(/facts.yaml: expected a non-empty list/);
    expect(() => parseContent({ ...files, 'facts.yaml': 'id: name\nvalue: Alex\n' })).toThrow(
      /facts.yaml: expected a non-empty list/,
    );
    expect(() => parseContent({ ...files, 'facts.yaml': '- name\n' })).toThrow(/facts.yaml: row 1 is not a mapping/);
    expect(() => parseContent({ ...files, 'pets.yaml': 'name: [unclosed' })).toThrow(/pets.yaml:/);
    const { 'courses.yaml': _courses, ...missing } = files;
    expect(() => parseContent(missing)).toThrow(/courses.yaml is missing/);
    expect(() => parseContent({ ...files, 'projects/this-site.md': '## The problem\n' })).toThrow(
      /projects\/this-site.md: no frontmatter/,
    );
  });

  it('fails hard on a project file whose name is not already a slug', () => {
    const { 'projects/uraz-hoops.md': text, ...rest } = files;
    expect(() => parseContent({ ...rest, 'projects/Uraz Hoops.md': text! })).toThrow(
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
    expect(() => parseContent(edited('projects/uraz-hoops.md', 'uraz-hoops-4.jpg', 'uraz-hoops-9.jpg'))).toThrow(
      /screenshot .*uraz-hoops-9.jpg does not exist/,
    );
    expect(() => parseContent(edited('pets.yaml', '/images/pets/simba.webp', '/images/pets/nope.webp'))).toThrow(
      /pets.yaml row simba: \/images\/pets\/nope.webp is not under public/,
    );
  });

  describe('main', () => {
    beforeAll(() => {
      // A stale version and a stray file, both of which main must clear.
      mkdirSync('public/vendor/sql.js-0.0.0', { recursive: true });
      writeFileSync('public/vendor/stray.txt', '');
      return main();
    });

    it('writes the database, the dump and a module byte-identical to the file', () => {
      const sqlite = readFileSync('public/data/portfolio.sqlite');
      expect(sqlite.equals(Buffer.from(bytes))).toBe(true);
      expect(readFileSync('public/data/portfolio.sql', 'utf8')).toBe(sql);
      expect(Buffer.from(decodeBase64Module(readFileSync('src/generated/portfolio-db.ts', 'utf8'))).equals(sqlite)).toBe(true);
    });

    it('writes the wasm module and vendors sql.js under a folder named after the installed version', () => {
      const installed = JSON.parse(readFileSync('node_modules/sql.js/package.json', 'utf8')).version;
      const wasm = readFileSync(require.resolve('sql.js/dist/sql-wasm.wasm'));
      expect(Buffer.from(decodeBase64Module(readFileSync('src/generated/sql-wasm.ts', 'utf8'))).equals(wasm)).toBe(true);
      expect(readdirSync('public/vendor')).toEqual([`sql.js-${installed}`]);
      const vendor = join('public', 'vendor', `sql.js-${installed}`);
      expect(readdirSync(vendor).sort()).toEqual(['sql-wasm.js', 'sql-wasm.wasm']);
      expect(readFileSync(join(vendor, 'sql-wasm.wasm')).equals(wasm)).toBe(true);
      expect(readFileSync(join(vendor, 'sql-wasm.js')).equals(readFileSync(require.resolve('sql.js/dist/sql-wasm.js')))).toBe(true);
    });

    it('writes schema.json with the same hash and build-info.json with a commit and a timestamp', () => {
      const schema = JSON.parse(readFileSync('src/generated/schema.json', 'utf8'));
      expect(schema.hash).toBe(schemaJson(content).hash);
      const info = JSON.parse(readFileSync('src/generated/build-info.json', 'utf8'));
      expect(info.commit).toMatch(/^[0-9a-f]{7,40}$|^local$/);
      expect(new Date(info.builtAt).toISOString()).toBe(info.builtAt);
    });

    it('runs as node scripts/build-db.ts, under type stripping, and recreates every output with the same bytes', () => {
      for (const dir of ['public/data', 'public/vendor', 'src/generated']) rmSync(dir, { recursive: true, force: true });
      execFileSync(process.execPath, ['scripts/build-db.ts'], { stdio: 'pipe' });
      expect(readFileSync('public/data/portfolio.sqlite').equals(Buffer.from(bytes))).toBe(true);
      expect(readFileSync('public/data/portfolio.sql', 'utf8')).toBe(sql);
      expect(Buffer.from(decodeBase64Module(readFileSync('src/generated/portfolio-db.ts', 'utf8'))).equals(Buffer.from(bytes))).toBe(true);
      expect(JSON.parse(readFileSync('src/generated/schema.json', 'utf8')).hash).toBe(schemaJson(content).hash);
      expect(existsSync('src/generated/sql-wasm.ts')).toBe(true);
      expect(existsSync('src/generated/build-info.json')).toBe(true);
      expect(readdirSync('public/vendor')).toHaveLength(1);
    });
  });
});
