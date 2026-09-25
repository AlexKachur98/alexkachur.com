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
  // The Portfolio site's case study is its write-up, so its old address goes there for good.
  redirects: { '/resume': '/Alex-Kachur-Resume.pdf', '/work/this-site': '/how-this-site-works' },
});
