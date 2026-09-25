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
  recordedEval,
  recordedMeasurements,
  recordedPromptTokens,
  renderMarkdown,
  schemaJson,
  siteNumbers,
  tableRows,
} from '../scripts/build-db.ts';
import type { ContentFiles } from '../scripts/build-db.ts';
import { chips, examples } from '../src/data/examples.ts';
import measurements from '../src/data/measurements.json';
import { tables } from '../src/content/schemas.ts';
import { DEFAULT_CAP, MODEL } from '../src/lib/ask/config.ts';
import { CACHE_MINIMUM_TOKENS, PRICE, PRICE_CHECKED } from '../src/lib/ask/pricing.ts';
import { keptFor, RATE_LIMIT, STATS_CACHE, TTL } from '../src/lib/ask/storage.ts';
import { fillPlaceholders } from '../src/lib/numbers.ts';
import { OPENAPI_VERSION } from '../src/lib/openapi-version.ts';
import { questions } from '../scripts/eval/questions.ts';

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
    expect(rows.technologies).toHaveLength(45);
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
    expect(text.match(/CREATE TABLE/g)).toHaveLength(14);
  });

  it('writes a schema.json whose hash is stable and covers the DDL, the table list, the facts and the section pages and headings', () => {
    const schema = schemaJson(content);
    const again = schemaJson(parse(readContentFiles('src/content')));
    expect(again).toEqual(schema);
    expect(schema.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(schema.hash).toBe(
      sha256(
        JSON.stringify({ ddl: schema.ddl, tables: schema.tables, factKeys: schema.factKeys, facts: schema.facts, sectionPages: schema.sectionPages, sectionHeadings: schema.sectionHeadings }),
      ),
    );
    // Every page the sections table holds, once each, in the table's own order, which is sorted.
    expect(schema.sectionPages).toEqual([...new Set(query('SELECT page FROM sections').map((row) => row.page))]);
    // Every heading the sections table holds, once each, in the order the rows first give them.
    expect(schema.sectionHeadings).toEqual([...new Set(query('SELECT heading FROM sections').map((row) => row.heading))]);
    expect(schema.sectionHeadings).toContain('What went wrong or what I would change');
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
      'project_images',
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
    expect(llm!.map((row) => row.name)).toEqual(['SplitRoof AI assistant', 'Portfolio site']);
    expect(llm!.every((row) => typeof row.llm_job === 'string' && row.llm_job.length > 0)).toBe(true);
    expect(before!.map((row) => row.title)).toEqual(['Manager', 'QA Tester']);
    expect(stored!.map((row) => Object.keys(row))[0]).toEqual(['item', 'kept_for', 'purpose']);
    expect(stored!.map((row) => row.kept_for)).toEqual(['30 days', '1 day', '2 minutes 1 second', '40 days', '90 days', '2 days', 'until you clear it']);
    expect(shared).toContainEqual({ name: 'Vercel', projects: 2 });
    expect(shared).toContainEqual({ name: 'HTML', projects: 2 });
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
    expect(llm!.map((row) => row.name)).toEqual(['SplitRoof AI assistant', 'Portfolio site']);
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

  it('marks exactly the six core skills, each used by a project, and gives every technology a skill area', () => {
    expect(query('SELECT name FROM technologies WHERE core = 1 ORDER BY name').map((row) => row.name)).toEqual([
      'Anthropic API',
      'Jest',
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
    expect(() => parse(edited('projects/uraz-hoops.md', 'formsubmit', 'vue'))).toThrow(
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

  it('keeps each project card and team line, and every screenshot in page order under its project', () => {
    expect(query('SELECT slug, card, team FROM projects ORDER BY id')).toEqual(
      [...content.projects].sort((a, b) => a.data.order - b.data.order).map(({ id, data }) => ({ slug: id, card: data.card, team: data.team ?? null })),
    );
    // A caption's numbers are filled in from their sources, as a highlight's are.
    const numbers = siteNumbers(query('SELECT page, body FROM sections') as { page: string; body: string }[], recordedPromptTokens());
    expect(query('SELECT project_id, position, alt, caption FROM project_images')).toEqual(
      [...content.projects]
        .sort((a, b) => a.data.order - b.data.order)
        .flatMap(({ data }) =>
          data.screenshots.map((shot, index) => ({
            project_id: data.order,
            position: index + 1,
            alt: shot.alt,
            caption: shot.caption === undefined ? null : fillPlaceholders(shot.caption, numbers, 'caption'),
          })),
        ),
    );
    expect(query('SELECT caption FROM project_images WHERE project_id = 1 AND position = 1')[0]!.caption).toContain('12 tests on the three tools');
    expect(query('SELECT COUNT(*) AS n FROM project_images')[0]!.n).toBe(8);
  });

  it('fills each number in a highlight, a caption or a page from the thing it counts, and leaves no placeholder in any cell', () => {
    const recorded = recordedEval();
    const promptTokens = recordedPromptTokens();
    const fixture = JSON.parse(readFileSync('scripts/eval/fixtures.json', 'utf8')) as { model: string; promptVersion: number; questions: { replies: { usage: { input_tokens: number; output_tokens: number } }[] }[] };
    const outputs = fixture.questions.map((entry) => entry.replies[0]!.usage.output_tokens);
    expect(promptTokens).toBe(Math.max(...fixture.questions.map((entry) => entry.replies[0]!.usage.input_tokens)));
    expect(recorded).toEqual({ promptTokens, model: fixture.model, promptVersion: fixture.promptVersion, outputMin: Math.min(...outputs), outputMax: Math.max(...outputs) });
    expect(promptTokens).toBeLessThan(CACHE_MINIMUM_TOKENS);
    const inputCost = Math.round(((DEFAULT_CAP * promptTokens * PRICE.input) / 1e6) * 100) / 100;
    const outputCost = Math.round(((DEFAULT_CAP * MODEL.maxTokens * PRICE.output) / 1e6) * 100) / 100;
    const cost = inputCost + outputCost;
    expect(siteNumbers(query('SELECT page, body FROM sections') as { page: string; body: string }[], recorded)).toEqual({
      month_input_tokens: (DEFAULT_CAP * promptTokens).toLocaleString('en-US'),
      month_input_cost: `$${inputCost.toFixed(2)}`,
      month_output_tokens: (DEFAULT_CAP * MODEL.maxTokens).toLocaleString('en-US'),
      month_output_cost: `$${outputCost.toFixed(2)}`,
      fixture_model: fixture.model,
      fixture_prompt_version: String(fixture.promptVersion),
      output_tokens_min: String(Math.min(...outputs)),
      output_tokens_max: String(Math.max(...outputs)),
      eval_questions: String(questions.length),
      openapi_version: OPENAPI_VERSION.split('.').slice(0, 2).join('.'),
      splitroof_tool_tests: '12',
      splitroof_model_tests: '5',
      table_count: String(Object.keys(tables).length),
      question_min: '3',
      question_max: '200',
      rate_limit: String(RATE_LIMIT.requests),
      monthly_cap: '2,000',
      answer_cache: keptFor(TTL.answer),
      refusal_cache: keptFor(TTL.refusal),
      sent_question_kept: keptFor(TTL.sentQuestion),
      stats_cache_seconds: String(STATS_CACHE.freshSeconds),
      stats_stale_seconds: String(STATS_CACHE.staleSeconds),
      prompt_tokens: promptTokens.toLocaleString('en-US'),
      max_output_tokens: String(MODEL.maxTokens),
      price_input: `$${PRICE.input}`,
      price_output: `$${PRICE.output}`,
      price_checked: PRICE_CHECKED,
      cap_month_cost: `$${cost.toFixed(2)}`,
      cache_minimum_tokens: '4,096',
      lighthouse_date: measurements.lighthouse.date,
      lighthouse_tool: measurements.lighthouse.tool,
      ...Object.fromEntries(
        Object.entries(measurements.lighthouse.pages).flatMap(([name, page]) => [
          [`${name}_performance`, String(page.performance)],
          [`${name}_accessibility`, String(page.accessibility)],
          [`${name}_best_practices`, String(page.best_practices)],
          [`${name}_seo`, String(page.seo)],
        ]),
      ),
      home_cls: '0',
      works_cls: '0',
      think_smarter_html_kb: String(Math.round(measurements.html_bytes.think_smarter / 1000)),
      uraz_html_kb: String(Math.round(measurements.html_bytes.uraz / 1000)),
    });
    expect(() => siteNumbers([], CACHE_MINIMUM_TOKENS)).toThrow(/cache floor/);
    // The measurements record is checked as it is read: a score outside 0 to 100 or a bad date stops the build.
    const measured = recordedMeasurements();
    expect(measured.lighthouse.pages.home.url).toBe('https://alexkachur.com/');
    const sections = query('SELECT page, body FROM sections') as { page: string; body: string }[];
    const shifted = { ...measured, lighthouse: { ...measured.lighthouse, pages: { ...measured.lighthouse.pages, home: { ...measured.lighthouse.pages.home, cls: 0.05 } } } };
    expect(siteNumbers(sections, recorded, shifted).home_cls).toBe('0.050');
    const broken = join(tmpdir(), `measurements-${process.pid}.json`);
    writeFileSync(broken, JSON.stringify({ ...measured, lighthouse: { ...measured.lighthouse, pages: { ...measured.lighthouse.pages, home: { ...measured.lighthouse.pages.home, seo: 101 } } } }));
    expect(() => recordedMeasurements(broken)).toThrow(/home\.seo is not a score/);
    writeFileSync(broken, JSON.stringify({ ...measured, lighthouse: { ...measured.lighthouse, date: '25/09/2026' } }));
    expect(() => recordedMeasurements(broken)).toThrow(/not YYYY-MM-DD/);
    rmSync(broken);
    const portfolio = query("SELECT highlights FROM projects WHERE slug = 'this-site'")[0]!.highlights as string;
    expect(portfolio).toContain(`CI replays a ${questions.length}-question evaluation`);
    expect(query("SELECT highlights FROM projects WHERE kind = 'client'").map((row) => row.highlights)).toEqual([null, null]);
    const works = query("SELECT heading, body FROM sections WHERE page = '/how-this-site-works' ORDER BY position");
    expect(works[0]).toMatchObject({ heading: 'How this site works' });
    expect(works.map((row) => row.heading)).toContain('Cost and the cap');
    expect(works.map((row) => row.body).join('\n')).toContain(`${Object.keys(tables).length} tables`);
    expect(works.map((row) => row.body).join('\n')).toContain(`${keptFor(TTL.sentQuestion)}.`);
    for (const table of Object.keys(tables)) {
      for (const row of query(`SELECT * FROM ${table}`)) expect(JSON.stringify(row), table).not.toMatch(/\{[a-z_]+\}/);
    }
  });

  it('fails hard on a highlight number it cannot fill, a typed number, or a case study that stops giving one count', async () => {
    const withEdit = (from: string, to: string) => tableRows(parse(edited('projects/this-site.md', from, to)));
    expect(() => withEdit('{eval_questions}-question', '{questions}-question')).toThrow(/\{questions\} is not a number the build knows/);
    expect(() => withEdit('{eval_questions}-question', '42-question')).toThrow(/a number is typed/);
    expect(() => withEdit('{eval_questions}-question', '{eval_questions-question')).toThrow(/a brace is left/);
    const study = 'with 12 Jest tests before the model was wired in';
    for (const [to, found] of [['before the model was wired in', 'found 0'], [`${study}, ${study}`, 'found 2'], ['with many Jest tests before the model was wired in', 'many is not a number']] as const) {
      const changed = edited('projects/splitroof-ai-assistant.md', study, to);
      const again = await renderMarkdown(changed);
      expect(() => tableRows(parseContent(changed, undefined, again))).toThrow(found);
    }
    expect(() => parse(edited('projects/this-site.md', 'highlights:\n', 'notes:\n'))).toThrow();
    const client = edited('projects/uraz-hoops.md', 'technologies: [', 'highlights:\n  - "A bullet."\ntechnologies: [');
    expect(() => parse(client)).toThrow(/client work has no highlights/);
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
    expect(rows.slice(0, 4).map(({ page, position, heading }) => [page, position, heading])).toEqual([
      ['/#about', 1, 'About'],
      ['/#now', 1, 'Now'],
      ['/404', 1, 'Nothing at this address.'],
      ['/how-this-site-works', 1, 'How this site works'],
    ]);
    const studies = query("SELECT page FROM projects WHERE page LIKE '/work/%' ORDER BY id").map((row) => row.page);
    expect(studies).toHaveLength(3);
    expect([...new Set(rows.slice(3).map((row) => row.page))]).toEqual(['/how-this-site-works', ...studies]);
    for (const row of rows) expect(row.body, `${row.page} ${row.heading}`).not.toBe('');
  });

  // The Portfolio site's write-up is /how-this-site-works, so its row points there, it has no
  // case study and no sections of its own, and text in its file would be a mistake.
  it('gives every project its page, the case study under /work/ unless the file names another', () => {
    expect(query('SELECT slug, page FROM projects ORDER BY id')).toEqual([
      { slug: 'splitroof-ai-assistant', page: '/work/splitroof-ai-assistant' },
      { slug: 'think-smarter-review-funnel', page: '/work/think-smarter-review-funnel' },
      { slug: 'uraz-hoops', page: '/work/uraz-hoops' },
      { slug: 'this-site', page: '/how-this-site-works' },
    ]);
    expect(query("SELECT COUNT(*) AS n FROM sections WHERE page = '/work/this-site'")).toEqual([{ n: 0 }]);
    expect(ddl()).toContain('page TEXT NOT NULL, --');
    // The two rows whose pages show no interface show a drawing; the client rows show a screenshot.
    expect(query('SELECT slug, row_image, row_image_alt IS NOT NULL AS described FROM projects ORDER BY id')).toEqual([
      { slug: 'splitroof-ai-assistant', row_image: 'splitroof-flow', described: 1 },
      { slug: 'think-smarter-review-funnel', row_image: 'screenshot', described: 0 },
      { slug: 'uraz-hoops', row_image: 'screenshot', described: 0 },
      { slug: 'this-site', row_image: 'architecture', described: 1 },
    ]);
    expect(ddl()).toContain("row_image TEXT NOT NULL CHECK (row_image IN ('screenshot', 'architecture', 'splitroof-flow'))");
    const withText = { ...files, 'projects/this-site.md': `${files['projects/this-site.md']}\n## The problem\n\nText.\n` };
    return expect(renderMarkdown(withText).then((again) => parseContent(withText, undefined, again))).rejects.toThrow(
      /projects\/this-site.md: its page is \/how-this-site-works, so the text in the file has no page/,
    );
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
