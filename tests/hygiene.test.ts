import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { describe, expect, it } from 'vitest';

// Text that must not appear in any file git tracks or would add. Each entry names what it
// catches, so a failure reads as file:line and the reason. Extend the list here.
const banned: { reason: string; pattern: RegExp; only?: RegExp }[] = [
  { reason: 'cites SPEC.md', pattern: /SPEC\.md/ },
  { reason: 'cites SPEC', pattern: /SPEC / },
  { reason: 'cites DESIGN.md', pattern: /DESIGN\.md/ },
  { reason: 'cites DESIGN', pattern: /DESIGN / },
  { reason: 'cites copy-drafts', pattern: /copy-drafts/i },
  { reason: 'cites CLAUDE.md', pattern: /CLAUDE\.md/ },
  { reason: 'uses the old TODO-ALEX marker', pattern: /TODO-ALEX/i },
  { reason: 'refers to a milestone', pattern: /milestone/i },
  { reason: 'carries an attribution trailer', pattern: /Co-Authored-By/i },
  { reason: 'links anthropic.com', pattern: /anthropic\.com/i },
  { reason: 'contains an em dash or en dash', pattern: /[–—]/ },
  { reason: 'sets an inline style attribute', pattern: /style=/, only: /^src\// },
];

// Files that must name the private documents or the marker: the ignore list, the lockfile, the
// vendored sql.js and this test.
const skipped = [/^\.gitignore$/, /^package-lock\.json$/, /^public\/vendor\//, /^tests\/hygiene\.test\.ts$/];
const binary = new Set(['.webp', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.woff', '.woff2', '.wasm', '.sqlite']);

function git(...args: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', ...args], { encoding: 'utf8' }).split('\0').filter(Boolean);
}

const textFiles = [...new Set([...git(), ...git('--others', '--exclude-standard')])].filter((file) => !binary.has(extname(file)));
const files = textFiles.filter((file) => !skipped.some((pattern) => pattern.test(file)));

// Characters that draw nothing, so a reader of the file or the diff cannot see them: the two
// noncharacters, the zero-width space and joiners, and the word joiner. A byte-order mark is
// allowed only as the very first character of a file.
const invisible = /[\uFFFE\uFFFF\u200B-\u200D\u2060]/;
const byteOrderMark = '\uFEFF';

describe('repository hygiene', () => {
  it('walks the tracked and addable files', () => {
    expect(files).toContain('package.json');
    expect(files).toContain('src/pages/index.astro');
  });

  it('finds none of the banned text', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('\0')) continue;
      const rules = banned.filter((rule) => !rule.only || rule.only.test(file));
      text.split('\n').forEach((line, index) => {
        for (const rule of rules) {
          if (rule.pattern.test(line)) offenders.push(`${file}:${index + 1} ${rule.reason}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('finds no invisible character in any text file', () => {
    const offenders: string[] = [];
    for (const file of textFiles) {
      const text = readFileSync(file, 'utf8');
      if (text.includes('\0')) continue;
      text.split('\n').forEach((line, index) => {
        const checked = index === 0 && line.startsWith(byteOrderMark) ? line.slice(1) : line;
        if (invisible.test(checked) || checked.includes(byteOrderMark)) offenders.push(`${file}:${index + 1}`);
      });
    }
    expect(textFiles).toContain('tests/hygiene.test.ts');
    expect(offenders).toEqual([]);
  });
});
