import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

// Checks on the style source: type that survives zoom and a larger default text size, the one
// hue besides yellow kept inside the dark panels, and Barlow's metrics as the font file has them.

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

describe('Barlow metrics', () => {
  // The name's weight, in the .woff the site also serves: its tables are plain zlib.
  it('match the font file the name is set in', () => {
    const font = readFileSync('node_modules/@fontsource/barlow/files/barlow-latin-700-normal.woff');
    const tables = new Map<string, Buffer>();
    for (let i = 0; i < font.readUInt16BE(12); i++) {
      const entry = 44 + i * 20;
      const offset = font.readUInt32BE(entry + 4);
      const stored = font.subarray(offset, offset + font.readUInt32BE(entry + 8));
      tables.set(font.toString('latin1', entry, entry + 4), stored.length < font.readUInt32BE(entry + 12) ? inflateSync(stored) : stored);
    }
    const head = tables.get('head')!;
    const hhea = tables.get('hhea')!;
    const os2 = tables.get('OS/2')!;
    const em = head.readUInt16BE(18);
    const token = (name: string) => Number(tokens.match(new RegExp(`${name}: ([0-9.]+);`))?.[1]);

    // The file holds its ascent and descent three times: in hhea, and as the typo and win pairs in
    // OS/2, where the win pair differs. Its USE_TYPO_METRICS flag (bit 7 of fsSelection, from OS/2
    // version 4) marks the typo pair as the one to use. The tokens copy that pair, so the flag must
    // stay set and hhea must agree with it.
    expect(os2.readUInt16BE(0)).toBeGreaterThanOrEqual(4);
    expect(os2.readUInt16BE(62) & 0x80).toBe(0x80);
    expect([hhea.readInt16BE(4), hhea.readInt16BE(6)]).toEqual([os2.readInt16BE(68), os2.readInt16BE(70)]);
    expect(token('--barlow-ascent')).toBe(os2.readInt16BE(68) / em);
    expect(token('--barlow-descent')).toBe(-os2.readInt16BE(70) / em);
    expect(token('--barlow-cap-height')).toBe(os2.readInt16BE(88) / em);
  });
});
