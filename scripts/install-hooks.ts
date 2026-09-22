// Copies scripts/pre-commit into .git/hooks on npm install (the prepare script). A checkout
// without a .git folder, such as the Vercel build, is left alone.
import { chmodSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const hooks = join('.git', 'hooks');
if (existsSync(hooks)) {
  const target = join(hooks, 'pre-commit');
  copyFileSync(join('scripts', 'pre-commit'), target);
  chmodSync(target, 0o755);
}
