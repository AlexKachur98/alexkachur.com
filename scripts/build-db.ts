// Compiles src/content into the SQLite database, its readable dump, the vendored sql.js files and
// the generated modules. Runs under Node's type stripping, so imports keep their .ts
// extension and nothing here needs a compiler. Astro's loaders drop a row without an id and only
// log an unknown reference, so this script parses the YAML itself and fails hard on both.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';
import { parse as parseYaml } from 'yaml';
import type { z } from 'astro/zod';
import {
  courseContent,
  experienceContent,
  factContent,
  interestContent,
  pageContent,
  petContent,
  projectContent,
  tables,
  technologyContent,
  timelineContent,
  usesContent,
} from '../src/content/schemas.ts';
import type {
  CourseContent,
  ExperienceContent,
  FactContent,
  InterestContent,
  PageContent,
  PetContent,
  ProjectContent,
  TableName,
  TechnologyContent,
  TimelineContent,
  UsesContent,
} from '../src/content/schemas.ts';
import {
  courseRows,
  experienceRows,
  factRows,
  hasCaseStudy,
  interestRows,
  pageImageRows,
  petRows,
  projectImageRows,
  projectRows,
  projectTechnologyRows,
  sectionRows,
  technologyRows,
  timelineRows,
  usesRows,
} from '../src/lib/rows.ts';
import type { Entry, SectionRow } from '../src/lib/rows.ts';
import { DEFAULT_CAP, MODEL } from '../src/lib/ask/config.ts';
import { CACHE_MINIMUM_TOKENS, PRICE, PRICE_CHECKED } from '../src/lib/ask/pricing.ts';
import { QUESTION_LENGTH } from '../src/lib/ask/question.ts';
import { keptFor, RATE_LIMIT, STATS_CACHE, storageRows, TTL } from '../src/lib/ask/storage.ts';
import { renderBody } from '../src/lib/markdown.ts';
import { countIn, fillNumbers, fillPlaceholders } from '../src/lib/numbers.ts';
import { OPENAPI_VERSION } from '../src/lib/openapi-version.ts';
import { queryOf, resumeData, resumeText } from '../src/lib/resume.ts';
import { siteOrigin } from '../src/lib/site.ts';
import { questions } from './eval/questions.ts';

const require = createRequire(import.meta.url);

export interface Content {
  facts: Entry<FactContent>[];
  projects: Entry<ProjectContent>[];
  technologies: Entry<TechnologyContent>[];
  courses: Entry<CourseContent>[];
  timeline: Entry<TimelineContent>[];
  pets: Entry<PetContent>[];
  experience: Entry<ExperienceContent>[];
  interests: Entry<InterestContent>[];
  uses: Entry<UsesContent>[];
  pages: PageEntry[];
  // Each markdown file's body as the site renders it, keyed like ContentFiles.
  rendered: Rendered;
}

// A page file and the address its text appears at.
export interface PageEntry extends Entry<PageContent> {
  page: string;
}

export type Rendered = Record<string, string>;

// File text keyed by path relative to src/content, so tests can hand in edited copies.
export type ContentFiles = Record<string, string>;

export interface ContentPaths {
  contentDir: string;
  publicDir: string;
}

const yamlFiles = ['facts.yaml', 'technologies.yaml', 'courses.yaml', 'timeline.yaml', 'pets.yaml', 'experience.yaml', 'interests.yaml', 'uses.yaml'] as const;

// The page files whose text goes into the sections table, in the order of the tables' rows.
export const pageFiles: Readonly<Record<string, string>> = {
  'pages/about.md': '/#about',
  'pages/now.md': '/#now',
  'pages/404.md': '/404',
  'pages/how-this-site-works.md': '/how-this-site-works',
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readText(path: string): string {
  if (!existsSync(path)) throw new Error(`${path} is missing`);
  return readFileSync(path, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
}

export function readContentFiles(contentDir: string): ContentFiles {
  const files: ContentFiles = {};
  for (const name of yamlFiles) files[name] = readText(join(contentDir, name));
  for (const name of Object.keys(pageFiles)) files[name] = readText(join(contentDir, name));
  const projectDir = join(contentDir, 'projects');
  if (!existsSync(projectDir)) throw new Error(`${projectDir} is missing`);
  for (const name of readdirSync(projectDir).filter((entry) => entry.endsWith('.md')).sort()) {
    files[`projects/${name}`] = readText(join(projectDir, name));
  }
  return files;
}

function validate<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
    throw new Error(`${where}: ${issues.join('; ')}`);
  }
  return result.data;
}

