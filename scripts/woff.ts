import { inflateSync } from 'node:zlib';

// Turns a WOFF 1.0 file back into the plain OpenType font it wraps. HarfBuzz reads only plain
// fonts, and WOFF 1.0 is that font's tables, each one zlib-compressed on its own, so node:zlib
// is all it takes (WOFF2 needs a Brotli decoder and a glyph-table transform on top).

export interface WoffTable {
  tag: string;
  checksum: number;
  data: Uint8Array;
}

function tagAt(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

// The OpenType table checksum: the table as big-endian 32-bit words, zero-padded to a whole word,
// summed modulo 2^32. The head table's own checksum is taken with its checkSumAdjustment field
// (bytes 8 to 11) read as zero, because that field is filled in after every checksum is known.
export function tableChecksum(tag: string, data: Uint8Array): number {
  const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
  padded.set(data);
  if (tag === 'head') padded.fill(0, 8, 12);
  const view = new DataView(padded.buffer);
  let sum = 0;
  for (let offset = 0; offset < padded.length; offset += 4) sum = (sum + view.getUint32(offset)) >>> 0;
  return sum;
}

export function readWoffTables(woff: Uint8Array): { flavor: number; tables: WoffTable[] } {
  const view = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (woff.byteLength < 44 || tagAt(view, 0) !== 'wOFF') throw new Error('not a WOFF 1.0 file');
  if (view.getUint32(8) !== woff.byteLength) throw new Error('WOFF length field does not match the file');
  const flavor = view.getUint32(4);
  const count = view.getUint16(12);
  const tables: WoffTable[] = [];
  for (let index = 0; index < count; index++) {
    const entry = 44 + index * 20;
    const tag = tagAt(view, entry);
    const offset = view.getUint32(entry + 4);
    const compressedLength = view.getUint32(entry + 8);
    const length = view.getUint32(entry + 12);
    const checksum = view.getUint32(entry + 16);
    if (offset + compressedLength > woff.byteLength) throw new Error(`WOFF table ${tag} runs past the end of the file`);
    const stored = woff.subarray(offset, offset + compressedLength);
    const data = compressedLength < length ? new Uint8Array(inflateSync(stored)) : stored.slice();
    if (data.length !== length) throw new Error(`WOFF table ${tag} inflates to ${data.length} bytes, not ${length}`);
    if (tableChecksum(tag, data) !== checksum) throw new Error(`WOFF table ${tag} does not match its recorded checksum`);
    tables.push({ tag, checksum, data });
  }
  return { flavor, tables };
}

export function unpackWoff(woff: Uint8Array): Uint8Array {
  const { flavor, tables } = readWoffTables(woff);
  const sorted = [...tables].sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  const headerLength = 12 + sorted.length * 16;
  const offsets: number[] = [];
  let length = headerLength;
  for (const table of sorted) {
    offsets.push(length);
    length += Math.ceil(table.data.length / 4) * 4;
  }

  const font = new Uint8Array(length);
  const view = new DataView(font.buffer);
  // The offset table's binary-search fields, as the OpenType spec defines them.
  const power = 2 ** Math.floor(Math.log2(sorted.length));
  view.setUint32(0, flavor);
  view.setUint16(4, sorted.length);
  view.setUint16(6, power * 16);
  view.setUint16(8, Math.log2(power));
  view.setUint16(10, sorted.length * 16 - power * 16);
  sorted.forEach((table, index) => {
    const record = 12 + index * 16;
    for (let char = 0; char < 4; char++) view.setUint8(record + char, table.tag.charCodeAt(char));
    view.setUint32(record + 4, table.checksum);
    view.setUint32(record + 8, offsets[index]!);
    view.setUint32(record + 12, table.data.length);
    font.set(table.data, offsets[index]!);
  });
  return font;
}
