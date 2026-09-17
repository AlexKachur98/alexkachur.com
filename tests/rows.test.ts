import { describe, expect, it } from 'vitest';
import {
  courseRows,
  factRows,
  petRows,
  projectRows,
  projectTechnologyRows,
  technologyRows,
  timelineRows,
} from '../src/lib/rows.ts';
import type { Entry, ProjectInput, TechnologyRef } from '../src/lib/rows.ts';
import type { TechnologyContent } from '../src/content/schemas.ts';

function project(id: string, order: number, technologies: TechnologyRef[]): Entry<ProjectInput> {
  return {
    id,
    data: {
      order,
      name: id,
      kind: 'personal',
      summary: '',
      card: '',
      role: '',
      year_start: 2026,
      year_end: null,
      client_name: null,
      live_url: null,
      repo_url: null,
      has_live_demo: 0,
      uses_llm: 0,
      llm_job: null,
      paid: 0,
      featured: 0,
      technologies,
      screenshots: [],
    },
  };
}

function technology(id: string, name: string): Entry<TechnologyContent> {
  return { id, data: { id, name, category: 'library' } };
}

const technologies = [technology('sql-js', 'sql.js'), technology('react', 'React'), technology('astro', 'Astro')];

describe('rows', () => {
  it('numbers projects by order and takes the slug from the entry id', () => {
    const rows = projectRows([project('b', 2, []), project('a', 1, [])]);
    expect(rows.map((row) => [row.id, row.slug])).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(Object.keys(rows[0]!)).not.toContain('order');
    expect(Object.keys(rows[0]!)).not.toContain('technologies');
  });

  it('rejects two projects with the same order', () => {
    expect(() => projectRows([project('a', 1, []), project('b', 1, [])])).toThrow(/project order 1 appears twice/);
  });

  it('numbers technologies in case-insensitive name order, upper case first on a tie', () => {
    const rows = technologyRows([...technologies, technology('sql', 'SQL'), technology('sql-lower', 'sql')]);
    expect(rows.map((row) => `${row.id} ${row.name}`)).toEqual(['1 Astro', '2 React', '3 SQL', '4 sql', '5 sql.js']);
    expect(Object.keys(rows[0]!)).toEqual(['id', 'name', 'category']);
  });

  it('rejects two technologies with the same name', () => {
    expect(() => technologyRows([technology('a', 'React'), technology('b', 'React')])).toThrow(
      /technology name React appears twice/,
    );
  });

  it('links projects to technologies by id, once each, accepting Astro reference objects', () => {
    const projects = [
      project('a', 1, ['sql-js', 'react', 'react']),
      project('b', 2, [{ id: 'react' }, 'react']),
    ];
    expect(projectTechnologyRows(projects, technologies)).toEqual([
      { project_id: 1, technology_id: 2 },
      { project_id: 1, technology_id: 3 },
      { project_id: 2, technology_id: 2 },
    ]);
  });

  it('rejects an unknown technology id', () => {
    expect(() => projectTechnologyRows([project('a', 1, ['vue'])], technologies)).toThrow(/unknown technology vue/);
  });

  it('numbers the timeline by date then event', () => {
    const rows = timelineRows([
      { id: 'x', data: { id: 'x', date: '2026-09', kind: 'project', event: 'B' } },
      { id: 'y', data: { id: 'y', date: '2026', kind: 'project', event: 'Z' } },
      { id: 'z', data: { id: 'z', date: '2026-09', kind: 'work', event: 'A' } },
    ]);
    expect(rows.map((row) => `${row.id} ${row.date} ${row.event}`)).toEqual(['1 2026 Z', '2 2026-09 A', '3 2026-09 B']);
    expect(Object.keys(rows[0]!)).toEqual(['id', 'date', 'kind', 'event']);
  });

  it('sorts facts by key, courses by code and pets by name, without the file ids', () => {
    expect(
      factRows([
        { id: 'name', data: { id: 'name', value: 'n' } },
        { id: 'email', data: { id: 'email', value: 'e' } },
      ]),
    ).toEqual([
      { key: 'email', value: 'e' },
      { key: 'name', value: 'n' },
    ]);
    const course = { name: '', term: '', topics: null };
    const courses = courseRows([
      { id: 'b', data: { id: 'b', code: 'COMP 307', ...course } },
      { id: 'a', data: { id: 'a', code: 'COMP 231', ...course } },
    ]);
    expect(courses.map((row) => row.code)).toEqual(['COMP 231', 'COMP 307']);
    expect(Object.keys(courses[0]!)).not.toContain('id');
    const pet = { species: 'cat', breed: '', born: 2020, personality: '', photo_url: '', photo_alt: '' };
    const pets = petRows([
      { id: 'simba', data: { id: 'simba', name: 'Simba', ...pet } },
      { id: 'moura', data: { id: 'moura', name: 'Moura', ...pet } },
    ]);
    expect(pets.map((row) => row.name)).toEqual(['Moura', 'Simba']);
    expect(Object.keys(pets[0]!)).not.toContain('id');
  });
});
