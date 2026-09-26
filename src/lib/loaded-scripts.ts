// The scripts a page loads before any interaction, with their sizes gzipped at zlib's default
// level. Those in the build are read from the client output, which exists by the time pages
// render; in dev it does not, and the page shows none. The beacon is Vercel's own file, injected at
// run time, so its size was measured from the live site on the day given.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

export interface LoadedScript {
  name: string;
  bytes: number;
  job: string;
}

export const INSIGHTS = { name: '/_vercel/insights/script.js', bytes: 2014, measured: '2026-09-25' } as const;

// The bootstrap's budget, gzipped; the build test fails once the bootstrap reaches it, and the
// page names it.
export const BOOTSTRAP_BUDGET_BYTES = 2048;

export function loadedScripts(): LoadedScript[] | null {
  const root = process.cwd();
  const assets = join(root, 'dist', 'client', '_astro');
  if (!existsSync(assets)) return null;
  const files = readdirSync(assets).filter((name) => name.endsWith('.js'));
  const bootstrap = files.find((name) => /^Base\.astro_astro_type_script_index_0_lang\./.test(name));
  const analytics = files.find((name) => readFileSync(join(assets, name), 'utf8').includes(INSIGHTS.name));
  if (!bootstrap || !analytics) throw new Error('the client build has no bootstrap or no analytics module');
  const gzipped = (path: string): number => gzipSync(readFileSync(path)).length;
  return [
    { name: '/theme.js', bytes: gzipped(join(root, 'public', 'theme.js')), job: 'applies your saved theme before the first paint' },
    { name: 'the bootstrap module', bytes: gzipped(join(assets, bootstrap)), job: 'the theme toggle, the footer readouts, and the loader for the console when you touch it' },
    { name: 'the Web Analytics module', bytes: gzipped(join(assets, analytics)), job: 'adds the page-count beacon' },
  ];
}
