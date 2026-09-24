import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { availableMonth, siteFacts } from '../src/lib/facts.ts';
import type { SiteFacts } from '../src/lib/facts.ts';

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name).replaceAll('\\', '/');
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const escape = (text: string) => text.replaceAll('&', '&amp;');

describe('the facts the pages show', () => {
  // The hero, Contact and the page heads read these from the database, so a value typed into the
  // source would be a second copy that could disagree with it.
  it('are typed nowhere in src outside the content files', () => {
    const facts = parse(readFileSync('src/content/facts.yaml', 'utf8')) as { id: string; value: string }[];
    const guarded = facts.filter((fact) => ['email', 'github', 'linkedin', 'role', 'headline', 'status'].includes(fact.id));
    expect(guarded).toHaveLength(6);
    const files = walk('src').filter((path) => !path.startsWith('src/content/') && !path.startsWith('src/generated/') && !/\.(png|jpe?g|webp|svg)$/.test(path));
    const found = files.flatMap((path) => {
      const text = readFileSync(path, 'utf8');
      return guarded.filter(({ value }) => text.includes(value) || text.includes(escape(value))).map(({ id }) => `${path}: ${id}`);
    });
    expect(found).toEqual([]);
  });

  it('come from the built database, all of them', async () => {
    const facts = await siteFacts();
    expect(Object.keys(facts).sort()).toEqual(['available_from', 'email', 'github', 'headline', 'linkedin', 'location', 'name', 'role', 'school', 'status']);
    expect(Object.values(facts).every((value) => value.length > 0)).toBe(true);
  });

  it('give the month Alex is available from in words', () => {
    const at = (available_from: string) => availableMonth({ available_from } as SiteFacts);
    expect(at('2027-05')).toEqual({ month: 'May', year: '2027' });
    expect(at('2028-01')).toEqual({ month: 'January', year: '2028' });
    expect(() => at('May 2027')).toThrow(/not YYYY-MM/);
  });
});
