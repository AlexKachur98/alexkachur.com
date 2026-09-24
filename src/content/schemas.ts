// One source for the row shapes and their descriptions. Imported by src/content.config.ts
// (Astro validates the content files) and by scripts/build-db.ts (plain Node writes the
// database, schema.json and the DDL), so the two cannot drift.
import { z } from 'astro/zod';

const flag = z.literal([0, 1]);

export const projectKinds = ['client', 'team', 'course', 'personal'] as const;
export const technologyCategories = [
  'language',
  'framework',
  'library',
  'runtime',
  'database',
  'ai',
  'service',
  'testing',
  'tooling',
  'platform',
] as const;
export const timelineKinds = ['work', 'education', 'project', 'life'] as const;
// In the order Alex listed the areas.
export const skillAreas = [
  'Languages',
  'Frontend',
  'Backend',
  'Data',
  'LLM integration',
  'Testing',
  'Platforms and services',
] as const;

export const factRow = z.object({
  key: z.string().describe('Fact name, for example location or available_from'),
  value: z.string().describe('The fact as text'),
  description: z.string().describe('What the key means'),
});

export const projectRow = z.object({
  id: z.number().int().describe('Position in the site order, 1 first'),
  slug: z.string().describe('URL slug of the case-study page under /work/'),
  name: z.string().describe('Project name'),
  kind: z.enum(projectKinds).describe('client, team, course or personal'),
  summary: z.string().describe('One-line summary'),
  role: z.string().describe("Alex's role on the project"),
  year_start: z.number().int().describe('Year the work started'),
  year_end: z.number().int().nullable().describe('Year the work ended, NULL if ongoing'),
  client_name: z.string().nullable().describe('Client name for client work, else NULL'),
  live_url: z.string().nullable().describe('URL of the live site or demo, else NULL'),
  repo_url: z.string().nullable().describe('URL of the public repository, else NULL'),
  has_live_demo: flag.describe('1 if something is live to look at'),
  uses_llm: flag.describe('1 if a language model does work inside the project'),
  llm_job: z.string().nullable().describe('What the language model does, NULL when uses_llm is 0'),
  paid: flag.describe('1 if the work was paid'),
  featured: flag.describe('1 for the project listed first on the home page, else 0'),
});

export const technologyRow = z.object({
  id: z.number().int().describe('Position in case-insensitive name order, 1 first'),
  name: z.string().describe('Canonical, unversioned name, for example React'),
  category: z.enum(technologyCategories).describe(technologyCategories.join(', ')),
  core: flag.describe('Skills Alex considers core, each backed by a project on this site'),
  skill_area: z.enum(skillAreas).describe(`${skillAreas.slice(0, -1).join(', ')}, or ${skillAreas.at(-1)}`),
});

export const projectTechnologyRow = z.object({
  project_id: z.number().int().describe('projects.id'),
  technology_id: z.number().int().describe('technologies.id'),
});

export const courseRow = z.object({
  code: z.string().describe('Course code, for example COMP 307'),
  name: z.string().describe('Course name'),
  term: z.string().describe('Term, for example Fall 2026'),
  topics: z.string().nullable().describe('Topics covered, NULL until filled in'),
});

export const timelineRow = z.object({
  id: z.number().int().describe('Position in date order, 1 first'),
  date: z.string().describe('YYYY-MM, or YYYY when the month is not known'),
  kind: z.enum(timelineKinds).describe('work, education, project or life'),
  event: z.string().describe('What happened'),
});

// YYYY-MM, or YYYY when the resume gives only the year.
const yearMonth = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/);

export const experienceRow = z.object({
  id: z.number().int().describe('Position in start-date order, 1 first'),
  title: z.string().describe('Job title'),
  organization: z.string().describe('Who Alex worked for'),
  location: z.string().describe('Where the job was'),
  start: yearMonth.describe('YYYY-MM, or YYYY when the month is not known'),
  end: yearMonth.nullable().describe('The same form as start, NULL if current'),
  summary: z.string().describe('One line on the job, as on the plain-text resume'),
  highlights: z.string().describe('What Alex did there, word for word from his resume, one per line'),
});

