// The plain-text resume curl gets and the JSON Resume at /api/resume.json, both built from the
// database, so they can only say what its tables say. build-db passes the database it has just
// written; the endpoint passes the one the site reads.
import { skillAreas } from '../content/schemas.ts';
import { stackQuery } from './rows.ts';

type Value = string | number | null;
export type Query = (sql: string) => Record<string, Value>[];

// A Query over a sql.js database, or anything else with its exec().
export function queryOf(db: { exec(sql: string): { columns: string[]; values: unknown[][] }[] }): Query {
  return (sql) => {
    const result = db.exec(sql)[0];
    if (!result) return [];
    return result.values.map((row) => Object.fromEntries(result.columns.map((name, index) => [name, row[index] as Value])));
  };
}

interface Job {
  title: string;
  organization: string;
  location: string;
  start: string;
  end: string | null;
  summary: string;
  highlights: string[];
}

interface Project {
  name: string;
  summary: string;
  role: string;
  start: number;
  url: string | null;
  highlights: string[];
  stack: string[];
}

export interface ResumeData {
  facts: Record<string, string>;
  work: Job[];
  projects: Project[];
  skills: { area: string; names: string[] }[];
  education: { start: string; end: string };
  courses: string[];
  interests: { category: string; names: string[] }[];
}

const text = (value: Value | undefined): string => String(value ?? '');

function grouped<T extends Record<string, Value>>(rows: T[], key: keyof T, value: keyof T): { key: string; values: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const row of rows) groups.set(text(row[key]), [...(groups.get(text(row[key])) ?? []), text(row[value])]);
  return [...groups].map(([name, values]) => ({ key: name, values }));
}

export function resumeData(query: Query): ResumeData {
  const facts = Object.fromEntries(query('SELECT key, value FROM facts').map((row) => [text(row.key), text(row.value)]));
  const work = query('SELECT title, organization, location, start, end, summary, highlights FROM experience ORDER BY start DESC').map((row) => ({
    title: text(row.title),
    organization: text(row.organization),
    location: text(row.location),
    start: text(row.start),
    end: row.end === null ? null : text(row.end),
    summary: text(row.summary),
    highlights: text(row.highlights).split('\n'),
  }));
  const projects = query('SELECT id, name, summary, role, year_start, live_url, repo_url, highlights FROM projects WHERE highlights IS NOT NULL ORDER BY id').map((row) => ({
    name: text(row.name),
    summary: text(row.summary),
    role: text(row.role),
    start: Number(row.year_start),
    url: row.live_url === null ? (row.repo_url === null ? null : text(row.repo_url)) : text(row.live_url),
    highlights: text(row.highlights).split('\n'),
    stack: query(stackQuery(Number(row.id))).map((link) => text(link.name)),
  }));
  // Each area's core skills first, then the rest, each by name; the areas in the order Alex listed them.
  const byArea = grouped(query('SELECT skill_area, name FROM technologies ORDER BY core DESC, lower(name), name'), 'skill_area', 'name');
  const skills = skillAreas.flatMap((area) => {
    const names = byArea.find((group) => group.key === area)?.values;
    return names ? [{ area, names }] : [];
  });
  const dates = query("SELECT date FROM timeline WHERE kind = 'education' ORDER BY date").map((row) => text(row.date));
  if (dates.length < 2) throw new Error('the timeline needs an education start and end for the resume');
  return {
    facts,
    work,
    projects,
    skills,
    education: { start: dates[0]!, end: dates.at(-1)! },
    courses: query('SELECT code, name FROM courses ORDER BY code').map((row) => `${text(row.code)} ${text(row.name)}`),
    interests: grouped(query('SELECT category, name FROM interests ORDER BY id'), 'category', 'name').map(({ key, values }) => ({ category: key, names: values })),
  };
}

// The plain-text resume: an 80-column terminal, labels in a 17-character column, a label too long
// for it on a line of its own. Only the contact line may run longer.
const WIDTH = 80;
const LABEL = 17;

// Greedy wrapping of whole pieces: words, or whole names in a list, so "Tailwind CSS" never splits.
function wrap(line: string, width: number, pieces = line.split(' ')): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of pieces) {
    if (current !== '' && current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
    } else {
      current = current === '' ? word : `${current} ${word}`;
    }
  }
  return current === '' ? lines : [...lines, current];
}

