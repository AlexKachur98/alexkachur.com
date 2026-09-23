import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Checks on the style source: type that survives zoom and a larger default text size, and the
// one hue besides yellow kept inside the dark panels.

function git(...args: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', ...args], { encoding: 'utf8' }).split('\0').filter(Boolean);
}

const files = [...new Set([...git(), ...git('--others', '--exclude-standard')])].filter((file) => file !== 'tests/styles.test.ts');
const styleFiles = files.filter((file) => file.startsWith('src/') && /\.(css|astro)$/.test(file));
const tokens = readFileSync('src/styles/tokens.css', 'utf8');

// Every value each --text-* token takes, in every block and at every width.
const scale = new Map<string, number[]>();
const units = new Map<string, string[]>();
for (const [, name, value] of tokens.matchAll(/(--text-[a-z0-9]+)\s*:\s*([^;]+);/g)) {
  units.set(name!, [...(units.get(name!) ?? []), value!.trim()]);
  scale.set(name!, [...(scale.get(name!) ?? []), Number.parseFloat(value!)]);
}

// A number followed by vw, vh, vi, vb, vmin or vmax, or their small, large and dynamic forms.
const viewportUnit = /\d(?:[sld]?v(?:w|h|i|b|min|max))\b/;

describe('type scale', () => {
  it('finds every size token', () => {
    expect([...scale.keys()].sort()).toEqual(['--text-2xl', '--text-3xl', '--text-lg', '--text-md', '--text-sm', '--text-xl', '--text-xs']);
  });

  it('writes every step as a plain rem length, so it follows the default text size', () => {
    for (const [name, values] of units) {
      for (const value of values) expect(value, name).toMatch(/^\d*\.?\d+rem$/);
    }
  });

  // Zoom narrows the viewport onto smaller steps; at 500% the smallest must still reach double
  // the largest.
  it('keeps the largest step of each token within 2.5 times its smallest', () => {
    for (const [name, values] of scale) {
      expect(Math.max(...values) / Math.min(...values), name).toBeLessThanOrEqual(2.5);
    }
  });

  it('sets no font size in a viewport unit anywhere in the styles', () => {
    const offenders: string[] = [];
    for (const file of styleFiles) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          for (const [, value] of line.matchAll(/(?:^|[\s;{])font(?:-size)?\s*:\s*([^;]+)/g)) {
            if (viewportUnit.test(value!)) offenders.push(`${file}:${index + 1}`);
          }
        });
    }
    expect(styleFiles.length).toBeGreaterThan(10);
    expect(offenders).toEqual([]);
  });
});

describe('keyword colour', () => {
  const allowed = new Set(['src/styles/tokens.css', 'src/styles/console.css', 'src/components/AskBox.astro']);

  it('is declared once, with the console tokens', () => {
    expect(tokens.match(/--console-keyword/g)).toHaveLength(1);
    expect(tokens).toMatch(/--console-keyword: #56B4E9;/);
  });

  it('appears nowhere outside the console and Ask panel styles', () => {
    const users = files.filter((file) => !/\.(webp|png|jpe?g|gif|ico|pdf|woff2?|wasm|sqlite)$/.test(file) && readFileSync(file, 'utf8').includes('--console-keyword'));
    expect(users.length).toBeGreaterThan(0);
    expect(users.filter((file) => !allowed.has(file))).toEqual([]);
  });
});
