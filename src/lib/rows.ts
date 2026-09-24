// Turns validated content entries into the rows of the database's tables. Used by
// scripts/build-db.ts to write the database and by the /api/*.json endpoints, so both see the same
// ids and order.
import type { z } from 'astro/zod';
import type {
  CourseContent,
  ExperienceContent,
  FactContent,
  PetContent,
  ProjectContent,
  TechnologyContent,
  TimelineContent,
  courseRow,
  experienceRow,
  factRow,
  petRow,
  projectRow,
  projectTechnologyRow,
  technologyRow,
  timelineRow,
} from '../content/schemas.ts';

export interface Entry<T> {
  id: string;
  data: T;
}

export type FactRow = z.infer<typeof factRow>;
export type ProjectRow = z.infer<typeof projectRow>;
export type TechnologyRow = z.infer<typeof technologyRow>;
export type ProjectTechnologyRow = z.infer<typeof projectTechnologyRow>;
export type CourseRow = z.infer<typeof courseRow>;
export type TimelineRow = z.infer<typeof timelineRow>;
export type PetRow = z.infer<typeof petRow>;
export type ExperienceRow = z.infer<typeof experienceRow>;

// Inside Astro, reference() turns each technology id into { collection, id } and image() turns
// each screenshot src into ImageMetadata; plain Node keeps the strings. Both shapes fit here.
export type TechnologyRef = string | { id: string };
export type ProjectInput = Omit<ProjectContent, 'technologies' | 'screenshots'> & {
  technologies: readonly TechnologyRef[];
  screenshots: readonly unknown[];
};

// Code-unit comparison, so the order does not depend on the ICU data of the machine that builds.
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rejectRepeats<T>(rows: T[], key: (row: T) => string | number, what: string): void {
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    if (previous && key(previous) === key(row)) {
      throw new Error(`${what} ${key(row)} appears twice`);
    }
  });
}

export function factRows(entries: Entry<FactContent>[]): FactRow[] {
  return [...entries]
    .sort((a, b) => compare(a.id, b.id))
    .map((entry) => ({ key: entry.id, value: entry.data.value, description: entry.data.description }));
}

export function projectRows(entries: Entry<ProjectInput>[]): ProjectRow[] {
  const sorted = [...entries].sort((a, b) => a.data.order - b.data.order);
  rejectRepeats(sorted, (entry) => entry.data.order, 'project order');
  // Only the project listed first is featured, so the flag can never disagree with the order.
  return sorted.map(({ id, data }, index) => {
    const { order, card, team, technologies, screenshots, ...row } = data;
    return { id: order, slug: id, ...row, featured: index === 0 ? 1 : 0 };
  });
}

export function technologyRows(entries: Entry<TechnologyContent>[]): TechnologyRow[] {
  const sorted = [...entries].sort(
    (a, b) =>
      compare(a.data.name.toLowerCase(), b.data.name.toLowerCase()) || compare(a.data.name, b.data.name),
  );
  rejectRepeats(sorted, (entry) => entry.data.name, 'technology name');
  return sorted.map((entry, index) => ({ id: index + 1, name: entry.data.name, category: entry.data.category }));
}

export function projectTechnologyRows(
  projects: Entry<ProjectInput>[],
  technologies: Entry<TechnologyContent>[],
): ProjectTechnologyRow[] {
  const nameById = new Map(technologies.map((entry) => [entry.id, entry.data.name]));
  const idByName = new Map(technologyRows(technologies).map((row) => [row.name, row.id]));
  const rows: ProjectTechnologyRow[] = [];
  for (const project of projectRows(projects)) {
    const entry = projects.find((candidate) => candidate.id === project.slug);
    const ids = new Set<number>();
    for (const ref of entry?.data.technologies ?? []) {
      const key = typeof ref === 'string' ? ref : ref.id;
      const name = nameById.get(key);
      const technologyId = name === undefined ? undefined : idByName.get(name);
      if (technologyId === undefined) {
        throw new Error(`project ${project.slug} names unknown technology ${key}`);
      }
      ids.add(technologyId);
    }
    for (const technologyId of [...ids].sort((a, b) => a - b)) {
      rows.push({ project_id: project.id, technology_id: technologyId });
    }
  }
  return rows;
}

export function courseRows(entries: Entry<CourseContent>[]): CourseRow[] {
  return entries
    .map(({ data }) => ({ code: data.code, name: data.name, term: data.term, topics: data.topics }))
    .sort((a, b) => compare(a.code, b.code));
}

export function timelineRows(entries: Entry<TimelineContent>[]): TimelineRow[] {
  return entries
    .map(({ data }) => ({ date: data.date, kind: data.kind, event: data.event }))
    .sort((a, b) => compare(a.date, b.date) || compare(a.event, b.event))
    .map((data, index) => ({ id: index + 1, ...data }));
}

export function petRows(entries: Entry<PetContent>[]): PetRow[] {
  return entries
    .map(({ data: { id, ...row } }) => row)
    .sort((a, b) => compare(a.name, b.name));
}

// Oldest first, as the timeline is. The resume's bullets are stored one per line, so each one
// can be read back as it was written.
export function experienceRows(entries: Entry<ExperienceContent>[]): ExperienceRow[] {
  return entries
    .map(({ data: { id, highlights, ...row } }) => ({ ...row, highlights: highlights.join('\n') }))
    .sort((a, b) => compare(a.start, b.start) || compare(a.title, b.title))
    .map((row, index) => ({ id: index + 1, ...row }));
}
