import { readFileSync } from 'node:fs';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';
import { queryOf, resumeData, resumeText } from '../src/lib/resume.ts';
import { siteOrigin } from '../src/lib/site.ts';

// npm test builds first (pretest), so public/resume.txt and the database are the current ones.
const SQL = await initSqlJs();
const query = queryOf(new SQL.Database(readFileSync('public/data/portfolio.sqlite')));
const data = resumeData(query);
const file = readFileSync('public/resume.txt', 'utf8');
const lines = file.replace(/\n$/, '').split('\n');

describe('the plain-text resume', () => {
  it('is what the database gives, nothing typed', () => {
    expect(file).toBe(resumeText(data, siteOrigin()));
    expect(file.endsWith('\n') && !file.endsWith('\n\n')).toBe(true);
  });

  it('fits an 80-column terminal, all but the contact line, which stays under 100', () => {
    const contact = lines[2]!;
    expect(contact).toContain(data.facts.email!);
    expect(contact.length).toBeLessThan(100);
    for (const [index, line] of lines.entries()) if (index !== 2) expect(line.length, line).toBeLessThanOrEqual(80);
  });

  it('keeps every entry in the 17-character label column, a bullet running on two further in', () => {
    const body = lines.filter((line) => /^ /.test(line));
    for (const line of body) expect(line, line).toMatch(/^ {17}(?: {2})?\S/);
    for (const heading of ['WORK', 'PROJECTS', 'SKILLS']) expect(lines).toContain(heading);
  });

  it('carries only numbers that its database rows hold', () => {
    const rows = [
      ...query('SELECT value FROM facts'),
      ...query('SELECT title, organization, start, end, summary, highlights FROM experience'),
      ...query('SELECT highlights FROM projects WHERE highlights IS NOT NULL'),
      ...query('SELECT name FROM technologies'),
    ];
    const source = `${JSON.stringify(rows)} ${siteOrigin()}`;
    for (const number of file.match(/\d+/g) ?? []) expect(source, number).toContain(number);
  });

  it('keeps every number an experience summary gives in that job highlights too', () => {
    for (const job of data.work) {
      for (const number of job.summary.match(/\d+\+?%?/g) ?? []) expect(job.highlights.join(' '), `${job.title}: ${number}`).toContain(number);
    }
  });
});
