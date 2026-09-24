// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import { markdown } from './src/lib/markdown.ts';
import { siteOrigin } from './src/lib/site.ts';

export default defineConfig({
  site: siteOrigin(),
  output: 'static',
  trailingSlash: 'never',
  adapter: vercel({ maxDuration: 30 }),
  build: { inlineStylesheets: 'never' },
  markdown,
  vite: { build: { assetsInlineLimit: 0 } },
  redirects: { '/resume': '/Alex-Kachur-Resume.pdf' },
});
