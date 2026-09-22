import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The build output test of SPEC 9.7, first version: no HTML comment and no TODO-ALEX anywhere.
// npm test builds first (pretest), so the tree is the current one. The static tree is dist/
// until an on-demand endpoint exists and dist/client from then on.
const root = ['dist/client', 'dist'].find((dir) => existsSync(join(dir, 'index.html')));
if (!root) throw new Error('no build output: run npm run build first');

const textTypes = new Set(['.html', '.js', '.css', '.json', '.txt', '.xml', '.sql', '.svg', '.map']);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

const files = walk(root).filter((path) => textTypes.has(extname(path)));

describe(`built output in ${root}`, () => {
  it('has pages to check', () => {
    expect(files.filter((path) => path.endsWith('.html')).length).toBeGreaterThan(5);
  });

  it('contains no HTML comment and no TODO-ALEX in any text file', () => {
    const offenders = files
      .map((path) => ({ path, text: readFileSync(path, 'utf8') }))
      .filter(({ text }) => text.includes('<!--') || text.includes('TODO-ALEX'))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