export const petRow = z.object({
  name: z.string().describe('The cat'),
  species: z.string().describe('Always cat so far'),
  breed: z.string().describe('Breed'),
  born: z.number().int().describe('Birth year; age is derived from it'),
  personality: z.string().describe("Alex's description"),
  photo_url: z.string().describe('Path of a 480 by 480 photo on this site'),
  photo_alt: z.string().describe('Alt text for that photo'),
});

// Everything the DDL needs beyond the column types: table order, keys and uniqueness.
export const tables = {
  facts: {
    row: factRow,
    description: 'Single facts about Alex, one per row',
    primaryKey: ['key'],
    unique: [],
  },
  projects: {
    row: projectRow,
    description: 'The projects on this site, in site order',
    primaryKey: ['id'],
    unique: ['slug'],
  },
  technologies: {
    row: technologyRow,
    description: 'Languages, frameworks, libraries and services Alex has used',
    primaryKey: ['id'],
    unique: ['name'],
  },
  project_technologies: {
    row: projectTechnologyRow,
    description: 'Which technology was used on which project',
    primaryKey: ['project_id', 'technology_id'],
    unique: [],
  },
  courses: {
    row: courseRow,
    description: 'Courses Alex is taking at Centennial College',
    primaryKey: ['code'],
    unique: [],
  },
  timeline: {
    row: timelineRow,
    description: 'Work, education and project events by date',
    primaryKey: ['id'],
    unique: [],
  },
  pets: {
    row: petRow,
    description: 'The cats Alex lives with',
    primaryKey: ['name'],
    unique: [],
  },
  experience: {
    row: experienceRow,
    description: 'Jobs and roles Alex has held',
    primaryKey: ['id'],
    unique: [],
  },
} as const satisfies Record<
  string,
  { row: z.ZodObject; description: string; primaryKey: readonly string[]; unique: readonly string[] }
>;

export type TableName = keyof typeof tables;

// Content shapes: what the files under src/content hold, strict so a misspelled key fails the
// build. Values the build derives (projects.id and projects.featured from order, technologies.id
// from name order, timeline.id from date order) are not in the files; the file loader's id is the
// natural key.

const contentId = z.string().describe('Id of this row in its file');

export const screenshot = z.strictObject({
  src: z.string().describe('Path of the screenshot, relative to the project file'),
  alt: z.string().describe('What the screenshot shows'),
  caption: z.string().optional().describe('Caption under the screenshot'),
});

export const projectContent = z.strictObject({
  ...projectRow.omit({ id: true, slug: true, featured: true }).shape,
  order: z.number().int().positive().describe('Site order; also drives projects.id'),
  card: z.string().describe('The one-liner under the name on the home page'),
  team: z.string().optional().describe('Team line for the facts strip, for team projects'),
  technologies: z.array(z.string()).describe('Ids from technologies.yaml used on this project'),
  screenshots: z.array(screenshot).describe('Real screenshots, in display order'),
});

export const technologyContent = z.strictObject({ id: contentId, ...technologyRow.omit({ id: true }).shape });
export const courseContent = z.strictObject({ id: contentId, ...courseRow.shape });
export const timelineContent = z.strictObject({ id: contentId, ...timelineRow.omit({ id: true }).shape });
export const petContent = z.strictObject({ id: contentId, ...petRow.shape });
export const factContent = z.strictObject({ id: contentId, ...factRow.omit({ key: true }).shape });
export const experienceContent = z.strictObject({
  id: contentId,
  ...experienceRow.omit({ id: true, highlights: true }).shape,
  highlights: z.array(z.string().min(1)).min(1).describe('The resume bullets, word for word'),
});

export const pageContent = z.strictObject({
  updated: z.date().optional().describe('Last-updated date shown at the top of the page'),
});

export type FactContent = z.infer<typeof factContent>;
export type ProjectContent = z.infer<typeof projectContent>;
export type TechnologyContent = z.infer<typeof technologyContent>;
export type CourseContent = z.infer<typeof courseContent>;
export type TimelineContent = z.infer<typeof timelineContent>;
export type PetContent = z.infer<typeof petContent>;
export type ExperienceContent = z.infer<typeof experienceContent>;
