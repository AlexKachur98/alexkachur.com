import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { describe, expect, it } from 'vitest';

// Trojan Source (CVE-2021-42574): characters that draw nothing or reorder the text around them can
// make source read differently from how it runs. A byte-order mark is allowed only as the very first
// character of a file.
const hidden = /[\u200B-\u200D\u2060\u202A-\u202E\u2066-\u2069\uFEFF\uFFFE\uFFFF]/;
const byteOrderMark = '\uFEFF';
const binary = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.woff', '.woff2', '.wasm', '.sqlite']);

function git(...args: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', ...args], { encoding: 'utf8' }).split('\0').filter(Boolean);
}

const textFiles = [...new Set([...git(), ...git('--others', '--exclude-standard')])].filter((file) => !binary.has(extname(file)));

describe('source text', () => {
  it('has no invisible or bidirectional control character in any text file', () => {
    expect(textFiles).toContain('package.json');
    const offenders: string[] = [];
    for (const file of textFiles) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('\0')) continue;
      text.split('\n').forEach((line, index) => {
        const checked = index === 0 && line.startsWith(byteOrderMark) ? line.slice(1) : line;
        if (hidden.test(checked)) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });
});
