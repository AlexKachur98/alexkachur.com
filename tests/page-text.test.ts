import { describe, expect, it } from 'vitest';
import { renderBody } from '../src/lib/markdown.ts';
import { blockText, decodeEntities, inlineText } from '../src/lib/page-text.ts';
import { sectionRows } from '../src/lib/rows.ts';
import { splitSections } from '../src/lib/sections.ts';

// Markdown through the site's renderer, then into rows, as build-db does it.
async function rows(markdown: string, title?: string) {
  return sectionRows([{ page: '/test', title, html: await renderBody(markdown) }]);
}

describe('the text of a rendered page', () => {
  it('puts a blank line between paragraphs and a line per list item', async () => {
    const [row] = await rows('## Decisions\n\nFirst.\n\nSecond, with **bold**, `code` and [a link](https://example.com).\n\n- one\n- two\n');
    expect(row).toEqual({
      page: '/test',
      position: 1,
      heading: 'Decisions',
      body: 'First.\n\nSecond, with bold, code and a link.\n\n- one\n- two',
    });
  });

  it('keeps a loose list item to one line', async () => {
    const [row] = await rows('## A\n\n- first\n\n- second\n  continued\n');
    expect(row!.body).toBe('- first\n- second continued');
  });

  it('drops a comment, even inside a list item, and leaves out a section that holds nothing else', async () => {
    const result = await rows('## Kept\n\n- item <!-- a note -->\n\n## Empty\n\n<!-- TODO: write this. -->\n\n## Last\n\nText.\n');
    expect(result.map((row) => [row.position, row.heading, row.body])).toEqual([
      [1, 'Kept', '- item'],
      [2, 'Last', 'Text.'],
    ]);
  });

  it('shows a heading with an ampersand or inline code as its text', async () => {
    const [row] = await rows('## Q & A with `sql.js`\n\nText.\n');
    expect(row!.heading).toBe('Q & A with sql.js');
  });

  it('gives a page with no heading of its own one section under its title', async () => {
    expect(await rows('One.\n\nTwo.\n', 'About')).toEqual([{ page: '/test', position: 1, heading: 'About', body: 'One.\n\nTwo.' }]);
    await expect(rows('One.\n')).rejects.toThrow(/content before the first h2/);
  });

  it('refuses markup it does not know rather than store it half-read', () => {
    expect(() => blockText('<table><tr><td>x</td></tr></table>')).toThrow(/<table> is not an element/);
    expect(() => blockText('<ul><li>a<ul><li>b</li></ul></li></ul>')).toThrow(/a list inside a list/);
    expect(() => blockText('<p>open')).toThrow(/left open/);
    expect(() => blockText('loose text')).toThrow(/outside a block/);
    expect(() => inlineText('<p>x</p>')).toThrow(/<p> in inline text/);
  });

  it('decodes the entities the renderer writes, and no others', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39; &#x2F;')).toBe('a & b <c> "d" \'e\' /');
    expect(() => decodeEntities('&nbsp;')).toThrow(/unknown entity/);
  });
});

describe('splitSections', () => {
  it('decodes each title, since Section escapes it again', () => {
    expect(splitSections('<h2 id="q">Q &amp; A</h2>\n<p>x</p>')[0]!.title).toBe('Q & A');
  });
});
