// What several test files share.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import type { AskConfig } from '../src/lib/ask/config.ts';

function gitFiles(...args: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', ...args], { encoding: 'utf8' }).split('\0').filter(Boolean);
}

// Every file of the repository, tracked or new and not ignored, that is still on disk: a file
// deleted but not yet committed is listed by git and gone.
export function repoFiles(): string[] {
  return [...new Set([...gitFiles(), ...gitFiles('--others', '--exclude-standard')])].filter((file) => existsSync(file));
}

// Every file under a folder, with forward slashes.
export function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? walk(path) : [path];
  });
}

// An ask configuration with everything set; a test overrides what it is about.
export function askConfig(overrides: Partial<AskConfig> = {}): AskConfig {
  return { env: 'test', model: 'm', maxTokens: 512, cap: 100, apiKey: 'k', limitSecret: 'test-limit-secret', redis: { url: 'u', token: 't' }, ...overrides };
}
