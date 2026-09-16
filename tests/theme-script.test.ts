import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('public/theme.js', 'utf8');

describe('theme.js', () => {
  it('stays under the 300 byte budget', () => {
    expect(Buffer.byteLength(source)).toBeLessThan(300);
  });

  it('guards storage access and only honours the two exact values', () => {
    expect(source).toMatch(/^try\{/);
    expect(source).toContain('t==="light"||t==="dark"');
    expect(source).toContain('setAttribute("data-theme",t)');
    expect(source).not.toMatch(/eval|Function\(/);
  });
});
