// Build-time reads of the built database, for pages and endpoints that render from it, so what a
// page shows is what a visitor's query would return.
import type { Database } from 'sql.js';
import type { TableName } from '../content/schemas.ts';
import { openDatabase } from './ask/db.ts';
import { queryOf, resumeData, resumeJson } from './resume.ts';
import { stackQuery } from './rows.ts';

type Cell = string | number | null;

export interface Rows {
  columns: string[];
  rows: Cell[][];
}

// A statement's column names and rows, stepped no further than the limit when there is one.
export function rowsOf(db: Database, sql: string, limit = Infinity): Rows {
  const statement = db.prepare(sql);
  try {
    const rows: Cell[][] = [];
    while (rows.length < limit && statement.step()) rows.push(statement.get() as Cell[]);
    return { columns: statement.getColumnNames(), rows };
  } finally {
    statement.free();
  }
}

export async function select(sql: string, limit?: number): Promise<Rows> {
  return rowsOf(await openDatabase(), sql, limit);
}

// A table's rows as /api/{table}.json serves them: the columns in their DDL order and the rows in
// the order they were written.
export async function tableObjects(table: TableName): Promise<Record<string, Cell>[]> {
  const { columns, rows } = await select(`SELECT * FROM ${table} ORDER BY rowid`);
  return rows.map((row) => Object.fromEntries(columns.map((name, index) => [name, row[index] ?? null])));
}

// A projects row with the names of its technologies, as /api/projects/{slug}.json serves it.
export async function projectDetail(project: Record<string, Cell>): Promise<Record<string, Cell | Cell[]>> {
  const stack = await select(stackQuery(Number(project.id)));
  return { ...project, technologies: stack.rows.flat() };
}

// The resume in the JSON Resume format, as /api/resume.json serves it.
export async function resumeJsonFor(origin: string) {
  return resumeJson(resumeData(queryOf(await openDatabase())), origin);
}

// This site's own repository, from the Portfolio site project's row.
export async function siteRepo(): Promise<string> {
  const repo = (await select("SELECT repo_url FROM projects WHERE slug = 'this-site'")).rows[0]?.[0];
  if (typeof repo !== 'string') throw new Error('the this-site project has no repo_url');
  return repo;
}
