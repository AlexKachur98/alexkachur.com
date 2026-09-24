// @ts-check
import { defineConfig } from 'astro/config';
import vercel from '@astrojs/vercel';
import { markdown } from './src/lib/markdown.ts';

// Vercel sets VERCEL_PROJECT_PRODUCTION_URL to the .vercel.app host until the custom domain connects, then to the domain.
const productionHost = process.env.VERCEL_PROJECT_PRODUCTION_URL;

export default defineConfig({
  site: productionHost ? `https://${productionHost}` : 'https://alexkachur.com',
  output: 'static',
  trailingSlash: 'never',
  adapter: vercel({ maxDuration: 30 }),
  build: { inlineStylesheets: 'never' },
  markdown,
  vite: { build: { assetsInlineLimit: 0 } },
  redirects: { '/resume': '/Alex-Kachur-Resume.pdf' },
});
