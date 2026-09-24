// Turns validated content entries into the rows of the database's tables. Used by
// scripts/build-db.ts to write the database and by the /api/*.json endpoints, so both see the same
// ids and order.
import type { z } from 'astro/zod';
import type {
  CourseContent,
  ExperienceContent,
  FactContent,
  InterestContent,
  PetContent,
  ProjectContent,
  TechnologyContent,
  TimelineContent,
  courseRow,
  experienceRow,
  factRow,
  interestRow,
  pageImageRow,
  petRow,
  projectImageRow,
  projectRow,
  projectTechnologyRow,
  sectionRow,
  technologyRow,
  timelineRow,
  UsesContent,
  usesRow,
} from '../content/schemas.ts';
import { blockText } from './page-text.ts';
import { splitSections } from './sections.ts';

export interface Entry<T> {
  id: string;
  data: T;
}

export type FactRow = z.infer<typeof factRow>;
export type ProjectRow = z.infer<typeof projectRow>;
export type TechnologyRow = z.infer<typeof technologyRow>;
export type ProjectTechnologyRow = z.infer<typeof projectTechnologyRow>;
export type ProjectImageRow = z.infer<typeof projectImageRow>;
export type CourseRow = z.infer<typeof courseRow>;
export type TimelineRow = z.infer<typeof timelineRow>;
export type PetRow = z.infer<typeof petRow>;
export type ExperienceRow = z.infer<typeof experienceRow>;
export type InterestRow = z.infer<typeof interestRow>;
export type UsesRow = z.infer<typeof usesRow>;
export type SectionRow = z.infer<typeof sectionRow>;
export type PageImageRow = z.infer<typeof pageImageRow>;

// Inside Astro, reference() turns each technology id into { collection, id } and image() turns
// each screenshot src into ImageMetadata; plain Node keeps the strings. Both shapes fit here.
export type TechnologyRef = string | { id: string };
export type ProjectInput = Omit<ProjectContent, 'technologies' | 'screenshots'> & {
  technologies: readonly TechnologyRef[];
  screenshots: readonly { alt: string; caption?: string | undefined }[];
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
    const { order, card, team, highlights, technologies, screenshots, ...row } = data;
    return { id: order, slug: id, ...row, featured: index === 0 ? 1 : 0, card, team: team ?? null, highlights: highlights?.join('\n') ?? null };
  });
}

// Each case study's screenshots in the order the page shows them.
export function projectImageRows(entries: Entry<ProjectInput>[]): ProjectImageRow[] {
  return [...entries]
    .sort((a, b) => a.data.order - b.data.order)
    .flatMap(({ data }) =>
      data.screenshots.map((shot, index) => ({ project_id: data.order, position: index + 1, alt: shot.alt, caption: shot.caption ?? null })),
    );
}

export function technologyRows(entries: Entry<TechnologyContent>[]): TechnologyRow[] {
  const sorted = [...entries].sort(
    (a, b) =>
      compare(a.data.name.toLowerCase(), b.data.name.toLowerCase()) || compare(a.data.name, b.data.name),
  );
  rejectRepeats(sorted, (entry) => entry.data.name, 'technology name');
  return sorted.map((entry, index) => ({
    id: index + 1,
    name: entry.data.name,
    category: entry.data.category,
    core: entry.data.core,
    skill_area: entry.data.skill_area,
  }));
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

// In the order Alex listed them, which is the file's order.
export function interestRows(entries: Entry<InterestContent>[]): InterestRow[] {
  return entries.map(({ data: { id, ...row } }, index) => ({ id: index + 1, ...row }));
}

// In the order Alex listed them, which is the file's order and the page's.
export function usesRows(entries: Entry<UsesContent>[]): UsesRow[] {
  return entries.map(({ data: { id, ...row } }, index) => ({ position: index + 1, ...row }));
}

// A page's rendered markdown as the sections table stores it. A page with no h2 of its own (About,
// Now, the 404) is one section under its title; a section whose text renders to nothing is left
// out, as the page leaves it out.
export interface PageText {
  page: string;
  title?: string | undefined;
  html: string;
}

export function sectionRows(pages: readonly PageText[]): SectionRow[] {
  return pages.flatMap(({ page, title, html }) =>
    splitSections(html, { lead: title })
      .map((section) => ({ heading: section.title, body: blockText(section.body) }))
      .filter((section) => section.body !== '')
      .map((section, index) => ({ page, position: index + 1, ...section })),
  );
}

export interface PagePhotos {
  page: string;
  images: readonly { alt: string; caption?: string | undefined }[];
}

export function pageImageRows(pages: readonly PagePhotos[]): PageImageRow[] {
  return pages.flatMap(({ page, images }) =>
    images.map((image, index) => ({ page, position: index + 1, alt: image.alt, caption: image.caption ?? null })),
  );
}
