import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoFiles } from './helpers.ts';

// Checks on the style source: type that survives zoom and a larger default text size, and the one
// hue besides yellow kept inside the dark panels.

const files = repoFiles().filter((file) => file !== 'tests/styles.test.ts');
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
    expect([...scale.keys()].sort()).toEqual(['--text-2xl', '--text-3xl', '--text-lg', '--text-md', '--text-role', '--text-sm', '--text-xl', '--text-xs']);
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

describe('the Ask and console panels', () => {
  const askBox = readFileSync('src/components/AskBox.astro', 'utf8');
  const consoleCss = readFileSync('src/styles/console.css', 'utf8');

  // The hold is only for the pane beside the form: under the form the example never shows, and an
  // answer there grows from nothing.
  it("holds the Ask pane at the example's height only beside the form", () => {
    const wide = askBox.indexOf('@media (min-width: 1200px)');
    expect(wide).toBeGreaterThan(0);
    expect(askBox.slice(wide)).toMatch(/\.ask-split \.ask-panel \{[^}]*min-height: var\(--example-height, auto\);/);
    expect(askBox.slice(0, wide)).not.toContain('--example-height');
  });

  // The Ask results scroll inside a box only beside the form, on a mouse or trackpad and a window
  // tall enough; the raw console and everything else keep growing.
  it('caps the Ask results only in the wide, tall, fine-pointer layout', () => {
    expect(consoleCss).not.toMatch(/max-height/);
    const cap = askBox.indexOf('max-height: 25rem;');
    expect(cap).toBeGreaterThan(0);
    expect(askBox.lastIndexOf('max-height')).toBe(askBox.indexOf('max-height'));
    let from = 0;
    for (const rule of ['@media (min-width: 1200px)', '@supports (grid-template-columns: subgrid)', '@media (min-height: 42.5rem) and (hover: hover) and (pointer: fine)']) {
      const at = askBox.lastIndexOf(rule, cap);
      expect(at, rule).toBeGreaterThan(from);
      from = at;
    }
    // Nested: both media rules, the supports rule and the results rule are all still open at the cap.
    const inside = askBox.slice(askBox.lastIndexOf('@media (min-width: 1200px)', cap), cap);
    expect(inside.split('{').length - inside.split('}').length).toBe(4);
  });

  it('leaves room above the answer when the page scrolls it into sight', () => {
    expect(askBox).toMatch(/\.ask-panel,\s*\.ask-panel > \.console-head \{\s*scroll-margin: var\(--space-4\);/);
  });

  it("gives the question field's clear control a 44 by 44 px target standing 2px proud of the 40px field", () => {
    const px = (name: string) => Number(tokens.match(new RegExp(`${name}: (\\d+)px;`))![1]);
    const rule = askBox.match(/\n {2}\.ask-clear \{([^}]*)\}/)![1]!;
    expect(rule).toContain('width: calc(var(--control) + var(--space-1));');
    expect(rule).toContain('height: calc(var(--control) + var(--space-1));');
    expect(rule).toContain('top: calc(var(--space-1) / -2);');
    expect(rule).toContain('right: 0;');
    expect(rule).toContain('border: 0;');
    expect(rule).toContain('background: none;');
    expect(px('--control') + px('--space-1')).toBe(44);
    expect(-px('--space-1') / 2).toBe(-2);
    expect(px('--control')).toBe(40);
    const input = askBox.match(/\n {2}\.ask-field \.input \{([^}]*)\}/)![1]!;
    expect(input).toContain('display: block;');
    expect(input).toContain('padding-right: calc(var(--control) + var(--space-1));');
  });

  it("draws the console's Clear and the fallback examples as text buttons, and hides Clear while a query runs", () => {
    const button = consoleCss.match(/\n\.text-button \{([^}]*)\}/)![1]!;
    for (const line of ['border: 0;', 'background: none;', 'text-decoration: underline;', 'min-height: var(--control);']) expect(button).toContain(line);
    const rule = consoleCss.match(/\n\.console-clear \{([^}]*)\}/)![1]!;
    for (const line of ['min-width: var(--control);', 'margin-left: var(--space-4);']) expect(rule).toContain(line);
    expect(consoleCss).toMatch(/\.console\[data-working\] > \.console-clear \{\s*visibility: hidden;\s*\}/);
  });
});
