// Compiles src/content into the SQLite database, its readable dump, the vendored sql.js files and
// the generated modules. Runs under Node's type stripping, so imports keep their .ts
// extension and nothing here needs a compiler. Astro's loaders drop a row without an id and only
// log an unknown reference, so this script parses the YAML itself and fails hard on both.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';
import { parse as parseYaml } from 'yaml';
import type { z } from 'astro/zod';
import {
  courseContent,
  factContent,
  petContent,
  projectContent,
  tables,
  technologyContent,
  timelineContent,
} from '../src/content/schemas.ts';
import type {
  CourseContent,
  FactContent,
  PetContent,
  ProjectContent,
  TableName,
  TechnologyContent,
  TimelineContent,
} from '../src/content/schemas.ts';
import {
  courseRows,
  factRows,
  petRows,
  projectRows,
  projectTechnologyRows,
  technologyRows,
  timelineRows,
} from '../src/lib/rows.ts';
import type { Entry } from '../src/lib/rows.ts';

const require = createRequire(import.meta.url);

export interface Content {
  facts: Entry<FactContent>[];
  projects: Entry<ProjectContent>[];
  technologies: Entry<TechnologyContent>[];
  courses: Entry<CourseContent>[];
  timeline: Entry<TimelineContent>[];
  pets: Entry<PetContent>[];
}

// File text keyed by path relative to src/content, so tests can hand in edited copies.
export type ContentFiles = Record<string, string>;

export interface ContentPaths {
  contentDir: string;
  publicDir: string;
}

const yamlFiles = ['facts.yaml', 'technologies.yaml', 'courses.yaml', 'timeline.yaml', 'pets.yaml'] as const;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readText(path: string): string {
  if (!existsSync(path)) throw new Error(`${path} is missing`);
  return readFileSync(path, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

export function readContentFiles(contentDir: string): ContentFiles {
  const files: ContentFiles = {};
  for (const name of yamlFiles) files[name] = readText(join(contentDir, name));
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

function projectEntry(name: string, text: string, contentDir: string): Entry<ProjectContent> {
  const id = basename(name, '.md');
  // Astro slugifies the file name for its entry id; a name that is not already a slug would give
  // the database a different slug from the endpoints and pages.
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`${name}: file name is not a slug`);
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
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
    projects: Object.keys(files)
      .filter((name) => name.startsWith('projects/'))
      .sort()
      .map((name) => projectEntry(name, files[name]!, paths.contentDir)),
  };
  if (content.projects.length === 0) throw new Error('projects: no project files');
  projectTechnologyRows(content.projects, content.technologies);
  for (const pet of content.pets) {
    if (!existsSync(join(paths.publicDir, pet.data.photo_url))) {
      throw new Error(`pets.yaml row ${pet.id}: ${pet.data.photo_url} is not under ${paths.publicDir}`);
    }
  }
  return content;
}

export function loadContent(paths: ContentPaths = { contentDir: 'src/content', publicDir: 'public' }): Content {
  return parseContent(readContentFiles(paths.contentDir), paths);
}

export type Row = Record<string, string | number | null>;

export function tableRows(content: Content): Record<TableName, Row[]> {
  return {
    facts: factRows(content.facts),
    projects: projectRows(content.projects),
    technologies: technologyRows(content.technologies),
    project_technologies: projectTechnologyRows(content.projects, content.technologies),
    courses: courseRows(content.courses),
    timeline: timelineRows(content.timeline),
    pets: petRows(content.pets),
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
  // the model is shown: the DDL, the table list and the keys the facts table holds, which the
  // prompt names because the DDL cannot show them.
  const factKeys = factRows(content.facts).map((fact) => fact.key);
  const hash = sha256(JSON.stringify({ ddl: ddlText, tables: tableList, factKeys }));
  const photoAlt = Object.fromEntries(petRows(content.pets).map((pet) => [pet.photo_url, pet.photo_alt]));
  return { hash, ddl: ddlText, tables: tableList, factKeys, photoAlt };
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

  const content = loadContent({ contentDir: join(root, 'src', 'content'), publicDir: join(root, 'public') });
  const sql = dumpSql(content);
  const bytes = buildDatabase(await loadSqlJs(), sql);

  const dataDir = join(root, 'public', 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'portfolio.sqlite'), bytes);
  writeFileSync(join(dataDir, 'portfolio.sql'), sql);

  const generated = join(root, 'src', 'generated');
  mkdirSync(generated, { recursive: true });
  const dbModule = join(generated, 'portfolio-db.ts');
  writeFileSync(dbModule, base64Module('portfolioDbBase64', bytes, 'The bytes of public/data/portfolio.sqlite.'));
  writeFileSync(
    join(generated, 'sql-wasm.ts'),
    base64Module('sqlWasmBase64', readFileSync(wasmPath()), `sql-wasm.wasm from sql.js ${sqlJsVersion}.`),
  );
  writeFileSync(join(generated, 'schema.json'), `${JSON.stringify(schemaJson(content), null, 2)}\n`);
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