function parseYamlText(name: string, text: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    throw new Error(`${name}: ${message(error)}`);
  }
}

function yamlRows<T>(name: string, text: string, schema: z.ZodType<T>): Entry<T>[] {
  const rows = parseYamlText(name, text);
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${name}: expected a non-empty list of rows`);
  const seen = new Set<string>();
  return rows.map((row: unknown, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`${name}: row ${index + 1} is not a mapping`);
    }
    const id = (row as { id?: unknown }).id;
    if (typeof id !== 'string' || id === '') throw new Error(`${name}: row ${index + 1} has no id`);
    if (seen.has(id)) throw new Error(`${name}: id ${id} appears twice`);
    seen.add(id);
    return { id, data: validate(schema, row, `${name} row ${id}`) };
  });
}

const frontmatter = /^---\n([\s\S]*?)\n---(?:\n|$)/;

// Every markdown file rendered as Astro renders it, so the sections table holds the text the pages show.
export async function renderMarkdown(files: ContentFiles): Promise<Rendered> {
  const rendered: Rendered = {};
  for (const name of Object.keys(files).filter((key) => key.endsWith('.md'))) rendered[name] = await renderBody(files[name]!);
  return rendered;
}

function pageEntry(name: string, text: string, contentDir: string): PageEntry {
  const match = frontmatter.exec(text);
  if (!match) throw new Error(`${name}: no frontmatter`);
  const data = validate(pageContent, parseYamlText(name, match[1]!) ?? {}, name);
  for (const image of data.images ?? []) {
    if (!existsSync(resolve(contentDir, dirname(name), image.src))) throw new Error(`${name}: image ${image.src} does not exist`);
  }
  return { id: name, page: pageFiles[name]!, data };
}

function projectEntry(name: string, text: string, contentDir: string): Entry<ProjectContent> {
  const id = basename(name, '.md');
  // Astro slugifies the file name for its entry id; a name that is not already a slug would give
  // the database a different slug from the endpoints and pages.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`${name}: file name is not a slug`);
  const match = frontmatter.exec(text);
  if (!match) throw new Error(`${name}: no frontmatter`);
  const data = validate(projectContent, parseYamlText(name, match[1]!), name);
  for (const shot of data.screenshots) {
    if (!existsSync(resolve(contentDir, dirname(name), shot.src))) {
      throw new Error(`${name}: screenshot ${shot.src} does not exist`);
    }
  }
  return { id, data };
}

export function parseContent(
  files: ContentFiles,
  paths: ContentPaths = { contentDir: 'src/content', publicDir: 'public' },
  rendered: Rendered = {},
): Content {
  const text = (name: string): string => {
    const value = files[name];
    if (value === undefined) throw new Error(`${name} is missing`);
    return value;
  };
  const content: Content = {
    facts: yamlRows('facts.yaml', text('facts.yaml'), factContent),
    technologies: yamlRows('technologies.yaml', text('technologies.yaml'), technologyContent),
    courses: yamlRows('courses.yaml', text('courses.yaml'), courseContent),
    timeline: yamlRows('timeline.yaml', text('timeline.yaml'), timelineContent),
    pets: yamlRows('pets.yaml', text('pets.yaml'), petContent),
    experience: yamlRows('experience.yaml', text('experience.yaml'), experienceContent),
    interests: yamlRows('interests.yaml', text('interests.yaml'), interestContent),
    uses: yamlRows('uses.yaml', text('uses.yaml'), usesContent),
    projects: Object.keys(files)
      .filter((name) => name.startsWith('projects/'))
      .sort()
      .map((name) => projectEntry(name, files[name]!, paths.contentDir)),
    pages: Object.keys(pageFiles).map((name) => pageEntry(name, text(name), paths.contentDir)),
    rendered,
  };
  if (content.projects.length === 0) throw new Error('projects: no project files');
  // Client work is on the resume through the experience table; every other project has bullets.
  for (const project of content.projects) {
    const client = project.data.kind === 'client';
    if (client && project.data.highlights) throw new Error(`projects/${project.id}.md: client work has no highlights; the experience table covers it`);
    if (!client && !project.data.highlights) throw new Error(`projects/${project.id}.md: highlights are missing`);
  }
  // A core skill is described as backed by a project on this site, so each needs one.
  const used = new Set(projectTechnologyRows(content.projects, content.technologies).map((link) => link.technology_id));
  for (const technology of technologyRows(content.technologies)) {
    if (technology.core === 1 && !used.has(technology.id)) {
      throw new Error(`technologies.yaml: ${technology.name} is core but no project uses it`);
    }
  }
  for (const pet of content.pets) {
    if (!existsSync(join(paths.publicDir, pet.data.photo_url))) {
      throw new Error(`pets.yaml row ${pet.id}: ${pet.data.photo_url} is not under ${paths.publicDir}`);
    }
  }
  for (const name of Object.keys(files).filter((key) => key.endsWith('.md'))) {
    if (rendered[name] === undefined) throw new Error(`${name}: not rendered`);
  }
  // A project covered by another page has no case study, so any text in its file would reach no page.
  for (const project of content.projects) {
    if (!hasCaseStudy(project.id, project.data.page) && rendered[`projects/${project.id}.md`]!.trim() !== '') {
      throw new Error(`projects/${project.id}.md: its page is ${project.data.page}, so the text in the file has no page to appear on`);
    }
  }
  return content;
}

export async function loadContent(paths: ContentPaths = { contentDir: 'src/content', publicDir: 'public' }): Promise<Content> {
  const files = readContentFiles(paths.contentDir);
  return parseContent(files, paths, await renderMarkdown(files));
}

export type Row = Record<string, string | number | null>;

const group = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

// What the eval recorded: the largest first call (the whole request as the model counts it,
// system prompt, question and the shape of the answer), the model and prompt version it ran on,
// and the range of the answers. The fixture is committed, so every build reads the same numbers
// until the eval is recorded again.
export interface RecordedEval {
  promptTokens: number;
  model: string;
  promptVersion: number;
  outputMin: number;
  outputMax: number;
}

export const fixturePath = fileURLToPath(new URL('./eval/fixtures.json', import.meta.url));

export function recordedEval(path = fixturePath): RecordedEval {
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as {
    model: string;
    promptVersion: number;
    questions: { replies: { usage: { input_tokens: number; output_tokens: number } }[] }[];
  };
  const first = fixture.questions.map((entry) => entry.replies[0]?.usage);
  if (first.length === 0 || first.some((usage) => !usage || usage.input_tokens <= 0)) throw new Error(`${path}: a question has no recorded first call`);
  const inputs = first.map((usage) => usage!.input_tokens);
  const outputs = first.map((usage) => usage!.output_tokens);
  return { promptTokens: Math.max(...inputs), model: fixture.model, promptVersion: fixture.promptVersion, outputMin: Math.min(...outputs), outputMax: Math.max(...outputs) };
}

export function recordedPromptTokens(path = fixturePath): number {
  return recordedEval(path).promptTokens;
}

export const measurementsPath = fileURLToPath(new URL('../src/data/measurements.json', import.meta.url));

interface MeasuredPage {
  url: string;
  performance: number;
  accessibility: number;
  best_practices: number;
  seo: number;
  cls: number;
}

export interface Measurements {
  lighthouse: { date: string; tool: string; chrome: string; method: string; pages: Record<'home' | 'works' | 'case_study' | 'uraz' | 'think_smarter', MeasuredPage> };
  html_bytes: { date: string; think_smarter: number; uraz: number };
}

// The Lighthouse medians and page sizes measured on the live pages, with the day and the tool, so
// every sentence that quotes them is filled from this one record and measuring again is one edit.
export function recordedMeasurements(path = measurementsPath): Measurements {
  const measured = JSON.parse(readFileSync(path, 'utf8')) as Measurements;
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (!day.test(measured.lighthouse.date) || !day.test(measured.html_bytes.date)) throw new Error(`${path}: a date is not YYYY-MM-DD`);
  for (const [name, page] of Object.entries(measured.lighthouse.pages)) {
    for (const key of ['performance', 'accessibility', 'best_practices', 'seo'] as const) {
      if (!Number.isInteger(page[key]) || page[key] < 0 || page[key] > 100) throw new Error(`${path}: ${name}.${key} is not a score from 0 to 100`);
    }
    if (typeof page.cls !== 'number' || page.cls < 0) throw new Error(`${path}: ${name}.cls is not a layout shift score`);
  }
  for (const site of ['think_smarter', 'uraz'] as const) {
    if (!Number.isInteger(measured.html_bytes[site]) || measured.html_bytes[site] <= 0) throw new Error(`${path}: html_bytes.${site} is not a byte count`);
  }
  return measured;
}

// The numbers the site's text may name, each from the thing it counts, so a count typed in two
// places can never go stale in one of them: the eval's questions, the OpenAPI version the API
// document declares, the two SplitRoof test counts from the case study's own sentence (where they
// sit beside the screenshot that shows them), the table count, the limits and lifetimes the code
// stores with, what a model call costs from the recorded eval and the published prices, and the
// Lighthouse scores and page sizes from the measurements record.
export function siteNumbers(sections: readonly { page: string; body: string }[], eval_: RecordedEval | number, measured: Measurements = recordedMeasurements()): Record<string, string> {
  const recorded = typeof eval_ === 'number' ? { promptTokens: eval_, model: MODEL.id, promptVersion: 0, outputMin: 0, outputMax: 0 } : eval_;
  const { promptTokens } = recorded;
  const splitroof = sections.filter((section) => section.page === '/work/splitroof-ai-assistant').map((section) => section.body).join('\n');
  const where = 'projects/splitroof-ai-assistant.md';
  // The page says the prompt is under the cache's floor, so a prompt that grows past it stops the build.
  if (promptTokens >= CACHE_MINIMUM_TOKENS) {
    throw new Error(`the prompt is ${promptTokens} tokens, at or over the ${CACHE_MINIMUM_TOKENS}-token cache floor; the caching paragraph on /how-this-site-works is no longer true`);
  }
  // The month's ceiling is the sum of its two rounded parts, so the arithmetic the page shows adds up.
  const dollars = (n: number): number => Math.round(n * 100) / 100;
  const monthInputTokens = DEFAULT_CAP * promptTokens;
  const monthOutputTokens = DEFAULT_CAP * MODEL.maxTokens;
  const monthInputCost = dollars((monthInputTokens * PRICE.input) / 1e6);
  const monthOutputCost = dollars((monthOutputTokens * PRICE.output) / 1e6);
  const monthCost = monthInputCost + monthOutputCost;
  // A layout shift is shown the way Lighthouse shows it, to three places, or as 0 when nothing moved.
  const shift = (n: number): string => (n === 0 ? '0' : n.toFixed(3));
  const kilobytes = (bytes: number): string => String(Math.round(bytes / 1000));
  const scores = Object.fromEntries(
    Object.entries(measured.lighthouse.pages).flatMap(([name, page]) => [
      [`${name}_performance`, String(page.performance)],
      [`${name}_accessibility`, String(page.accessibility)],
      [`${name}_best_practices`, String(page.best_practices)],
      [`${name}_seo`, String(page.seo)],
    ]),
  );
  return {
    month_input_tokens: group(monthInputTokens),
    month_input_cost: `$${monthInputCost.toFixed(2)}`,
    month_output_tokens: group(monthOutputTokens),
    month_output_cost: `$${monthOutputCost.toFixed(2)}`,
    fixture_model: recorded.model,
    fixture_prompt_version: String(recorded.promptVersion),
    output_tokens_min: group(recorded.outputMin),
    output_tokens_max: group(recorded.outputMax),
    eval_questions: String(questions.length),
    openapi_version: OPENAPI_VERSION.split('.').slice(0, 2).join('.'),
    splitroof_tool_tests: String(countIn(splitroof, /(\w+) Jest tests before the model/g, where)),
    splitroof_model_tests: String(countIn(splitroof, /(\w+) more tests then run the assistant against the live model/g, where)),
    table_count: String(Object.keys(tables).length),
    question_min: String(QUESTION_LENGTH.min),
    question_max: String(QUESTION_LENGTH.max),
    rate_limit: String(RATE_LIMIT.requests),
    monthly_cap: group(DEFAULT_CAP),
    answer_cache: keptFor(TTL.answer),
    refusal_cache: keptFor(TTL.refusal),
    sent_question_kept: keptFor(TTL.sentQuestion),
    stats_cache_seconds: String(STATS_CACHE.freshSeconds),
    stats_stale_seconds: String(STATS_CACHE.staleSeconds),
    prompt_tokens: group(promptTokens),
    max_output_tokens: group(MODEL.maxTokens),
    price_input: `$${PRICE.input}`,
    price_output: `$${PRICE.output}`,
    price_checked: PRICE_CHECKED,
    cap_month_cost: `$${monthCost.toFixed(2)}`,
    cache_minimum_tokens: group(CACHE_MINIMUM_TOKENS),
    lighthouse_date: measured.lighthouse.date,
    lighthouse_tool: measured.lighthouse.tool,
    ...scores,
    home_cls: shift(measured.lighthouse.pages.home.cls),
    works_cls: shift(measured.lighthouse.pages.works.cls),
    think_smarter_html_kb: kilobytes(measured.html_bytes.think_smarter),
    uraz_html_kb: kilobytes(measured.html_bytes.uraz),
  };
}

// Every page's and case study's text as the table stores it, before its numbers are filled in.
function rawSections(content: Content): SectionRow[] {
  return sectionRows([
    ...content.pages.map((entry) => ({ page: entry.page, title: entry.data.title, html: content.rendered[entry.id]! })),
    ...[...content.projects]
      .filter((entry) => hasCaseStudy(entry.id, entry.data.page))
      .sort((a, b) => a.data.order - b.data.order)
      .map((entry) => ({ page: `/work/${entry.id}`, html: content.rendered[`projects/${entry.id}.md`]! })),
  ]);
}

export function siteNumbersFor(content: Content, recorded = recordedEval()): Record<string, string> {
  return siteNumbers(rawSections(content), recorded);
}

export function tableRows(content: Content, recorded: RecordedEval | number = recordedEval()): Record<TableName, Row[]> {
  const raw = rawSections(content);
  const numbers = siteNumbers(raw, recorded);
  const sections = raw.map((row) => ({ ...row, body: fillPlaceholders(row.body, numbers, `${row.page} ${row.heading}`) }));
  return {
    facts: factRows(content.facts),
    projects: projectRows(content.projects).map((row) => ({
      ...row,
      highlights: row.highlights === null ? null : fillNumbers(row.highlights, numbers, `projects/${row.slug}.md`),
    })),
    technologies: technologyRows(content.technologies),
    project_technologies: projectTechnologyRows(content.projects, content.technologies),
    project_images: projectImageRows(content.projects).map((row) => ({
      ...row,
      caption: row.caption === null ? null : fillPlaceholders(row.caption, numbers, `project ${row.project_id} screenshot ${row.position}`),
    })),
    courses: courseRows(content.courses),
    timeline: timelineRows(content.timeline),
    pets: petRows(content.pets),
    experience: experienceRows(content.experience),
    interests: interestRows(content.interests),
    // Built from the lifetimes the code uses, not from the content files.
    storage: storageRows(),
    uses: usesRows(content.uses),
    sections,
    page_images: pageImageRows(content.pages.map((entry) => ({ page: entry.page, images: entry.data.images ?? [] }))),
  };
}

// The subset of a zod v4 definition the DDL needs.
interface ZodDef {
  type: string;
  innerType?: { def: ZodDef };
  entries?: Record<string, string>;
  values?: readonly (string | number)[];
}

interface ZodLike {
  def: ZodDef;
  description?: string;
}

export interface Column {
  name: string;
  type: 'INTEGER' | 'TEXT';
  nullable: boolean;
  values?: readonly (string | number)[];
  description: string;
}

function column(name: string, schema: ZodLike): Column {
  let def = schema.def;
  let nullable = false;
  while ((def.type === 'nullable' || def.type === 'optional') && def.innerType) {
    nullable = true;
    def = def.innerType.def;
  }
  const description = schema.description ?? '';
  switch (def.type) {
    case 'number':
      return { name, type: 'INTEGER', nullable, description };
    case 'string':
      return { name, type: 'TEXT', nullable, description };
    case 'enum':
      return { name, type: 'TEXT', nullable, values: Object.values(def.entries ?? {}), description };
    case 'literal': {
      const values = def.values ?? [];
      const type = values.every((value) => typeof value === 'number') ? 'INTEGER' : 'TEXT';
      return { name, type, nullable, values, description };
    }
    default:
      throw new Error(`column ${name}: no SQLite type for zod ${def.type}`);
  }
}

export function columns(table: TableName): Column[] {
  const shape = tables[table].row.shape as Record<string, ZodLike>;
  return Object.entries(shape).map(([name, schema]) => column(name, schema));
}

function literal(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

export function ddl(): string {
  return (Object.keys(tables) as TableName[])
    .map((table) => {
      const { description } = tables[table];
      const primaryKey = tables[table].primaryKey as readonly string[];
      const unique = tables[table].unique as readonly string[];
      const lines = columns(table).map((col) => {
        const isRowId = col.type === 'INTEGER' && primaryKey.length === 1 && primaryKey[0] === col.name;
        let line = `  ${col.name} ${col.type}`;
        if (primaryKey.length === 1 && primaryKey[0] === col.name) line += ' PRIMARY KEY';
        if (!col.nullable && !isRowId) line += ' NOT NULL';
        if (unique.includes(col.name)) line += ' UNIQUE';
        if (col.values) line += ` CHECK (${col.name} IN (${col.values.map(literal).join(', ')}))`;
        return { line, comment: col.description };
      });
      if (primaryKey.length > 1) lines.push({ line: `  PRIMARY KEY (${primaryKey.join(', ')})`, comment: '' });
      const body = lines
        .map(({ line, comment }, index) => `${line}${index < lines.length - 1 ? ',' : ''}${comment ? ` -- ${comment}` : ''}`)
        .join('\n');
      return `-- ${description}\nCREATE TABLE ${table} (\n${body}\n);`;
    })
    .join('\n\n');
}

export function dumpSql(content: Content): string {
  const rows = tableRows(content);
  const inserts = (Object.keys(tables) as TableName[]).flatMap((table) =>
    rows[table].map((row) => {
      const keys = Object.keys(row);
      return `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((key) => literal(row[key] ?? null)).join(', ')});`;
    }),
  );
  return `-- portfolio.sql: the whole database behind alexkachur.com, generated by scripts/build-db.ts from src/content.\n\n${ddl()}\n\n${inserts.join('\n')}\n`;
}

function wasmPath(): string {
  return require.resolve('sql.js/dist/sql-wasm.wasm');
}

function wasmBinary(): ArrayBuffer {
  const bytes = readFileSync(wasmPath());
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

// sql.js memoises its first initialisation per process, so this is one wasm compile per build.
export function loadSqlJs(): Promise<SqlJsStatic> {
  return initSqlJs({ wasmBinary: wasmBinary() });
}

export function buildDatabase(SQL: SqlJsStatic, sql: string): Uint8Array {
  const db = new SQL.Database();
  try {
    db.run(sql);
    db.run('VACUUM');
    return db.export();
  } finally {
    db.close();
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function schemaJson(content: Content) {
  const ddlText = ddl();
  const tableList = (Object.keys(tables) as TableName[]).map((table) => {
    const unique = tables[table].unique as readonly string[];
    return {
      name: table,
      description: tables[table].description,
      primaryKey: [...tables[table].primaryKey],
      columns: columns(table).map((col) => ({
        name: col.name,
        type: col.type,
        nullable: col.nullable,
        unique: unique.includes(col.name),
        ...(col.values ? { values: [...col.values] } : {}),
        description: col.description,
      })),
    };
  });
  // The ask cache key carries the first 8 characters of this hash, so it covers exactly what
  // the model is shown: the DDL, the table list, the keys the facts table holds with what each
  // means, and the pages and headings the sections table holds, which the prompt lists because
  // the DDL cannot show them.
  const facts = factRows(content.facts).map(({ key, description }) => ({ key, description }));
  const factKeys = facts.map((fact) => fact.key);
  const sections = tableRows(content).sections;
  const sectionPages = [...new Set(sections.map((section) => section.page))].sort();
  const sectionHeadings = [...new Set(sections.map((section) => section.heading))];
  const hash = sha256(JSON.stringify({ ddl: ddlText, tables: tableList, factKeys, facts, sectionPages, sectionHeadings }));
  const photoAlt = Object.fromEntries(petRows(content.pets).map((pet) => [pet.photo_url, pet.photo_alt]));
  return { hash, ddl: ddlText, tables: tableList, factKeys, facts, sectionPages, sectionHeadings, photoAlt };
}

export function buildInfo(env: NodeJS.ProcessEnv = process.env): { commit: string; builtAt: string } {
  const commit = env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA || gitHead() || 'local';
  return { commit, builtAt: new Date().toISOString() };
}

function gitHead(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return undefined;
  }
}

function base64Module(name: string, bytes: Uint8Array, what: string): string {
  return `// Generated by scripts/build-db.ts, do not edit. ${what}\nexport const ${name} = '${Buffer.from(bytes).toString('base64')}';\n`;
}

