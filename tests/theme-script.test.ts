import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync('public/theme.js', 'utf8');

// Runs the script as the page's head does, with the stored value given, and returns the theme it
// set on the document, if any.
function applied(stored: string | null | Error): string | null {
  let theme: string | null = null;
  const localStorage = {
    getItem(key: string) {
      if (stored instanceof Error) throw stored;
      return key === 'theme' ? stored : null;
    },
  };
  const document = { documentElement: { setAttribute: (name: string, value: string) => (theme = name === 'data-theme' ? value : theme) } };
  runInNewContext(source, { localStorage, document });
  return theme;
}

describe('theme.js', () => {
  it('stays under the 300 byte budget', () => {
    expect(Buffer.byteLength(source)).toBeLessThan(300);
  });

  it('applies a stored light or dark theme, and nothing else', () => {
    expect(applied('light')).toBe('light');
    expect(applied('dark')).toBe('dark');
    for (const stored of [null, '', 'Dark', 'system', 'light ']) expect(applied(stored), String(stored)).toBeNull();
  });

  it('leaves the page alone where storage is blocked', () => {
    expect(applied(new Error('SecurityError'))).toBeNull();
  });
});
