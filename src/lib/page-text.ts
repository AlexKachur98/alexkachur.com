// Rendered markdown as the sections table stores it: a blank line between blocks, each list item on
// a line of its own starting with "- ", whitespace collapsed, and inline markup kept as its text.
// It reads only the elements the site's markdown produces, so anything else fails the build
// instead of reaching the table half-read.
const blocks = new Set(['p', 'ul', 'ol', 'li']);
const inline = new Set(['a', 'strong', 'em', 'code']);
const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name.startsWith('#')) {
      const hex = name[1] === 'x' || name[1] === 'X';
      return String.fromCodePoint(Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10));
    }
    const value = named[name];
    if (value === undefined) throw new Error(`unknown entity ${whole}`);
    return value;
  });
}

const tag = /<(\/?)([a-z][a-z0-9]*)\b[^>]*>/gi;

function words(html: string): string {
  return decodeEntities(html).replace(/\s+/g, ' ').trim();
}

// A heading's inner HTML as the text a reader sees.
export function inlineText(html: string): string {
  for (const [, , name] of html.matchAll(tag)) {
    if (!inline.has(name!.toLowerCase())) throw new Error(`<${name}> in inline text`);
  }
  return words(html.replace(tag, ''));
}

export function blockText(html: string): string {
  const out: string[] = [];
  let list: string[] | null = null;
  let buffer: string | null = null;
  let index = 0;
  for (const match of html.matchAll(tag)) {
    const between = html.slice(index, match.index);
    index = match.index + match[0].length;
    if (buffer !== null) buffer += between;
    else if (between.trim() !== '') throw new Error(`text outside a block: ${between.trim().slice(0, 40)}`);
    const closing = match[1] === '/';
    const name = match[2]!.toLowerCase();
    if (inline.has(name)) {
      if (buffer === null) throw new Error(`<${name}> outside a block`);
      continue;
    }
    if (!blocks.has(name)) throw new Error(`<${name}> is not an element the page text knows`);
    if (name === 'ul' || name === 'ol') {
      if (closing) {
        if (!list) throw new Error(`</${name}> without its list`);
        out.push(list.join('\n'));
        list = null;
      } else {
        if (list || buffer !== null) throw new Error('a list inside a list or a paragraph');
        list = [];
      }
    } else if (name === 'li') {
      if (!list) throw new Error('<li> outside a list');
      if (closing) {
        list.push(`- ${words(buffer ?? '')}`);
        buffer = null;
      } else {
        buffer = '';
      }
    } else if (list) {
      // A loose list wraps each item's text in a paragraph; the item keeps the text.
      if (buffer === null) throw new Error('<p> in a list but outside an item');
      buffer += ' ';
    } else if (closing) {
      if (buffer === null) throw new Error('</p> without its paragraph');
      const value = words(buffer);
      if (value !== '') out.push(value);
      buffer = null;
    } else {
      buffer = '';
    }
  }
  const rest = html.slice(index);
  if (buffer !== null || list) throw new Error('an element is left open');
  if (rest.trim() !== '') throw new Error(`text outside a block: ${rest.trim().slice(0, 40)}`);
  return out.join('\n\n');
}
