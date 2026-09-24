// The facts the pages show (the hero, Contact, every page's head), read from the built database
// once per build, so a page says what a visitor's query of the facts table returns.
import { select } from './query.ts';

const keys = ['name', 'role', 'headline', 'status', 'location', 'school', 'available_from', 'email', 'github', 'linkedin'] as const;

export type SiteFacts = Record<(typeof keys)[number], string>;

let reading: Promise<SiteFacts> | undefined;

export function siteFacts(): Promise<SiteFacts> {
  return (reading ??= read());
}

async function read(): Promise<SiteFacts> {
  const { rows } = await select('SELECT key, value FROM facts');
  const values = new Map(rows.map(([key, value]) => [String(key), String(value)]));
  const missing = keys.filter((key) => !values.has(key));
  if (missing.length > 0) throw new Error(`the facts table has no ${missing.join(', ')}`);
  return Object.fromEntries(keys.map((key) => [key, values.get(key)!])) as SiteFacts;
}

// available_from as the words a reader sees, for example { month: 'May', year: '2027' }.
export function availableMonth(facts: SiteFacts): { month: string; year: string } {
  const date = new Date(`${facts.available_from}-01T00:00:00Z`);
  if (Number.isNaN(date.getTime())) throw new Error(`available_from is not YYYY-MM: ${facts.available_from}`);
  return { month: date.toLocaleString('en', { month: 'long', timeZone: 'UTC' }), year: String(date.getUTCFullYear()) };
}
