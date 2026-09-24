import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import schema from '@jsonresume/schema/schema.json' with { type: 'json' };
import sample from '@jsonresume/schema/sample.resume.json' with { type: 'json' };
import { Ajv } from 'ajv';
import addFormats from 'ajv-formats';
import initSqlJs from 'sql.js';
import { describe, expect, it } from 'vitest';

// npm test builds first (pretest), so the built endpoint and database are the current ones.
const root = 'dist/client';
const resume = JSON.parse(readFileSync(join(root, 'api', 'resume.json'), 'utf8'));
const SQL = await initSqlJs();
const db = new SQL.Database(readFileSync(join(root, 'data', 'portfolio.sqlite')));
const column = (sql: string) => (db.exec(sql)[0]?.values ?? []).map(([value]) => value);

// The official schema in strict mode, formats checked, as JSON Resume's own compliance test runs it.
const ajv = new Ajv({ strict: true, allErrors: true });
addFormats(ajv);
const validate = ajv.compile(schema);
const errors = (value: unknown) => (validate(value) ? '' : ajv.errorsText(validate.errors));

describe('/api/resume.json', () => {
  it('is a valid JSON Resume', () => {
    expect(errors(resume)).toBe('');
  });

  it('fails the same check when a date is not a date, so the check can fail', () => {
    expect(errors(sample)).toBe('');
    const broken = structuredClone(resume);
    broken.work[0].startDate = 'Present';
    expect(errors(broken)).toMatch(/startDate/);
  });

  // The schema requires nothing, so an empty document would pass; every section must be there.
  it('fills the seven sections the site has data for', () => {
    for (const section of ['basics', 'work', 'education', 'skills', 'languages', 'projects', 'interests']) {
      expect(resume[section], section).toBeTruthy();
      if (Array.isArray(resume[section])) expect(resume[section].length, section).toBeGreaterThan(0);
    }
    expect(resume.languages.map((entry: { language: string }) => entry.language)).toEqual(['English', 'Russian', 'Hebrew']);
  });

  it('gives the highlights the database holds, word for word', () => {
    const work = column('SELECT highlights FROM experience ORDER BY start DESC').map((value) => String(value).split('\n'));
    expect(resume.work.map((job: { highlights: string[] }) => job.highlights)).toEqual(work);
    const projects = column('SELECT highlights FROM projects WHERE highlights IS NOT NULL ORDER BY id').map((value) => String(value).split('\n'));
    expect(resume.projects.map((project: { highlights: string[] }) => project.highlights)).toEqual(projects);
  });
});
