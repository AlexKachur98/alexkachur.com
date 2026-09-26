import type { Database } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import schema from '../src/generated/schema.json';
import { checkProblem } from '../scripts/eval.ts';
import { openConnection } from '../src/lib/ask/db.ts';
import { questions } from '../scripts/eval/questions.ts';
import type { EvalQuestion } from '../scripts/eval/questions.ts';

// The eval's checks run here on the built database with answers written by hand, so a bound that
// could never fail, or an expectation a correct answer cannot meet, shows up without a model call.
let db: Database;
beforeAll(async () => {
  db = await openConnection();
});

const answer = (sql: string) => ({ status: 200, body: { sql, explanation: 'x', cached: false } });
const entry = (question: string): EvalQuestion => {
  const found = questions.find((candidate) => candidate.question === question);
  if (!found) throw new Error(`no eval question ${question}`);
  return found;
};
const check = (question: string, sql: string) => checkProblem(entry(question), answer(sql), db);

describe('row bounds', () => {
  const bounded: EvalQuestion = { question: 'x', expect: 'sql', minRows: 2, maxRows: 8 };

  it('holds an answer to its row bounds, counted as the console steps them', () => {
    expect(checkProblem(bounded, answer('SELECT area, COUNT(*) AS interests FROM interests GROUP BY area'), db)).toBeNull();
    expect(checkProblem(bounded, answer('SELECT COUNT(*) AS interests FROM interests'), db)).toBe('1 row, fewer than 2');
    expect(checkProblem(bounded, answer('SELECT name FROM interests'), db)).toBe('47 rows, more than 8');
    expect(checkProblem(bounded, answer('SELECT i.name FROM interests i, technologies t'), db)).toBe('51 or more rows, more than 8');
  });

  it('bounds only SQL answers', () => {
    expect(checkProblem({ question: 'x', expect: 'either', maxRows: 1 }, { status: 200, body: { sql: '', explanation: 'x', cached: false } }, db)).toBeNull();
  });
});

describe('the questions on answering at the right level', () => {
  it('lets a correct answer to each pass', () => {
    const interests = 'SELECT area, COUNT(*) AS interests FROM interests GROUP BY area ORDER BY MIN(id)';
    const technologies = 'SELECT skill_area, COUNT(*) AS technologies FROM technologies GROUP BY skill_area';
    const uses = 'SELECT section, COUNT(*) AS items FROM uses GROUP BY section ORDER BY MIN(position)';
    for (const question of ["What are Alex's hobbies?", 'What does Alex do for fun?', 'What is Alex into?']) expect(check(question, interests), question).toBeNull();
    for (const question of ['What technologies does Alex know?', 'Which technologies has Alex used?', 'What technologies is Alex familiar with?']) {
      expect(check(question, technologies), question).toBeNull();
    }
    for (const question of ['What does Alex use?', 'Tell me about the things Alex uses.', 'What does Alex use for work and play?']) expect(check(question, uses), question).toBeNull();
    // Leaving out Learning is a fair reading of a question about what is in use.
    expect(check('What does Alex use?', "SELECT section, COUNT(*) AS items FROM uses WHERE section <> 'Learning' GROUP BY section")).toBeNull();
    expect(check('What games does Alex play?', "SELECT category, name, note FROM interests WHERE area = 'Games' ORDER BY id")).toBeNull();
    expect(check('What games does Alex play?', "SELECT name, note FROM interests WHERE category = 'video game'")).toBeNull();
    expect(check('Which board games does Alex like?', "SELECT name, note FROM interests WHERE category = 'board game'")).toBeNull();
    expect(check('Which frontend technologies does Alex know?', "SELECT name, category FROM technologies WHERE skill_area = 'Frontend'")).toBeNull();
    expect(check('What peripherals does Alex use?', "SELECT item, details FROM uses WHERE section = 'Peripherals' ORDER BY position")).toBeNull();
    expect(check('What peripherals does Alex use?', "SELECT details FROM uses WHERE section = 'Peripherals'")).toBeNull();
    expect(check('List every technology in the database.', 'SELECT name, skill_area FROM technologies ORDER BY name')).toBeNull();
    expect(check('What facts does the site have about Alex?', 'SELECT key, value FROM facts')).toBeNull();
  });

  it('fails the wrong reading of each kind', () => {
    expect(check("What are Alex's hobbies?", 'SELECT category, name FROM interests')).toBe('47 rows, more than 8');
    expect(check("What are Alex's hobbies?", 'SELECT category, COUNT(*) AS interests FROM interests GROUP BY category')).toBe('16 rows, more than 8');
    expect(check("What are Alex's hobbies?", "SELECT area, GROUP_CONCAT(name, ', ') AS names FROM interests GROUP BY area")).toBe('rows contain "Counter-Strike"');
    expect(check('What technologies does Alex know?', 'SELECT skill_area, name FROM technologies WHERE core = 1')).toMatch(/^rows lack/);
    expect(check('What games does Alex play?', "SELECT COUNT(*) AS games FROM interests WHERE area = 'Games'")).toBe('1 row, fewer than 4');
    expect(check('What games does Alex play?', 'SELECT name FROM interests')).toBe('rows contain "Judo"');
    expect(check('Which frontend technologies does Alex know?', "SELECT skill_area, COUNT(*) AS technologies FROM technologies WHERE skill_area = 'Frontend' GROUP BY skill_area")).toBe(
      '1 row, fewer than 6',
    );
    expect(check('What peripherals does Alex use?', 'SELECT item, details FROM uses')).toBe('rows contain "Main PC", "MacBook"');
    expect(check('What facts does the site have about Alex?', "SELECT key, value FROM facts WHERE key IN ('location', 'status', 'available_from')")).toBe(
      '3 rows, fewer than 10',
    );
  });

  it('asks each table with a broad column at least three broad ways, naming its groups', () => {
    for (const [table, column] of [
      ['interests', 'area'],
      ['technologies', 'skill_area'],
      ['uses', 'section'],
    ]) {
      const groups: readonly (string | number)[] = schema.tables.find((candidate) => candidate.name === table)!.columns.find((candidate) => candidate.name === column)!.values!;
      const broad = questions.filter((candidate) => candidate.maxRows !== undefined && candidate.maxRows > 1 && (candidate.mustInclude ?? []).every((name) => groups.includes(name)));
      expect(broad.length, table).toBeGreaterThanOrEqual(3);
      for (const candidate of broad) {
        expect(candidate.mustInclude!.length, candidate.question).toBeGreaterThanOrEqual(groups.length - 1);
        expect(candidate.maxRows, candidate.question).toBeLessThanOrEqual(8);
        expect(candidate.mustExclude?.length, candidate.question).toBeGreaterThan(0);
      }
    }
  });

  it('sets bounds that can hold, and asks each question once', () => {
    for (const candidate of questions) {
      if (candidate.minRows === undefined && candidate.maxRows === undefined) continue;
      expect(candidate.expect, candidate.question).toBe('sql');
      if (candidate.minRows !== undefined) expect(candidate.minRows, candidate.question).toBeLessThanOrEqual(50);
      if (candidate.minRows !== undefined && candidate.maxRows !== undefined) expect(candidate.minRows).toBeLessThanOrEqual(candidate.maxRows);
    }
    expect(new Set(questions.map((candidate) => candidate.question)).size).toBe(questions.length);
  });
});
