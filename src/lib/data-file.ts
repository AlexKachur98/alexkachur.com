import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Build-time only. Everything under /data/ is cached immutable under a fixed file name, so every
// link to a file there carries the first 8 hex characters of the file's SHA-256: a changed file
// gets a new URL and an unchanged one keeps its cached copy. The path starts at the project root,
// where build-db writes, because the adapter prerenders from its output folder and a URL
// relative to this module would point elsewhere.
export interface DataFile {
  url: string;
  bytes: number;
}

export function dataFile(name: string): DataFile {
  const contents = readFileSync(join(process.cwd(), 'public', 'data', name));
  const version = createHash('sha256').update(contents).digest('hex').slice(0, 8);
  return { url: `/data/${name}?v=${version}`, bytes: contents.byteLength };
}