function labelled(label: string, body: string[]): string[] {
  const indent = ' '.repeat(LABEL);
  const rest = body.map((line) => `${indent}${line}`);
  if (label.length > LABEL - 2) return [label, ...rest];
  return [`${label.padEnd(LABEL)}${body[0] ?? ''}`, ...rest.slice(1)];
}

const paragraph = (line: string) => wrap(line, WIDTH - LABEL);
const list = (names: string[]) => wrap(names.join(', '), WIDTH - LABEL, names.map((name, index) => (index < names.length - 1 ? `${name},` : name)));
const bullet = (line: string) => wrap(line, WIDTH - LABEL - 2).map((part, index) => `${index === 0 ? '- ' : '  '}${part}`);

export function monthYear(yearMonth: string): string {
  return new Date(`${yearMonth}-01T00:00:00Z`).toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export function resumeText(data: ResumeData, origin: string): string {
  const { facts } = data;
  const lines = [
    facts.name!.toUpperCase(),
    facts.role!,
    [facts.location, facts.email, facts.github, facts.linkedin].join(' · '),
    '',
    facts.headline!,
    `${facts.status}.`,
    `Available full-time from ${monthYear(facts.available_from!)}.`,
    '',
    'WORK',
    ...data.work.flatMap((job) => labelled(`${job.start.slice(0, 4)}-${job.end?.slice(0, 4) ?? ''}`, paragraph(`${job.title}, ${job.organization}. ${job.summary}`))),
    '',
    'PROJECTS',
    ...data.projects.flatMap((project) => labelled(project.name, [...project.highlights.flatMap(bullet), ...list(project.stack)])),
    '',
    'SKILLS',
    ...data.skills.flatMap((skill) => labelled(skill.area, list(skill.names))),
    ...labelled('Spoken', paragraph(facts.languages_spoken!)),
    '',
    `Full resume (PDF): ${origin}/Alex-Kachur-Resume.pdf`,
  ];
  return `${lines.join('\n')}\n`;
}

// "English, Russian and Hebrew, all fluent" as JSON Resume's languages. The fact has to keep that
// shape; anything else fails the build rather than guess.
function languages(spoken: string): { language: string; fluency: string }[] {
  const match = /^(.+), all ([a-z]+)$/.exec(spoken);
  if (!match) throw new Error(`languages_spoken is not "A, B and C, all <level>": ${spoken}`);
  const fluency = `${match[2]![0]!.toUpperCase()}${match[2]!.slice(1)}`;
  return match[1]!.split(/, | and /).map((language) => ({ language, fluency }));
}

// The resume in the JSON Resume schema (jsonresume.org): work newest first, dates as YYYY-MM or
// YYYY, no endDate for what is ongoing.
export function resumeJson(data: ResumeData, origin: string) {
  const { facts } = data;
  const program = /^(.+), ([^,]+)$/.exec(facts.program ?? '');
  if (!program) throw new Error(`program is not "<area>, <credential>": ${facts.program}`);
  const profile = (network: string, address: string) => ({ network, username: address.split('/').at(-1), url: `https://${address}` });
  return {
    basics: {
      name: facts.name,
      label: facts.role,
      email: facts.email,
      url: origin,
      summary: facts.headline,
      location: { city: facts.location!.split(', ')[0] },
      profiles: [profile('GitHub', facts.github!), profile('LinkedIn', facts.linkedin!)],
    },
    work: data.work.map((job) => ({
      name: job.organization,
      position: job.title,
      location: job.location,
      startDate: job.start,
      ...(job.end === null ? {} : { endDate: job.end }),
      summary: job.summary,
      highlights: job.highlights,
    })),
    education: [
      {
        institution: facts.school,
        area: program[1],
        studyType: program[2],
        startDate: data.education.start,
        endDate: data.education.end,
        score: facts.gpa,
        courses: data.courses,
      },
    ],
    skills: data.skills.map((skill) => ({ name: skill.area, keywords: skill.names })),
    languages: languages(facts.languages_spoken!),
    projects: data.projects.map((project) => ({
      name: project.name,
      description: project.summary,
      highlights: project.highlights,
      keywords: project.stack,
      startDate: String(project.start),
      roles: [project.role],
      ...(project.url === null ? {} : { url: project.url }),
    })),
    interests: data.interests.map((interest) => ({ name: interest.category, keywords: interest.names })),
  };
}
