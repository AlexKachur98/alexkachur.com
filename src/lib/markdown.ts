// How Markdown is rendered, for the pages and the database alike. It keeps the source's characters
// (no curly quotes, no dashes made from --) and drops HTML comments.
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
