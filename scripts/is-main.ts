import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Whether a module is the script node was started with: a script does its work then, and a test
// that imports it gets only its exports. Node resolves the started file through its real path, so
// a symlinked checkout must compare the same way.
export function isMain(url: string): boolean {
  const started = process.argv[1];
  return started !== undefined && url === pathToFileURL(realpathSync(started)).href;
}
