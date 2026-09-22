import { describe, expect, it } from 'vitest';
import { examples } from '../src/data/examples.ts';
import { openDatabase } from '../src/lib/ask/db.ts';
import { explanationProblem, precheck, stripQuoted, validateSql } from '../src/lib/ask/validate-sql.ts';

const db = await openDatabase();

function check(sql: string) {
  return validateSql(sql, db);
}

function lexical(message: string) {
  return { ok: false, stage: 'lexical', message };
}

describe('validateSql accepts read-only statements', () => {
  it('accepts a plain SELECT, a WITH and a WITH RECURSIVE', () => {
    expect(check('SELECT name FROM projects')).toEqual({ ok: true, sql: 'SELECT name FROM projects' });
    expect(check('WITH p AS (SELECT name FROM projects) SELECT name FROM p')).toMatchObject({ ok: true });
    expect(
      check('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5) SELECT x FROM c'),
    ).toMatchObject({ ok: true });
  });

  it('accepts lowercase keywords, leading whitespace and newlines', () => {
    expect(check('select name from projects')).toEqual({ ok: true, sql: 'select name from projects' });
    expect(check('\n\n  select name\n  from projects\n')).toEqual({ ok: true, sql: 'select name\n  from projects' });
  });

  it('strips one trailing semicolon and the whitespace around the statement', () => {
    const result = check('  SELECT name FROM projects ;  \n');
    expect(result).toEqual({ ok: true, sql: 'SELECT name FROM projects' });
    expect(result.ok && result.sql).not.toMatch(/;|^\s|\s$/);
  });

  it('ignores keywords inside string literals', () => {
    expect(check("SELECT name FROM projects WHERE summary LIKE '%DELETE%'")).toMatchObject({ ok: true });
    expect(check("SELECT name FROM projects WHERE summary = 'drop table projects'")).toMatchObject({ ok: true });
  });

  it('reads a doubled quote as an escape, not the end of the literal', () => {
    expect(check("SELECT 'it''s a DELETE' AS t FROM projects")).toMatchObject({ ok: true });
    expect(check("SELECT 'it''s' DELETE")).toEqual(lexical('DELETE is not allowed'));
  });

  it('allows comment markers and semicolons inside a literal', () => {
    expect(check("SELECT '--' AS a, '/* x */' AS b FROM projects")).toMatchObject({ ok: true });
    expect(check("SELECT 'a;b' AS t FROM projects")).toEqual({ ok: true, sql: "SELECT 'a;b' AS t FROM projects" });
  });

  it('accepts double-quoted, bracketed and backticked identifiers', () => {
    expect(check('SELECT "name" FROM projects')).toMatchObject({ ok: true });
    expect(check('SELECT [name] FROM [projects]')).toMatchObject({ ok: true });
    expect(check('SELECT `name` FROM `projects`')).toMatchObject({ ok: true });
  });

  it('lets a banned word through as the text of a quoted identifier', () => {
    expect(check('SELECT name AS "update" FROM projects')).toMatchObject({ ok: true });
    expect(check('SELECT name AS [drop] FROM projects')).toMatchObject({ ok: true });
  });

  it('does not match a banned word inside a longer column name', () => {
    expect(check('SELECT year_end FROM projects')).toMatchObject({ ok: true });
    expect(precheck('SELECT updated_at FROM projects')).toEqual({ ok: true, sql: 'SELECT updated_at FROM projects' });
    expect(precheck('SELECT created, deleted FROM projects')).toMatchObject({ ok: true });
    expect(check('SELECT updated_at FROM projects')).toEqual({
      ok: false,
      stage: 'engine',
      message: 'no such column: updated_at',
    });
  });

  it('validates the six example queries', () => {
    expect(examples).toHaveLength(6);
    for (const { label, sql } of examples) {
      expect(sql.endsWith(';'), label).toBe(true);
      expect(check(sql), label).toEqual({ ok: true, sql: sql.slice(0, -1) });
    }
  });
});

