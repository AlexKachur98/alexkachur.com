import { createSatteriMarkdownProcessor } from '@astrojs/markdown-satteri';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { stripComments, stripHtmlComments } from '../src/lib/strip-comments.ts';

const processor = await createSatteriMarkdownProcessor({ smartypants: false, hastPlugins: [stripComments] });

async function render(markdown: string): Promise<string> {
  return (await processor.render(markdown)).code;
}

describe('stripHtmlComments', () => {
  it('removes every comment, single or multi-line, and nothing else', () => {
    expect(stripHtmlComments('<p>a</p><!-- one --><p>b</p>\n<!-- two\nlines -->\n<!doctype html>')).toBe(
      '<p>a</p><p>b</p>\n\n<!doctype html>',
    );
    expect(stripHtmlComments('<!---->x<!-- -- -->')).toBe('x');
  });
});

describe('stripComments', () => {
  it('drops a comment that is a block of its own', async () => {
    const html = await render('## Outcome\n\n<!-- TODO: fill after the build -->\n\n## Credits\n\nBuilt alone.\n');
    expect(html).not.toContain('<!--');
    expect(html).not.toContain('TODO:');
    expect(html).toContain('<h2 id="outcome">Outcome</h2>');
    expect(html).toContain('<p>Built alone.</p>');
  });

  it('drops a comment inside a paragraph or list item and keeps the text around it', async () => {
    const html = await render('In progress. <!-- TODO: demo date --> More text.\n\n- Item <!-- TODO: caption --> tail\n');
    expect(html).not.toContain('<!--');
    expect(html).toContain('In progress.');
    expect(html).toContain('More text.');
    expect(html).toContain('Item');
    expect(html).toContain('tail');
  });

  it('keeps raw HTML that carries a comment next to markup', async () => {
    const html = await render('<span>kept</span><!-- gone --><span>also kept</span>\n');
    expect(html).toContain('<span>kept</span><span>also kept</span>');
    expect(html).not.toContain('gone');
  });

  it('strips every comment in the four project files and the Now page', async () => {
    const files = [
      ...readdirSync('src/content/projects').map((name) => `src/content/projects/${name}`),
      'src/content/pages/now.md',
    ];
    for (const file of files) {
      const source = readFileSync(file, 'utf8').replace(/^---[\s\S]*?\n---\n/, '');
      expect(source, `${file} fixture still has comments to strip`).toContain('<!--');
      const html = await render(source);
      expect(html, file).not.toContain('<!--');
      expect(html, file).not.toContain('TODO:');
    }
  });
});
