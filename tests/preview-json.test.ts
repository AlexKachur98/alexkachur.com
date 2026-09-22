import { describe, expect, it } from 'vitest';
import { previewJson } from '../src/lib/preview-json.ts';

describe('previewJson', () => {
  it('keeps the first items of an array and marks the rest', () => {
    expect(previewJson([1, 2, 3, 4])).toBe('[\n  1,\n  2,\n  ...\n]');
    expect(previewJson([1, 2])).toBe('[\n  1,\n  2\n]');
    expect(previewJson([])).toBe('[]');
  });

  it('prints every key of an object and nests with two-space indents', () => {
    expect(previewJson({ id: 1, tags: ['a', 'b', 'c'], nested: { ok: true, none: null } }, { items: 1 })).toBe(
      ['{', '  "id": 1,', '  "tags": [', '    "a",', '    ...', '  ],', '  "nested": {', '    "ok": true,', '    "none": null', '  }', '}'].join('\n'),
    );
  });

  it('cuts long strings and escapes like JSON', () => {
    expect(previewJson('x'.repeat(10), { chars: 4 })).toBe('"xxxx..."');
    expect(previewJson('short "quoted"')).toBe('"short \\"quoted\\""');
    expect(previewJson('line\nbreak')).toBe('"line\\nbreak"');
  });

  it('is valid JSON when nothing is truncated', () => {
    const value = { rows: [{ name: 'Uraz Hoops', year_start: 2026, live_url: null }], count: 1 };
    expect(JSON.parse(previewJson(value))).toEqual(value);
  });
});
