// Build-time reads of the built database, for pages and endpoints that render from it, so what a
// page shows is what a visitor's query would return.
import { openDatabase } from './ask/db.ts';

type Cell = string | number | null;

export interface Rows {
  columns: string[];
  rows: Cell[][];
}

export async function select(sql: string): Promise<Rows> {
  const db = await openDatabase();
  const statement = db.prepare(sql);
  try {
    const rows: Cell[][] = [];
    while (statement.step()) rows.push(statement.get() as Cell[]);
    return { columns: statement.getColumnNames(), rows };
  } finally {
    statement.free();
  }
}

