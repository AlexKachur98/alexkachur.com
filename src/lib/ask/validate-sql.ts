// Checks the SQL the model returned before the browser runs it. A lexical pass first, then the
// real engine: prepare() against the actual database rejects bad syntax, unknown tables and
// unknown columns, and compiles only the first statement. The statement is never stepped here,
// because sql.js cannot interrupt a running query.
import type { Database } from 'sql.js';

// Whole words that never belong in a read-only query. REPLACE is not listed because it is also
// SQLite's string function; the worker's query_only pragma stops a REPLACE INTO at step time.
export const BANNED_WORDS = [
  'ATTACH',
  'DETACH',
  'PRAGMA',
  'INSERT',
  'UPDATE',
  'DELETE',
  'DROP',
  'ALTER',
  'CREATE',
  'VACUUM',
  'sqlite_master',
  'sqlite_schema',
  'sqlite_temp_master',
  'sqlite_temp_schema',
] as const;

export const EXPLANATION_MAX = 240;

export type Validation = { ok: true; sql: string } | { ok: false; stage: 'lexical' | 'engine'; message: string };

const banned = new RegExp(`\\b(${BANNED_WORDS.join('|')})\\b`, 'i');
const schemaTable = new RegExp(`\\b(${BANNED_WORDS.filter((word) => word.startsWith('sqlite_')).join('|')})\\b`, 'i');
// The one write statement a WITH clause can introduce that no banned word catches.
const replaceInto = /\bREPLACE\s+INTO\b/i;

// Rewrites the quoted regions of a statement: string literals and quoted identifiers (double
// quotes, backticks, brackets) each become a space, or with keepText only their quote characters
// go and the text inside stays visible. Returns null when a quote never closes.
function rewriteQuoted(sql: string, keepText: boolean): string | null {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const close = ch === '[' ? ']' : ch === "'" || ch === '"' || ch === '`' ? ch : null;
    if (close === null) {
      out += ch;
      i += 1;
      continue;
    }
    let j = i + 1;
    for (;;) {
      const end = sql.indexOf(close, j);
      if (end === -1) return null;
      // A doubled quote inside a quoted region is an escaped quote, not the end of it.
      if (close !== ']' && sql[end + 1] === close) {
        j = end + 2;
        continue;
      }
      j = end + 1;
      break;
    }
    out += keepText ? ` ${sql.slice(i + 1, j - 1)} ` : ' ';
    i = j;
  }
  return out;
}

// Every quoted region replaced by a space, so a keyword or semicolon inside quotes cannot trip
// the checks and cannot hide from them either.
export function stripQuoted(sql: string): string | null {
  return rewriteQuoted(sql, false);
}

function lexical(message: string): Validation {
  return { ok: false, stage: 'lexical', message };
}

export function precheck(input: string): Validation {
  let sql = input.trim();
  if (sql.endsWith(';')) sql = sql.slice(0, -1).trimEnd();
  const bare = stripQuoted(sql);
  if (bare === null) return lexical('a quote never closes');
  if (bare.includes('--') || bare.includes('/*')) return lexical('comments are not allowed');
  if (bare.includes(';')) return lexical('only one statement is allowed');
  if (!/^(SELECT|WITH)\b/i.test(bare)) return lexical('the statement must start with SELECT or WITH');
  const hit = banned.exec(bare) ?? replaceInto.exec(bare);
  if (hit) return lexical(`${hit[1] ?? 'REPLACE INTO'} is not allowed`);
  // A quoted "sqlite_master" is still that table to the engine, and so is 'sqlite_master' where
  // only a name fits, so the schema tables are checked again with every quote removed.
  const quoted = schemaTable.exec(rewriteQuoted(sql, true) ?? '');
  if (quoted) return lexical(`${quoted[1]} is not allowed`);
  return { ok: true, sql };
}

export function validateSql(input: string, db: Database): Validation {
  const checked = precheck(input);
  if (!checked.ok) return checked;
  try {
    db.prepare(checked.sql).free();
  } catch (error) {
    return { ok: false, stage: 'engine', message: error instanceof Error ? error.message : String(error) };
  }
  return checked;
}

// The explanation is the one model output shown without validation by the engine, so it is
// kept short, on one line and free of links. Returns the reason it fails, for the log.
export function explanationProblem(text: string): string | null {
  if (text.length > EXPLANATION_MAX) return 'long_explanation';
  if (/[\r\n]/.test(text)) return 'multiline_explanation';
  if (/\b[a-z][a-z0-9+.-]*:\/\/|\bwww\./i.test(text)) return 'url_in_explanation';
  return null;
}