describe('validateSql rejects at the lexical stage', () => {
  it('rejects a second statement even when it is harmless', () => {
    const rule = lexical('only one statement is allowed');
    expect(check('SELECT 1; SELECT 2')).toEqual(rule);
    expect(check('SELECT name FROM projects; SELECT name FROM pets;')).toEqual(rule);
    expect(check('SELECT 1;;')).toEqual(rule);
  });

  it('rejects comments outside quotes', () => {
    const rule = lexical('comments are not allowed');
    expect(check('SELECT 1 -- and more')).toEqual(rule);
    expect(check('SELECT /* nothing */ 1')).toEqual(rule);
    expect(check('SELECT name FROM projects --')).toEqual(rule);
  });

  it('rejects a quote that never closes', () => {
    const rule = lexical('a quote never closes');
    expect(check("SELECT 'abc FROM projects")).toEqual(rule);
    expect(check('SELECT "name FROM projects')).toEqual(rule);
    expect(check('SELECT [name FROM projects')).toEqual(rule);
  });

  it('rejects anything that does not start with SELECT or WITH', () => {
    const rule = lexical('the statement must start with SELECT or WITH');
    for (const sql of [
      "INSERT INTO facts VALUES ('k', 'v')",
      "UPDATE facts SET value = 'x'",
      'DELETE FROM facts',
      'DROP TABLE facts',
      'PRAGMA table_info(facts)',
      'EXPLAIN SELECT 1',
      'VACUUM',
      "ATTACH DATABASE 'x' AS y",
      '1 + 1',
      '',
      'SELECTX',
    ]) {
      expect(check(sql), JSON.stringify(sql)).toEqual(rule);
    }
  });

  it('rejects a banned word as a whole word anywhere', () => {
    expect(check('WITH x AS (SELECT 1) DELETE FROM projects')).toEqual(lexical('DELETE is not allowed'));
    expect(check('SELECT * FROM sqlite_master')).toEqual(lexical('sqlite_master is not allowed'));
    expect(check('SELECT * FROM main.sqlite_schema')).toEqual(lexical('sqlite_schema is not allowed'));
    expect(check('SELECT * FROM sqlite_temp_master')).toEqual(lexical('sqlite_temp_master is not allowed'));
    expect(check('SELECT * FROM sqlite_temp_schema')).toEqual(lexical('sqlite_temp_schema is not allowed'));
    expect(check('SELECT 1 ATTACH')).toEqual(lexical('ATTACH is not allowed'));
    expect(check('select * from Sqlite_Master')).toEqual(lexical('Sqlite_Master is not allowed'));
    expect(check("SELECT name FROM projects WHERE 1 = 1 pragma")).toEqual(lexical('pragma is not allowed'));
  });

  it('rejects a schema table hidden inside identifier quotes', () => {
    expect(check('SELECT * FROM "sqlite_master"')).toEqual(lexical('sqlite_master is not allowed'));
    expect(check('SELECT * FROM [sqlite_master]')).toEqual(lexical('sqlite_master is not allowed'));
    expect(check('SELECT * FROM `sqlite_schema`')).toEqual(lexical('sqlite_schema is not allowed'));
    expect(check('SELECT sql FROM main."sqlite_temp_master"')).toEqual(lexical('sqlite_temp_master is not allowed'));
    expect(check("SELECT 'sqlite_master' AS t FROM projects")).toMatchObject({ ok: true });
  });

  it('rejects REPLACE INTO after a WITH clause but keeps the replace function', () => {
    expect(check("WITH t AS (SELECT 1) REPLACE INTO facts SELECT 'k', 'v'")).toEqual(lexical('REPLACE INTO is not allowed'));
    expect(check("SELECT replace(name, 'a', 'b') AS n FROM projects")).toMatchObject({ ok: true });
  });
});

describe('validateSql rejects at the engine stage', () => {
  it('reports an unknown table with the SQLite message', () => {
    expect(check('SELECT * FROM missing')).toEqual({ ok: false, stage: 'engine', message: 'no such table: missing' });
  });

  it('reports an unknown column', () => {
    expect(check('SELECT missing FROM projects')).toEqual({
      ok: false,
      stage: 'engine',
      message: 'no such column: missing',
    });
  });

  it('reports bad syntax', () => {
    expect(check('SELECT FROM WHERE')).toMatchObject({
      ok: false,
      stage: 'engine',
      message: expect.stringContaining('syntax error'),
    });
  });

  it('leaves the database usable after a failure', () => {
    check('SELECT * FROM missing');
    check('SELECT FROM WHERE');
    expect(check('SELECT name FROM projects')).toEqual({ ok: true, sql: 'SELECT name FROM projects' });
  });

  it('compiles without running the statement', () => {
    const start = performance.now();
    expect(check('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c')).toMatchObject({
      ok: true,
    });
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe('explanationProblem', () => {
  it('accepts a normal sentence', () => {
    expect(explanationProblem('Projects with paid set to 1, newest first.')).toBeNull();
  });

  it('leaves an empty explanation to the handler, which treats it as a missing refusal reason', () => {
    expect(explanationProblem('')).toBeNull();
  });

  it('allows 240 characters and rejects 241', () => {
    expect(explanationProblem('a'.repeat(240))).toBeNull();
    expect(explanationProblem('a'.repeat(241))).toBe('long_explanation');
  });

  it('rejects a line break', () => {
    expect(explanationProblem('one\ntwo')).toBe('multiline_explanation');
    expect(explanationProblem('one\r\ntwo')).toBe('multiline_explanation');
  });

  it('rejects a link in any common form', () => {
    for (const text of [
      'see https://example.com',
      'see http://example.com',
      'see ftp://example.com/x',
      'see www.example.com',
      'See WWW.example.com',
    ]) {
      expect(explanationProblem(text), text).toBe('url_in_explanation');
    }
  });

  it('allows a bare domain name', () => {
    expect(explanationProblem('The rows come from the alexkachur.com database.')).toBeNull();
  });
});

describe('stripQuoted', () => {
  it('returns null when a quote never closes', () => {
    expect(stripQuoted("SELECT 'abc")).toBeNull();
    expect(stripQuoted('SELECT [name FROM t')).toBeNull();
    expect(stripQuoted("SELECT 'it''s")).toBeNull();
  });

  it('keeps the text outside quotes and blanks each quoted region', () => {
    expect(stripQuoted('SELECT 1')).toBe('SELECT 1');
    expect(stripQuoted("SELECT 'x' FROM t")).toBe('SELECT   FROM t');
    expect(stripQuoted('SELECT "a""b", [c], `d` FROM t')).toBe('SELECT  ,  ,   FROM t');
    expect(stripQuoted("SELECT 'a;b' -- 'c'")).toBe('SELECT   --  ');
  });
});