export function decodeBase64Module(text: string): Uint8Array {
  const match = /= '([A-Za-z0-9+/=]*)';/.exec(text);
  if (!match) throw new Error('not a generated base64 module');
  return Buffer.from(match[1]!, 'base64');
}

// sql.js exports only "." and "./dist/*", so its package.json is read next to the resolved dist file.
const sqlJsVersion = (
  JSON.parse(readFileSync(join(dirname(wasmPath()), '..', 'package.json'), 'utf8')) as { version: string }
).version;

export async function main(root = process.cwd()): Promise<void> {
  // This script owns public/vendor: anything but the current sql.js copy is stale or stray.
  const vendorDir = join(root, 'public', 'vendor');
  mkdirSync(vendorDir, { recursive: true });
  for (const entry of readdirSync(vendorDir)) {
    if (entry !== `sql.js-${sqlJsVersion}`) rmSync(join(vendorDir, entry), { recursive: true, force: true });
  }
  const vendorTarget = join(vendorDir, `sql.js-${sqlJsVersion}`);
  mkdirSync(vendorTarget, { recursive: true });
  copyFileSync(require.resolve('sql.js/dist/sql-wasm.js'), join(vendorTarget, 'sql-wasm.js'));
  copyFileSync(wasmPath(), join(vendorTarget, 'sql-wasm.wasm'));

  const content = await loadContent({ contentDir: join(root, 'src', 'content'), publicDir: join(root, 'public') });
  const sql = dumpSql(content);
  const SQL = await loadSqlJs();
  const bytes = buildDatabase(SQL, sql);

  const dataDir = join(root, 'public', 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'portfolio.sqlite'), bytes);
  writeFileSync(join(dataDir, 'portfolio.sql'), sql);

  // The plain-text resume curl gets, from the database just written.
  const db = new SQL.Database(bytes);
  try {
    writeFileSync(join(root, 'public', 'resume.txt'), resumeText(resumeData(queryOf(db)), siteOrigin()));
  } finally {
    db.close();
  }

  const generated = join(root, 'src', 'generated');
  mkdirSync(generated, { recursive: true });
  const dbModule = join(generated, 'portfolio-db.ts');
  writeFileSync(dbModule, base64Module('portfolioDbBase64', bytes, 'The bytes of public/data/portfolio.sqlite.'));
  writeFileSync(
    join(generated, 'sql-wasm.ts'),
    base64Module('sqlWasmBase64', readFileSync(wasmPath()), `sql-wasm.wasm from sql.js ${sqlJsVersion}.`),
  );
  writeFileSync(join(generated, 'schema.json'), `${JSON.stringify(schemaJson(content), null, 2)}\n`);
  writeFileSync(join(generated, 'numbers.json'), `${JSON.stringify(siteNumbersFor(content), null, 2)}\n`);
  writeFileSync(join(generated, 'build-info.json'), `${JSON.stringify(buildInfo(), null, 2)}\n`);

  // The server-side validator trusts the module, so prove it decodes to the file just written.
  if (!Buffer.from(decodeBase64Module(readText(dbModule))).equals(readFileSync(join(dataDir, 'portfolio.sqlite')))) {
    throw new Error('src/generated/portfolio-db.ts does not match public/data/portfolio.sqlite');
  }
}

// Node resolves the entry module through its real path, so a symlinked checkout must compare the same way.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  await main();
}
