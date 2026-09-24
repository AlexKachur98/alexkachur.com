import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { readWoffTables, tableChecksum, unpackWoff } from '../scripts/woff.ts';

const require = createRequire(import.meta.url);
const fonts = [
  '@fontsource/barlow/files/barlow-latin-700-normal.woff',
  '@fontsource/barlow/files/barlow-latin-400-normal.woff',
  '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff',
];

function tag(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4));
}

describe('unpackWoff', () => {
  for (const font of fonts) {
    it(`rebuilds ${font.split('/').pop()} with every table where its directory says`, () => {
      const woff = new Uint8Array(readFileSync(require.resolve(font)));
      const { tables } = readWoffTables(woff);
      const sfnt = unpackWoff(woff);
      const view = new DataView(sfnt.buffer);
      const count = view.getUint16(4);
      expect(count).toBe(tables.length);
      expect(view.getUint32(0)).toBe(new DataView(woff.buffer, woff.byteOffset).getUint32(4));
      // The binary-search fields: the largest power of two not above the table count, times 16.
      const power = 2 ** Math.floor(Math.log2(count));
      expect([view.getUint16(6), view.getUint16(8), view.getUint16(10)]).toEqual([power * 16, Math.log2(power), count * 16 - power * 16]);

      const tags: string[] = [];
      for (let index = 0; index < count; index++) {
        const record = 12 + index * 16;
        const name = tag(sfnt, record);
        const offset = view.getUint32(record + 8);
        const length = view.getUint32(record + 12);
        tags.push(name);
        expect(offset % 4, name).toBe(0);
        expect(tableChecksum(name, sfnt.subarray(offset, offset + length)), name).toBe(view.getUint32(record + 4));
      }
      expect(tags).toEqual([...tags].sort());
      expect(tags).toEqual(expect.arrayContaining(['cmap', 'glyf', 'GPOS', 'head', 'hmtx', 'maxp']));
    });
  }

  it('refuses a file that is not WOFF 1.0 and a table whose bytes do not match its checksum', () => {
    const woff2 = new Uint8Array(readFileSync(require.resolve('@fontsource/barlow/files/barlow-latin-700-normal.woff2')));
    expect(() => unpackWoff(woff2)).toThrow('not a WOFF 1.0 file');

    const woff = new Uint8Array(readFileSync(require.resolve(fonts[0]!)));
    const view = new DataView(woff.buffer, woff.byteOffset);
    const firstChecksum = 44 + 16;
    view.setUint32(firstChecksum, (view.getUint32(firstChecksum) + 1) >>> 0);
    expect(() => unpackWoff(woff)).toThrow('does not match its recorded checksum');
  });
});
