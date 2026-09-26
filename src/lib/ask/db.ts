// One read-only database per process, opened from the generated modules so the function reads
// nothing from disk: public/ is not in the bundle, and Vercel's file tracer cannot follow the
// .wasm path sql.js builds at run time.
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import { portfolioDbBase64 } from '../../generated/portfolio-db.ts';
import { sqlWasmBase64 } from '../../generated/sql-wasm.ts';

let opening: Promise<Database> | undefined;

export function openDatabase(): Promise<Database> {
  return (opening ??= openConnection());
}

// A connection of its own, for a caller that must never step the shared one.
export async function openConnection(): Promise<Database> {
  const wasm = Buffer.from(sqlWasmBase64, 'base64');
  const SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
  const db = new SQL.Database(Buffer.from(portfolioDbBase64, 'base64'));
  db.run('PRAGMA query_only = 1');
  return db;
}
