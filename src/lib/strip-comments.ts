// The rehype step of SPEC 5.1 in two halves. Markdown: HTML comments (the TODO-ALEX checklist)
// reach the hast tree as raw nodes and are dropped there. Page output: the compiler strips the
// comments in slot children but keeps those written in a component's own template, so the
// middleware runs stripHtmlComments over every HTML response. The dist test checks both.
import type { SatteriProcessorOptions } from '@astrojs/markdown-satteri';

type HastPlugin = Extract<NonNullable<SatteriProcessorOptions['hastPlugins']>[number], { name: string }>;

const comment = /<!--[\s\S]*?-->/g;

export function stripHtmlComments(html: string): string {
  return html.replace(comment, '');
}

export const stripComments: HastPlugin = {
  name: 'strip-comments',
  comment(node, ctx) {
    ctx.removeNode(node);
  },
  raw(node, ctx) {
    const value = stripHtmlComments(node.value);
    if (value === node.value) return;
    if (value.trim() === '') ctx.removeNode(node);
    else ctx.replaceNode(node, { type: 'raw', value });
  },
};
