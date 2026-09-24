// How markdown is rendered, for the site and for the database alike, so the text a page shows and
// the text its table holds come from one renderer. Rendered markdown keeps the characters of the
// source (no curly quotes, no dashes made from --) and loses its HTML comments, the TODO checklist.
import { satteri } from '@astrojs/markdown-satteri';
import type { AstroUserConfig } from 'astro';
import { stripComments } from './strip-comments.ts';

export const markdown = {
  processor: satteri({ features: { smartPunctuation: false }, hastPlugins: [stripComments] }),
  syntaxHighlight: { type: 'shiki', excludeLangs: ['math'] },
} satisfies NonNullable<AstroUserConfig['markdown']>;

// A body as Astro renders a content entry: the text after the frontmatter, trimmed, through the
// same renderer with the same highlighting settings.
export async function renderBody(source: string): Promise<string> {
  const body = source.replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '').trim();
  const renderer = await markdown.processor.createRenderer({ syntaxHighlight: markdown.syntaxHighlight, image: {} });
  return (await renderer.render(body, { frontmatter: {} })).code;
}
