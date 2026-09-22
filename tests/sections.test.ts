import { describe, expect, it } from 'vitest';
import { splitSections } from '../src/lib/sections.ts';

const html = [
  '<h2 id="the-problem">The problem</h2>',
  '<p>One.</p>',
  '<h2 id="what-went-wrong-or-what-i-would-change">What went wrong or what I would change</h2>',
  '<h2 id="credits">Credits</h2>',
  '<p>Built alone.</p>',
  '<ul>\n<li>a</li>\n</ul>',
].join('\n');

describe('splitSections', () => {
  it('returns one section per h2 with its id, title and the markup up to the next h2', () => {
    expect(splitSections(html)).toEqual([
      { id: 'the-problem', title: 'The problem', body: '<p>One.</p>' },
      { id: 'what-went-wrong-or-what-i-would-change', title: 'What went wrong or what I would change', body: '' },
      { id: 'credits', title: 'Credits', body: '<p>Built alone.</p>\n<ul>\n<li>a</li>\n</ul>' },
    ]);
  });

  it('accepts attributes before the id and ignores h3 headings', () => {
    const sections = splitSections('<h2 class="x" id="a">A</h2>\n<h3 id="b">B</h3>\n<p>c</p>');
    expect(sections).toEqual([{ id: 'a', title: 'A', body: '<h3 id="b">B</h3>\n<p>c</p>' }]);
  });

  it('returns nothing for empty input and refuses content that precedes the first h2', () => {
    expect(splitSections('')).toEqual([]);
    expect(splitSections('  \n')).toEqual([]);
    expect(() => splitSections('<p>lead</p>\n<h2 id="a">A</h2>')).toThrow(/content before the first h2/);
  });
});
