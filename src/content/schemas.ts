// The row shapes and their descriptions, for src/content.config.ts, where Astro validates the
// content files, and for scripts/build-db.ts, which writes the database, schema.json and the DDL.
import { z } from 'astro/zod';

const flag = z.literal([0, 1]);

const projectKinds = ['client', 'team', 'course', 'personal'] as const;
const technologyCategories = [
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
const timelineKinds = ['work', 'education', 'project', 'life'] as const;
export const interestCategories = [
  'video game',
  'game genre',
  'playing now',
  'board game',
  'movie',
  'TV show',
  'watching now',
  'history topic',
  'reading now',
  'music genre',
  'music artist',
  'YouTube or podcast',
  'sport',
  'following',
  'travelled to',
  'wants to visit',
] as const;
// The skill areas, in display order.
export const skillAreas = [
  'Languages',
  'Frontend',
  'Backend',
  'Data',
  'LLM integration',
  'Testing',
  'Platforms and services',
] as const;
// The broad areas the interest categories fall under, in display order.
export const interestAreas = [
  'Games',
  'Movies and TV',
  'History and reading',
  'Music',
  'YouTube and podcasts',
  'Sports',
  'Travel',
] as const;

// The area of each category. The build fills interests.area from it, so the content file never
// repeats it, and a category left without an area fails the type check.
export const interestAreaOf: Readonly<Record<(typeof interestCategories)[number], (typeof interestAreas)[number]>> = {
  'video game': 'Games',
  'game genre': 'Games',
  'playing now': 'Games',
  'board game': 'Games',
  movie: 'Movies and TV',
  'TV show': 'Movies and TV',
  'watching now': 'Movies and TV',
  'history topic': 'History and reading',
  'reading now': 'History and reading',
  'music genre': 'Music',
  'music artist': 'Music',
  'YouTube or podcast': 'YouTube and podcasts',
  sport: 'Sports',
  following: 'Sports',
  'travelled to': 'Travel',
  'wants to visit': 'Travel',
};

// The drawings a home page row can show in place of a screenshot: the site's architecture and the
// SplitRoof flow, each a component of its own.
const diagrams = ['architecture', 'splitroof-flow'] as const;

export const factRow = z.object({
  key: z.string().describe('Fact name, for example location or available_from'),
  value: z.string().describe('The fact as text'),
  description: z.string().describe('What the key means'),
});

export const projectRow = z.object({
  id: z.number().int().describe('Position in the site order, 1 first'),
  slug: z.string().describe("The project's short name in URLs, for example uraz-hoops"),
  page: z.string().describe("The page on this site about the project: its case study under /work/, or the page that covers it instead"),
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
  card: z.string().describe("The one-liner under the name on the home page, also the case study's description"),
  team: z.string().nullable().describe('The team line on the case study, NULL unless a team project'),
  highlights: z
    .string()
    .nullable()
    .describe('Resume bullets for the project, one per line, NULL for client work; numbers in them are filled in at build time from their sources'),
  row_image: z
    .enum(['screenshot', ...diagrams])
    .describe("What the project's row on the home page shows: screenshot for its first screenshot, or the name of the drawing shown instead"),
  row_image_alt: z.string().nullable().describe('What the drawing shows, NULL when the row shows a screenshot'),
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

export const projectImageRow = z.object({
  project_id: z.number().int().describe('projects.id'),
  position: z.number().int().positive().describe('Order on the page, 1 first'),
  alt: z.string().describe('What the screenshot shows'),
  caption: z.string().nullable().describe('Caption under the screenshot, NULL until written'),
});

export const courseRow = z.object({
  code: z.string().describe('Course code, for example COMP 307'),
  name: z.string().describe('Course name'),
  term: z.string().describe('Term, for example Fall 2026'),
  topics: z.string().nullable().describe('Topics covered, NULL until filled in'),
});

// YYYY-MM, or YYYY when only the year is known.
const yearMonth = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/);

export const timelineRow = z.object({
  id: z.number().int().describe('Position in date order, 1 first'),
  date: yearMonth.describe('YYYY-MM, or YYYY when the month is not known'),
  kind: z.enum(timelineKinds).describe('work, education, project or life'),
  event: z.string().describe('What happened'),
});

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

export const interestRow = z.object({
  id: z.number().int().describe('Position in the list, 1 first'),
  category: z.enum(interestCategories).describe(`${interestCategories.slice(0, -1).join(', ')}, or ${interestCategories.at(-1)}`),
  area: z
    .enum(interestAreas)
    .describe(interestAreas.map((area) => `${area}: ${interestCategories.filter((category) => interestAreaOf[category] === area).join(', ')}`).join('; ')),
  name: z.string().describe('The game, show, team, place or other thing'),
  note: z.string().nullable().describe("Alex's note on it, NULL if none"),
});

const storageRow = z.object({
  item: z.string().describe('What is stored'),
  kept_for: z.string().describe('How long it is kept'),
  purpose: z.string().describe('Why'),
});

const usesSections = ['Machines', 'Peripherals', 'Software', 'Learning'] as const;

export const usesRow = z.object({
  position: z.number().int().positive().describe('Order on the page, 1 first'),
  section: z.enum(usesSections).describe('Machines, Peripherals, Software or Learning'),
  item: z.string().describe('What it is, for example Main PC'),
  details: z.string().describe('What Alex uses'),
});

export const sectionRow = z.object({
  page: z.string().describe("Where the text appears: /#about or /#now on the home page, /404, /uses, /how-this-site-works, or /work/ followed by a project's slug, such as /work/uraz-hoops"),
  position: z.number().int().positive().describe('Order on the page, 1 first'),
  heading: z.string().describe("The section's heading as the page shows it"),
  body: z.string().describe('The section\'s text as the page shows it; a blank line between paragraphs, list items starting with "- "'),
});

export const pageImageRow = z.object({
  page: z.string().describe('Where the photo appears, as in sections.page'),
  position: z.number().int().positive().describe('Order on the page, 1 first'),
  alt: z.string().describe('What the photo shows'),
  caption: z.string().nullable().describe('Caption under the photo, NULL if none'),
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
  project_images: {
    row: projectImageRow,
    description: 'The screenshots on each case study, in display order',
    primaryKey: ['project_id', 'position'],
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
  interests: {
    row: interestRow,
    description: "Alex's hobbies and favourites, in his words",
    primaryKey: ['id'],
    unique: [],
  },
  storage: {
    row: storageRow,
    description: 'What this site stores for a visitor or a question, how long, and why, from the constants the code uses',
    primaryKey: ['item'],
    unique: [],
  },
  uses: {
    row: usesRow,
    description: 'The machines, peripherals and software Alex uses, and what he is learning, as listed on /uses',
    primaryKey: ['position'],
    unique: [],
  },
  sections: {
    row: sectionRow,
    description: "The text of the site's pages and case studies, one row per section",
    primaryKey: ['page', 'position'],
    unique: [],
  },
  page_images: {
    row: pageImageRow,
    description: "The photos on the site's other pages",
    primaryKey: ['page', 'position'],
    unique: [],
  },
} as const satisfies Record<
  string,
  { row: z.ZodObject; description: string; primaryKey: readonly string[]; unique: readonly string[] }
>;

export type TableName = keyof typeof tables;

// Content shapes: what the files under src/content hold, strict so a misspelled key fails the
// build. Values the build derives (projects.id and projects.featured from order, technologies.id
// from name order, timeline.id from date order, interests.area from the category) are not in the
// files; the file loader's id is the natural key.

const contentId = z.string().describe('Id of this row in its file');

export const screenshot = z.strictObject({
  src: z.string().describe('Path of the screenshot, relative to the project file'),
  alt: z.string().describe('What the screenshot shows'),
  caption: z.string().optional().describe('Caption under the screenshot'),
});

const rowImage = z.strictObject({
  diagram: z.enum(diagrams).describe('The drawing the home page row shows in place of a screenshot'),
  alt: z.string().describe('What the drawing shows, in a sentence'),
});

export const projectContent = z.strictObject({
  ...projectRow.omit({ id: true, slug: true, page: true, featured: true, team: true, highlights: true, row_image: true, row_image_alt: true }).shape,
  order: z.number().int().positive().describe('Site order; also drives projects.id'),
  page: z.string().optional().describe('The page that covers the project when it has no case study of its own under /work/'),
  row_image: rowImage.optional().describe('A drawing for the home page row, when the project has no interface to show there'),
  team: z.string().optional().describe(projectRow.shape.team.description ?? ''),
  highlights: z.array(z.string().min(1)).min(1).optional().describe('The resume bullets, word for word, with each number written as {key}'),
  technologies: z.array(z.string()).describe('Ids from technologies.yaml used on this project'),
  screenshots: z.array(screenshot).describe('Real screenshots, in display order'),
});

export const technologyContent = z.strictObject({ id: contentId, ...technologyRow.omit({ id: true }).shape });
export const courseContent = z.strictObject({ id: contentId, ...courseRow.shape });
export const timelineContent = z.strictObject({ id: contentId, ...timelineRow.omit({ id: true }).shape });
export const petContent = z.strictObject({ id: contentId, ...petRow.shape });
export const factContent = z.strictObject({ id: contentId, ...factRow.omit({ key: true }).shape });
export const interestContent = z.strictObject({ id: contentId, ...interestRow.omit({ id: true, area: true }).shape });
export const usesContent = z.strictObject({ id: contentId, ...usesRow.omit({ position: true }).shape });
export const experienceContent = z.strictObject({
  id: contentId,
  ...experienceRow.omit({ id: true, highlights: true }).shape,
  highlights: z.array(z.string().min(1)).min(1).describe('The resume bullets, word for word'),
});

export const photo = z.strictObject({
  src: z.string().describe('Path of the photo, relative to the page file'),
  alt: z.string().describe('What the photo shows'),
  caption: z.string().optional().describe('Caption under the photo'),
});

export const pageContent = z.strictObject({
  title: z.string().describe('The heading the page or section shows'),
  images: z.array(photo).optional().describe('Photos on the page, in display order'),
});

export type FactContent = z.infer<typeof factContent>;
export type ProjectContent = z.infer<typeof projectContent>;
export type TechnologyContent = z.infer<typeof technologyContent>;
export type CourseContent = z.infer<typeof courseContent>;
export type TimelineContent = z.infer<typeof timelineContent>;
export type PetContent = z.infer<typeof petContent>;
export type ExperienceContent = z.infer<typeof experienceContent>;
export type InterestContent = z.infer<typeof interestContent>;
export type PageContent = z.infer<typeof pageContent>;
export type UsesContent = z.infer<typeof usesContent>;
