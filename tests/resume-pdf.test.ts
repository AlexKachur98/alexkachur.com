import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { extractText, getDocumentProxy } from 'unpdf';
import { describe, expect, it } from 'vitest';
import { countIn } from '../src/lib/numbers.ts';
import { monthYear } from '../src/lib/resume.ts';
import { questions } from '../scripts/eval/questions.ts';

// The PDF is exported by hand from portfolio-materials/Alex-Kachur-Resume.docx, so this test holds
// it to the database: every claim the site makes about Alex that the PDF repeats must read the same.
const fix = 'Change it in portfolio-materials/Alex-Kachur-Resume.docx, export the PDF again and replace public/Alex-Kachur-Resume.pdf.';

const pdf = await getDocumentProxy(new Uint8Array(readFileSync('public/Alex-Kachur-Resume.pdf')));
const extracted = (await extractText(pdf, { mergePages: true })).text;
// Bullets and the middle dot gone (with the private-use bullet a Symbol-font list gives), forms
// folded, whitespace collapsed.
const marks = new RegExp(`[${[0x2022, 0xb7, 0xf0b7, 0xfffd].map((code) => String.fromCharCode(code)).join('')}]`, 'g');
const text = extracted.replace(marks, ' ').normalize('NFKC').replace(/\s+/g, ' ').trim();
// Phrase checks ignore case and punctuation, keeping + and % for counts like 50+ and 15%.
const loose = (phrase: string) => phrase.normalize('NFKC').toLowerCase().replace(/[^a-z0-9+%]+/g, ' ').trim();
const looseText = ` ${loose(text)} `;

function has(phrase: string, what: string): void {
  expect(looseText.includes(` ${loose(phrase)} `), `${what}: "${phrase}" is not in the PDF. ${fix}`).toBe(true);
}

const SQL = await initSqlJs();
const db = new SQL.Database(readFileSync('public/data/portfolio.sqlite'));
const rows = (sql: string) => {
  const result = db.exec(sql)[0];
  return (result?.values ?? []).map((row) => Object.fromEntries(result!.columns.map((name, index) => [name, row[index] as string])));
};
const facts = Object.fromEntries(rows('SELECT key, value FROM facts').map((row) => [row.key, row.value]));

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "Jan 2022" as 2022-01, "2026" as 2026: the form the database keeps.
const yearMonth = (month: string | undefined, year: string) => (month ? `${year}-${String(months.indexOf(month) + 1).padStart(2, '0')}` : year);
const short = (date: string) => (date.length === 4 ? date : `${months[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`);

describe('the resume PDF', () => {
  it('names the role and the dates of every job the experience table holds', () => {
    has(facts.role!, 'role');
    for (const job of rows('SELECT title, start, end FROM experience')) {
      const escaped = job.title!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = new RegExp(`${escaped} (?:(?:([A-Z][a-z]{2}) )?(\\d{4}) to (?:(?:([A-Z][a-z]{2}) )?(\\d{4})|present)|since ([A-Z][a-z]{2}) (\\d{4}))`).exec(text);
      expect(match, `${job.title}: no dates after the title in the PDF. ${fix}`).not.toBeNull();
      const start = match![2] ? yearMonth(match![1], match![2]) : yearMonth(match![5], match![6]!);
      const end = match![4] ? yearMonth(match![3], match![4]) : null;
      expect({ start, end }, `${job.title}: the PDF's dates. ${fix}`).toEqual({ start: job.start, end: job.end });
    }
  });

  it('carries every experience and project highlight word for word', () => {
    for (const row of rows('SELECT title, highlights FROM experience')) {
      for (const highlight of row.highlights!.split('\n')) has(highlight, row.title!);
    }
    for (const row of rows('SELECT name, highlights FROM projects WHERE highlights IS NOT NULL')) {
      for (const highlight of row.highlights!.split('\n')) has(highlight, row.name!);
    }
  });

  it('gives the GPA, the languages, the core skills and the month Alex is available from', () => {
    has(facts.gpa!, 'gpa');
    has(facts.languages_spoken!, 'languages_spoken');
    for (const { name } of rows('SELECT name FROM technologies WHERE core = 1')) has(name!, 'core skill');
    has(`Available full-time from ${monthYear(facts.available_from!)}`, 'available_from');
  });

  it('dates the program and the SplitRoof project as the timeline does, and names its course', () => {
    const education = rows("SELECT date FROM timeline WHERE kind = 'education' ORDER BY date").map((row) => row.date!);
    has(`${short(education[0]!)} to ${short(education.at(-1)!)}`, 'education dates');
    const splitroof = rows("SELECT date FROM timeline WHERE event LIKE 'SplitRoof%'")[0]!.date!;
    has(`SplitRoof AI assistant ${short(splitroof)}`, 'SplitRoof start');
    has('COMP 231', 'SplitRoof course');
    const about = rows("SELECT body FROM sections WHERE page = '/#about'")[0]!.body!;
    has(`since ${/since (\d{4})/.exec(about)![1]}`, 'the year from About');
  });

  // A text extractor reads a wide gap between letters as a space, so tracked capitals can come out
  // as "S K I L L S"; the name and the four headings must each come out as one line of their own.
  it('reads the name and each section heading as whole words, on one tagged page with a title', async () => {
    const lines = extracted.split('\n').map((line) => line.trim());
    for (const heading of ['ALEX KACHUR', 'SKILLS', 'EXPERIENCE', 'PROJECTS', 'EDUCATION']) {
      expect(lines, `the line "${heading}". ${fix}`).toContain(heading);
    }
    expect(lines.filter((line) => /\b(?:[A-Z] ){2,}[A-Z]\b/.test(line)), `letters read as separate words: the name takes at most 1 pt of extra letter spacing and the headings 0.5 pt. ${fix}`).toEqual([]);
    expect(pdf.numPages).toBe(1);
    // Any English tag will do: Word writes the one its proofing language gives, such as en-CA.
    expect((await pdf.getMetadata()).info).toMatchObject({ Title: 'Alex Kachur, Resume', Language: expect.stringMatching(/^en\b/) });
    expect(await pdf.getMarkInfo()).toMatchObject({ Marked: true });
  });

  // The same two numbers the highlights carry, checked on their own so a stale PDF says which.
  it('counts the eval questions and the SplitRoof tests as the site does', () => {
    expect(Number(/(\d+)-question/.exec(text)?.[1]), `the PDF's eval question count. ${fix}`).toBe(questions.length);
    const decisions = rows("SELECT body FROM sections WHERE page = '/work/splitroof-ai-assistant'").map((row) => row.body).join('\n');
    const tools = countIn(decisions, /(\w+) Jest tests before the model/g, 'the SplitRoof case study');
    expect(Number(/(\d+) passing Jest tests/.exec(text)?.[1]), `the PDF's SplitRoof test count. ${fix}`).toBe(tools);
  });
});
