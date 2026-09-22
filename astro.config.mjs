// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import { satteri } from '@astrojs/markdown-satteri';
import { stripComments } from './src/lib/strip-comments.ts';

// Vercel sets VERCEL_PROJECT_PRODUCTION_URL to the .vercel.app host until the custom domain connects, then to the domain.
const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;

export default defineConfig({
  site: productionHost ? `https://${productionHost}` : 'https://alexkachur.com',
  output: 'static',
  trailingSlash: 'never',
  adapter: vercel({ maxDuration: 30 }),
  build: { inlineStylesheets: 'never' },
  // Rendered markdown keeps the characters of the source (no curly quotes, no dashes made from --)
  // and loses its HTML comments, the TODO checklist.
  markdown: { processor: satteri({ features: { smartPunctuation: false }, hastPlugins: [stripComments] }) },
  vite: { build: { assetsInlineLimit: 0 } },
  redirects: { '/resume': '/Alex-Kachur-Resume.pdf' },
});
